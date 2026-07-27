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

export type AssistantSessionContext = {
  lastApplication?: string
  lastMediaApplication?: string
  lastSuccessfulCapability?: string
}

export type OllamaHealth = {
  connected: boolean
  modelInstalled: boolean
  models: string[]
}

export type Transcription = {
  text: string
}

export type VoiceCorrection = {
  from: string
  to: string
  kind: 'wake-word' | 'command' | 'application'
}

export type VoiceTranscript = {
  rawText: string
  normalizedText: string
  corrections: VoiceCorrection[]
}

export type WakeWordState =
  'off' | 'starting' | 'armed' | 'detected' | 'capturing' | 'transcribing' | 'paused' | 'error'

export type WakeWordEvent =
  | {
      type: 'state'
      state: WakeWordState
      message: string
    }
  | {
      type: 'transcription'
      transcript: VoiceTranscript
    }
  | {
      type: 'error'
      code: string
      message: string
      fatal: boolean
    }

export type TitanSettings = {
  ollamaBaseUrl: string
  ollamaModel: string
  thinkMode: boolean
  speechRate: number
  speechVolume: number
  launchAtStartup: boolean
  minimizeToTray: boolean
  saveConversationHistory: boolean
  confirmationTimeoutSeconds: number
  applicationAliases: Record<string, string[]>
}

export type AssistantEffect = 'stop-speaking' | 'disable'
export type ConfirmationPrompt = {
  requestId: string
  summary: string
  expiresAt: number
}

export type AssistantResponse = {
  response: string
  effects?: AssistantEffect[]
  confirmation?: ConfirmationPrompt
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
