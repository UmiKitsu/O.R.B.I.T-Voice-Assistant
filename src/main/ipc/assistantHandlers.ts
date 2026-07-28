import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type {
  ActionResult,
  AssistantProgress,
  AssistantResponse,
  OllamaHealth
} from '../../shared/types'
import { BrowserTaskFlow } from '../assistant/browserTaskFlow'
import { ConfirmationFlow, parseConfirmationResponse } from '../assistant/confirmationFlow'
import { planAssistantRequest } from '../assistant/actionPlanner'
import { executeActionPlan } from '../assistant/actionPlanExecutor'
import {
  createAssistantSession,
  createSessionContextMessage,
  recordSuccessfulExchange,
  type AssistantSession
} from '../assistant/assistantSession'
import {
  extractAmbiguousMediaQuery,
  isClarificationCancellation,
  isConversationResetCommand,
  routeCommand,
  routeMediaDestinationResponse
} from '../assistant/commandRouter'
import {
  createCapabilityRegistry,
  createCapabilityRuntime
} from '../capabilities/capabilityRuntime'
import { checkConnection } from '../services/ollamaService'
import { prepareOllama } from '../services/ollamaStartupService'
import { logOperationalEvent } from '../services/loggerService'
import { getLastYouTubePlaybackState } from '../services/browserBridgeService'
import { getSettings } from '../services/settingsService'

const MAX_MESSAGE_LENGTH = 4_000

const sessions = new Map<number, AssistantSession>()
const activeRequests = new Map<number, AbortController>()
const capabilityRegistry = createCapabilityRegistry()
const capabilityRuntime = createCapabilityRuntime({}, capabilityRegistry)
const confirmationFlow = new ConfirmationFlow(capabilityRuntime)
const browserTaskFlow = new BrowserTaskFlow(capabilityRegistry, capabilityRuntime)

function parseAssistantRequest(value: unknown): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('message' in value) ||
    Object.keys(value).length !== 1
  ) {
    return null
  }

  const message = (value as { message?: unknown }).message

  if (typeof message !== 'string') {
    return null
  }

  const trimmedMessage = message.trim()
  return trimmedMessage.length > 0 && trimmedMessage.length <= MAX_MESSAGE_LENGTH
    ? trimmedMessage
    : null
}

function getOrCreateSession(event: IpcMainInvokeEvent): AssistantSession {
  const senderId = event.sender.id
  const existing = sessions.get(senderId)
  if (existing) return existing

  const session = createAssistantSession()
  sessions.set(senderId, session)
  event.sender.once('destroyed', () => {
    activeRequests.get(senderId)?.abort()
    activeRequests.delete(senderId)
    confirmationFlow.cancelSender(senderId)
    browserTaskFlow.cancelSender(senderId)
    sessions.delete(senderId)
  })
  return session
}

function emitAssistantProgress(event: IpcMainInvokeEvent, progress: AssistantProgress): void {
  if (!event.sender.isDestroyed()) event.sender.send(IPC_CHANNELS.assistantProgress, progress)
}

function healthResult(health: OllamaHealth): ActionResult<OllamaHealth> {
  const model = getSettings().ollamaModel
  if (!health.connected) {
    return {
      ok: false,
      code: 'OLLAMA_UNAVAILABLE',
      message: 'Orbit could not connect to Ollama. Start Ollama and try again.',
      recoverable: true
    }
  }

  logOperationalEvent({ event: 'ollama.connected' })

  if (!health.modelInstalled) {
    return {
      ok: false,
      code: 'OLLAMA_MODEL_MISSING',
      message: `The ${model} model is not installed. Run: ollama pull ${model}`,
      recoverable: true
    }
  }

  return {
    ok: true,
    message: health.fallbackActive
      ? `Ollama is ready. ${health.activeModel} is active because ${model} is unavailable or unsuitable.`
      : `Ollama is ready and ${health.activeModel ?? model} is ${health.warm ? 'warmed' : 'installed'}.`,
    data: health
  }
}

