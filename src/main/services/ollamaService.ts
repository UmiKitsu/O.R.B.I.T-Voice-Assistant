import type { ActionResult, ChatMessage, OllamaHealth, TitanSettings } from '../../shared/types'
import { getSettings } from './settingsService'

const REQUEST_TIMEOUT_MS = 30_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseTagsResponse(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return null
  }

  const models: string[] = []

  for (const model of value.models) {
    if (!isRecord(model) || typeof model.name !== 'string') {
      return null
    }

    models.push(model.name)
  }

  return models
}

function parseChatResponse(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.message)) {
    return null
  }

  if (value.message.role !== 'assistant' || typeof value.message.content !== 'string') {
    return null
  }

  const content = value.message.content.trim()
  return content.length > 0 ? content : null
}

function createTimedSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal
  didTimeout: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let timedOut = false

  const abortFromExternalSignal = (): void => {
    controller.abort(externalSignal?.reason)
  }

  if (externalSignal?.aborted) {
    abortFromExternalSignal()
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })
  }

  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('The Ollama request timed out.'))
  }, timeoutMs)

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abortFromExternalSignal)
    }
  }
}

async function fetchModels(baseUrl: string, signal?: AbortSignal): Promise<string[]> {
  const timedSignal = createTimedSignal(signal, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: timedSignal.signal
    })

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status}.`)
    }

    const parsed: unknown = await response.json()
    const models = parseTagsResponse(parsed)

    if (!models) {
      throw new Error('Ollama returned an invalid model list.')
    }

    return models
  } finally {
    timedSignal.dispose()
  }
}

export async function checkConnection(signal?: AbortSignal): Promise<OllamaHealth> {
  const settings = getSettings()
  return checkModelInstalled(settings.ollamaModel, signal, settings.ollamaBaseUrl)
}

export async function checkModelInstalled(
  model: string,
  signal?: AbortSignal,
  baseUrl = getSettings().ollamaBaseUrl
): Promise<OllamaHealth> {
  try {
    const models = await fetchModels(baseUrl, signal)

    return {
      connected: true,
      modelInstalled: models.includes(model),
      models
    }
  } catch {
    return {
      connected: false,
      modelInstalled: false,
      models: []
    }
  }
}

export async function chat(
  messages: ChatMessage[],
  signal?: AbortSignal
): Promise<ActionResult<{ response: string }>> {
  return sendChatRequest(messages, undefined, signal)
}

export async function structuredChat(
  messages: ChatMessage[],
  format: Record<string, unknown>,
  signal?: AbortSignal
): Promise<ActionResult<{ response: string }>> {
  return sendChatRequest(messages, format, signal)
}

async function sendChatRequest(
  messages: ChatMessage[],
  format: Record<string, unknown> | undefined,
  signal?: AbortSignal
): Promise<ActionResult<{ response: string }>> {
  const timedSignal = createTimedSignal(signal, REQUEST_TIMEOUT_MS)
  const settings: TitanSettings = getSettings()

  try {
    const response = await fetch(`${settings.ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: settings.ollamaModel,
        messages,
        think: settings.thinkMode,
        stream: false,
        ...(format ? { format } : {})
      }),
      signal: timedSignal.signal
    })

    if (!response.ok) {
      return {
        ok: false,
        code: 'OLLAMA_CHAT_FAILED',
        message: `Ollama could not complete the request (HTTP ${response.status}).`,
        recoverable: true
      }
    }

    let parsed: unknown

    try {
      parsed = await response.json()
    } catch {
      return {
        ok: false,
        code: 'OLLAMA_INVALID_RESPONSE',
        message: 'Ollama returned an invalid response.',
        recoverable: true
      }
    }

    const content = parseChatResponse(parsed)

    if (!content) {
      return {
        ok: false,
        code: 'OLLAMA_INVALID_RESPONSE',
        message: 'Ollama returned an invalid response.',
        recoverable: true
      }
    }

    return {
      ok: true,
      message: 'T.I.T.A.N. responded.',
      data: {
        response: content
      }
    }
  } catch (error: unknown) {
    if (timedSignal.didTimeout()) {
      return {
        ok: false,
        code: 'OLLAMA_TIMEOUT',
        message: 'Ollama took too long to respond.',
        recoverable: true
      }
    }

    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      return {
        ok: false,
        code: 'OLLAMA_CANCELLED',
        message: 'The request was cancelled.',
        recoverable: true
      }
    }

    return {
      ok: false,
      code: 'OLLAMA_NETWORK_ERROR',
      message: 'T.I.T.A.N. could not connect to Ollama. Start Ollama and try again.',
      recoverable: true
    }
  } finally {
    timedSignal.dispose()
  }
}
