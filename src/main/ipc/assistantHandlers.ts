import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, AssistantResponse, ChatMessage, OllamaHealth } from '../../shared/types'
import { executeActionPlan } from '../assistant/actionPlanExecutor'
import { planAssistantRequest } from '../assistant/actionPlanner'
import { executeDeterministicAction } from '../assistant/deterministicActionExecutor'
import {
  createCapabilityRegistry,
  createCapabilityRuntime
} from '../capabilities/capabilityRuntime'
import { checkConnection } from '../services/ollamaService'

const DEFAULT_MODEL = 'qwen3:8b'
const MAX_RETAINED_MESSAGES = 20
const MAX_MESSAGE_LENGTH = 4_000

const conversations = new Map<number, ChatMessage[]>()
const activeRequests = new Map<number, AbortController>()
const capabilityRegistry = createCapabilityRegistry()
const capabilityRuntime = createCapabilityRuntime({}, capabilityRegistry)

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

function healthResult(health: OllamaHealth): ActionResult<OllamaHealth> {
  if (!health.connected) {
    return {
      ok: false,
      code: 'OLLAMA_UNAVAILABLE',
      message: 'T.I.T.A.N. could not connect to Ollama. Start Ollama and try again.',
      recoverable: true
    }
  }

  if (!health.modelInstalled) {
    return {
      ok: false,
      code: 'OLLAMA_MODEL_MISSING',
      message: `The ${DEFAULT_MODEL} model is not installed. Run: ollama pull ${DEFAULT_MODEL}`,
      recoverable: true
    }
  }

  return {
    ok: true,
    message: `Ollama is running and ${DEFAULT_MODEL} is installed.`,
    data: health
  }
}

export function registerAssistantHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.ollamaHealth, async (): Promise<ActionResult<OllamaHealth>> => {
    return healthResult(await checkConnection())
  })

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

      if (activeRequests.has(senderId)) {
        return {
          ok: false,
          code: 'REQUEST_IN_PROGRESS',
          message: 'T.I.T.A.N. is already responding to a message.',
          recoverable: true
        }
      }

      const actionResult = await executeDeterministicAction(message)
      if (actionResult) return actionResult

      const controller = new AbortController()
      activeRequests.set(senderId, controller)

      try {
        const health = healthResult(await checkConnection(controller.signal))

        if (!health.ok) {
          return health
        }

        const recentMessages = conversations.get(senderId) ?? []
        const userMessage: ChatMessage = { role: 'user', content: message }
        const planned = await planAssistantRequest(
          [...recentMessages, userMessage],
          capabilityRegistry,
          controller.signal
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
                message: 'T.I.T.A.N. responded.',
                data: { response: output.response }
              }
            : await executeActionPlan(output, capabilityRuntime)

        if (result.ok && result.data?.response) {
          conversations.set(
            senderId,
            [
              ...recentMessages,
              userMessage,
              { role: 'assistant', content: result.data.response } satisfies ChatMessage
            ].slice(-MAX_RETAINED_MESSAGES)
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

  ipcMain.handle(IPC_CHANNELS.assistantCancel, (event: IpcMainInvokeEvent): ActionResult => {
    const controller = activeRequests.get(event.sender.id)

    if (!controller) {
      return {
        ok: true,
        message: 'There is no active request to cancel.'
      }
    }

    controller.abort()
    activeRequests.delete(event.sender.id)
    return {
      ok: true,
      message: 'The request was cancelled.'
    }
  })

  ipcMain.handle(IPC_CHANNELS.assistantClear, (event: IpcMainInvokeEvent): ActionResult => {
    activeRequests.get(event.sender.id)?.abort()
    activeRequests.delete(event.sender.id)
    conversations.delete(event.sender.id)

    return {
      ok: true,
      message: 'Conversation cleared.'
    }
  })
}
