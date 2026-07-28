export type OrbitStatus =
  | 'disabled'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'preparing-ai'
  | 'thinking'
  | 'synthesizing'
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
  configuredModel: string
  activeModel?: string
  fallbackActive: boolean
  warm: boolean
  processor?: 'gpu' | 'cpu' | 'mixed' | 'unknown'
  timing?: OllamaTiming
}

export type OllamaTiming = {
  loadMs: number
  promptMs: number
  generationMs: number
  totalMs: number
}

export type AssistantProgressPhase = 'checking' | 'loading' | 'generating' | 'validating'

export type AssistantProgress = {
  phase: AssistantProgressPhase
  message: string
  elapsedMs: number
  model?: string
}

export type TranscriptionBackend =
  | 'vulkan-small'
  | 'vulkan-turbo'
  | 'cpu-turbo'
  | 'cpu-small'

export type Transcription = {
  text: string
  detectedLanguage?: string
  backend: TranscriptionBackend
  model: 'large-v3-turbo-q5_0' | 'small'
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
  transcriptionBackend: TranscriptionBackend
  transcriptionModel: 'large-v3-turbo-q5_0' | 'small'
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

export type SpeechEngine = 'kokoro'
export type KokoroVoice =
  'bm_george' | 'bm_lewis' | 'bm_daniel' | 'am_adam' | 'am_michael' | 'bf_emma' | 'af_heart'

export type SpeechSynthesisEvent =
  | {
      type: 'started'
      requestId: string
      engine: 'kokoro'
    }
  | {
      type: 'audio'
      requestId: string
      chunkIndex: number
      sampleRate: number
      samples: Float32Array
      final: boolean
    }
  | {
      type: 'cancelled'
      requestId: string
    }
  | {
      type: 'error'
      requestId: string
      code: string
      message: string
    }

export type MusicProvider = 'spotify' | 'youtube'
export type SpotifyPlaybackMode = 'desktop' | 'web-api'

export type OrbitSettings = {
  ollamaBaseUrl: string
  ollamaModel: string
  thinkMode: boolean
  speechEngine: SpeechEngine
  kokoroVoice: KokoroVoice
  speechRate: number
  speechVolume: number
  launchAtStartup: boolean
  minimizeToTray: boolean
  saveConversationHistory: boolean
  confirmationTimeoutSeconds: number
  applicationAliases: Record<string, string[]>
  recognitionLanguage: RecognitionLanguage
  wakeRecognitionMode: WakeRecognitionMode
  spotifyClientId: string
  spotifyPlaybackMode: SpotifyPlaybackMode
  preferredMusicProvider: MusicProvider
  musicFallbackEnabled: boolean
}

export type AssistantEffect = 'stop-speaking' | 'disable'
export type ActionAuthorization = 'confirmation' | 'pin'

export type SecurityPinStatus = {
  hasPin: boolean
  temporarilyLocked: boolean
  retryAt?: number
}

export type SpotifyConnectionStatus = {
  configured: boolean
  connected: boolean
  redirectUri: string
  displayName?: string
  product?: string
}

export type ConfirmationPrompt = {
  requestId: string
  summary: string
  expiresAt: number
  authorization: ActionAuthorization
  pinConfigured: boolean
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