export function registerAssistantHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.ollamaHealth,
    async (event: IpcMainInvokeEvent): Promise<ActionResult<OllamaHealth>> => {
      return healthResult(
        await prepareOllama((progress) => emitAssistantProgress(event, progress))
      )
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.assistantAsk,
    async (
      event: IpcMainInvokeEvent,
      request: unknown
    ): Promise<ActionResult<AssistantResponse>> => {
      const message = parseAssistantRequest(request)

      if (!message) {
        return {
          ok: false,
          code: 'INVALID_MESSAGE',
          message: 'Enter a message between 1 and 4,000 characters.',
          recoverable: true
        }
      }

      const senderId = event.sender.id

      if (isConversationResetCommand(message)) {
        confirmationFlow.cancelSender(senderId)
        browserTaskFlow.cancelSender(senderId)
        activeRequests.get(senderId)?.abort()
        activeRequests.delete(senderId)
        sessions.delete(senderId)
        const response = 'Conversation cleared.'
        return {
          ok: true,
          message: response,
          data: { response }
        }
      }

      if (activeRequests.has(senderId)) {
        return {
          ok: false,
          code: 'REQUEST_IN_PROGRESS',
          message: 'Orbit is already responding to a message.',
          recoverable: true
        }
      }

      const session = getOrCreateSession(event)

      if (session.pendingMediaDestination) {
        const { query } = session.pendingMediaDestination

        if (isClarificationCancellation(message)) {
          session.pendingMediaDestination = undefined
          const response = 'The playback request was cancelled.'
          recordSuccessfulExchange(session, message, response)
          return {
            ok: true,
            message: 'Playback request cancelled.',
            data: { response }
          }
        }

        const destinationPlan = routeMediaDestinationResponse(message, query)
        if (destinationPlan) {
          const actionResult = await executeActionPlan(destinationPlan, capabilityRuntime)
          if (actionResult.ok && actionResult.data?.response) {
            session.pendingMediaDestination = undefined
            recordSuccessfulExchange(
              session,
              message,
              actionResult.data.response,
              destinationPlan,
              getLastYouTubePlaybackState()
            )
          }
          return actionResult
        }

        const response = `Would you like me to open ${query} in Spotify or your browser?`
        recordSuccessfulExchange(session, message, response)
        return {
          ok: true,
          message: 'Orbit needs a playback destination.',
          data: { response }
        }
      }

      const deterministicPlan = routeCommand(message, session.context)
      if (deterministicPlan) {
        const actionResult = await executeActionPlan(deterministicPlan, capabilityRuntime)
        if (actionResult.ok && actionResult.data?.response) {
          recordSuccessfulExchange(
            session,
            message,
            actionResult.data.response,
            deterministicPlan,
            getLastYouTubePlaybackState()
          )
        }
        return actionResult
      }

      const ambiguousMediaQuery = extractAmbiguousMediaQuery(message, session.context)
      if (ambiguousMediaQuery) {
        session.pendingMediaDestination = { query: ambiguousMediaQuery }
        const response = `Would you like me to open ${ambiguousMediaQuery} in Spotify or your browser?`
        recordSuccessfulExchange(session, message, response)
        return {
          ok: true,
          message: 'Orbit needs a playback destination.',
          data: { response }
        }
      }

      const controller = new AbortController()
      activeRequests.set(senderId, controller)

      try {
        emitAssistantProgress(event, {
          phase: 'checking',
          message: 'Checking the local AI service.',
          elapsedMs: 0
        })
        const health = healthResult(await checkConnection(controller.signal))

        if (!health.ok) {
          return health
        }

        const contextMessage = createSessionContextMessage(session.context)
        const planningMessages = [
          ...(contextMessage ? [contextMessage] : []),
          ...session.messages,
          { role: 'user' as const, content: message }
        ]
        const planned = await planAssistantRequest(
          planningMessages,
          capabilityRegistry,
          controller.signal,
          (progress) => emitAssistantProgress(event, progress)
        )

        if (!planned.ok) return planned

        const output = planned.data
        if (!output) {
          return {
            ok: false,
            code: 'OLLAMA_INVALID_RESPONSE',
            message: 'Ollama returned an invalid response.',
            recoverable: true
          }
        }

        const result =
          output.kind === 'conversation'
            ? {
                ok: true as const,
                message: 'Orbit responded.',
                data: { response: output.response }
              }
            : output.kind === 'browser_task'
              ? await browserTaskFlow.start(message, senderId, controller.signal)
              : await confirmationFlow.execute(output, senderId)

        if (result.ok && result.data?.response) {
          recordSuccessfulExchange(
            session,
            message,
            result.data.response,
            output.kind === 'action_plan' ? output : undefined,
            getLastYouTubePlaybackState()
          )
        }

        return result
      } finally {
        if (activeRequests.get(senderId) === controller) {
          activeRequests.delete(senderId)
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.actionConfirm,
    async (
      event: IpcMainInvokeEvent,
      request: unknown
    ): Promise<ActionResult<AssistantResponse>> => {
      const response = parseConfirmationResponse(request)
      if (!response) {
        return {
          ok: false,
          code: 'INVALID_CONFIRMATION',
          message: 'The confirmation response is invalid.',
          recoverable: true
        }
      }

      if (browserTaskFlow.hasPending(event.sender.id, response.requestId)) {
        return browserTaskFlow.respond(event.sender.id, response.requestId, response.approved)
      }

      return confirmationFlow.respond(
        event.sender.id,
        response.requestId,
        response.approved,
        response.pin
      )
    }
  )

  ipcMain.handle(IPC_CHANNELS.assistantCancel, (event: IpcMainInvokeEvent): ActionResult => {
    confirmationFlow.cancelSender(event.sender.id)
    browserTaskFlow.cancelSender(event.sender.id)
    const session = sessions.get(event.sender.id)
    const hadPendingDestination = Boolean(session?.pendingMediaDestination)
    if (session) session.pendingMediaDestination = undefined

    const controller = activeRequests.get(event.sender.id)

    if (!controller) {
      return {
        ok: true,
        message: hadPendingDestination
          ? 'The playback request was cancelled.'
          : 'There is no active request to cancel.'
      }
    }

    controller.abort()
    activeRequests.delete(event.sender.id)
    return {
      ok: true,
      message: 'The request was cancelled.'
    }
  })
}
