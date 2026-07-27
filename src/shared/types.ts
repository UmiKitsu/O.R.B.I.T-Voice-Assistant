export type OrbitStatus =
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
  detectedLanguage?: string
}

export type RecognitionLanguage = 'auto' | 'en'
export type WakeRecognitionMode = 'hybrid' | 'keyword-only'
export type WakeDetectionMethod = 'keyword' | 'whisper-fallback'
export type WakeSignalQuality = 'none' | 'low' | 'good'

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

export type VoiceRoutePreview =
  | {
      kind: 'deterministic'
      summary: string
      capability: string
      parameters: Record<string, unknown>
    }
  | {
      kind: 'ai-required'
      summary: string
    }

export type VoiceDiagnostics = {
  durationMs: number
  transcriptionLatencyMs: number
  peakLevel: number
  rmsLevel: number
  detectedLanguage?: string
  route: VoiceRoutePreview
}

export type MicrophoneTestResult = {
  transcript: VoiceTranscript
  diagnostics: VoiceDiagnostics
}

export type WakeWordTestResult = {
  detected: boolean
  method?: WakeDetectionMethod
  latencyMs?: number
  captureDurationMs: number
  audioChunkCount: number
  peakLevel: number
  rmsLevel: number
  signalQuality: WakeSignalQuality
  heardText?: string
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
      diagnostics: VoiceDiagnostics
    }
  | {
      type: 'error'
      code: string
      message: string
      fatal: boolean
    }
  | {
      type: 'test-result'
      result: WakeWordTestResult
    }

export type OrbitSettings = {
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
  recognitionLanguage: RecognitionLanguage
  wakeRecognitionMode: WakeRecognitionMode
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
