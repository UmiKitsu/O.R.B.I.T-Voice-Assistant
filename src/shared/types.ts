export type TitanStatus =
  | 'disabled'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'awaiting-confirmation'
  | 'executing'
  | 'speaking'
  | 'error'

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type OllamaHealth = {
  connected: boolean
  modelInstalled: boolean
  models: string[]
}

export type AssistantEffect = 'stop-speaking' | 'disable'

export type AssistantResponse = {
  response: string
  effects?: AssistantEffect[]
}

export type ActionResult<T = undefined> =
  | {
      ok: true
      message: string
      data?: T
    }
  | {
      ok: false
      code: string
      message: string
      recoverable: boolean
    }
