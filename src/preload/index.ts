import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcChannels'
import type {
  ActionResult,
  AssistantProgress,
  AssistantResponse,
  BrowserConnectionStatus,
  BrowserForgetPairingResult,
  BrowserPairingSession,
  MicrophoneTestResult,
  OllamaHealth,
  OrbitSettings,
  SecurityPinStatus,
  SpotifyConnectionStatus,
  SpeechSynthesisEvent,
  VoiceDiagnostics,
  WakeWordEvent
} from '../shared/types'

const WAKE_WORD_STATES = new Set([
  'off',
  'starting',
  'armed',
  'detected',
  'capturing',
  'transcribing',
  'paused',
  'error'
])

function isVoiceCorrection(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const correction = value as Record<string, unknown>
  return (
    Object.keys(correction).length === 3 &&
    typeof correction.from === 'string' &&
    typeof correction.to === 'string' &&
    (correction.kind === 'wake-word' ||
      correction.kind === 'command' ||
      correction.kind === 'application')
  )
}

function isVoiceTranscript(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const transcript = value as Record<string, unknown>
  return (
    Object.keys(transcript).length === 3 &&
    typeof transcript.rawText === 'string' &&
    transcript.rawText.length <= 4_000 &&
    typeof transcript.normalizedText === 'string' &&
    transcript.normalizedText.length <= 4_000 &&
    Array.isArray(transcript.corrections) &&
    transcript.corrections.length <= 20 &&
    transcript.corrections.every(isVoiceCorrection)
  )
}

function isVoiceDiagnostics(value: unknown): value is VoiceDiagnostics {
  if (typeof value !== 'object' || value === null) return false
  const diagnostics = value as Record<string, unknown>
  const route = diagnostics.route
  if (typeof route !== 'object' || route === null) return false
  const routeRecord = route as Record<string, unknown>
  const validRoute =
    (routeRecord.kind === 'ai-required' && typeof routeRecord.summary === 'string') ||
    (routeRecord.kind === 'deterministic' &&
      typeof routeRecord.summary === 'string' &&
      typeof routeRecord.capability === 'string' &&
      typeof routeRecord.parameters === 'object' &&
      routeRecord.parameters !== null)
  return (
    validRoute &&
    typeof diagnostics.durationMs === 'number' &&
    diagnostics.durationMs >= 0 &&
    typeof diagnostics.transcriptionLatencyMs === 'number' &&
    diagnostics.transcriptionLatencyMs >= 0 &&
    typeof diagnostics.peakLevel === 'number' &&
    diagnostics.peakLevel >= 0 &&
    diagnostics.peakLevel <= 1 &&
    typeof diagnostics.rmsLevel === 'number' &&
    diagnostics.rmsLevel >= 0 &&
    diagnostics.rmsLevel <= 1 &&
    (diagnostics.transcriptionBackend === 'vulkan-small' ||
      diagnostics.transcriptionBackend === 'vulkan-turbo' ||
      diagnostics.transcriptionBackend === 'cpu-turbo' ||
      diagnostics.transcriptionBackend === 'cpu-small') &&
    (diagnostics.transcriptionModel === 'large-v3-turbo-q5_0' ||
      diagnostics.transcriptionModel === 'small') &&
    (diagnostics.detectedLanguage === undefined || typeof diagnostics.detectedLanguage === 'string')
  )
}

function isWakeWordEvent(value: unknown): value is WakeWordEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const event = value as Record<string, unknown>
  if (event.type === 'state') {
    return (
      Object.keys(event).length === 3 &&
      typeof event.state === 'string' &&
      WAKE_WORD_STATES.has(event.state) &&
      typeof event.message === 'string'
    )
  }
  if (event.type === 'transcription') {
    return (
      Object.keys(event).length === 3 &&
      isVoiceTranscript(event.transcript) &&
      isVoiceDiagnostics(event.diagnostics)
    )
  }
  if (event.type === 'test-result') {
    if (
      Object.keys(event).length !== 2 ||
      typeof event.result !== 'object' ||
      event.result === null
    ) {
      return false
    }
    const result = event.result as Record<string, unknown>
    const allowedKeys = new Set([
      'detected',
      'method',
      'latencyMs',
      'captureDurationMs',
      'audioChunkCount',
      'peakLevel',
      'rmsLevel',
      'signalQuality',
      'heardText'
    ])
    if (Object.keys(result).some((key) => !allowedKeys.has(key))) return false
    return (
      typeof result.detected === 'boolean' &&
      (result.method === undefined ||
        result.method === 'keyword' ||
        result.method === 'whisper-fallback') &&
      (result.latencyMs === undefined ||
        (typeof result.latencyMs === 'number' &&
          Number.isFinite(result.latencyMs) &&
          result.latencyMs >= 0 &&
          result.latencyMs <= 15_000)) &&
      typeof result.captureDurationMs === 'number' &&
      Number.isFinite(result.captureDurationMs) &&
      result.captureDurationMs >= 0 &&
      result.captureDurationMs <= 12_000 &&
      typeof result.audioChunkCount === 'number' &&
      Number.isInteger(result.audioChunkCount) &&
      result.audioChunkCount >= 0 &&
      result.audioChunkCount <= 200 &&
      typeof result.peakLevel === 'number' &&
      Number.isFinite(result.peakLevel) &&
      result.peakLevel >= 0 &&
      result.peakLevel <= 1 &&
      typeof result.rmsLevel === 'number' &&
      Number.isFinite(result.rmsLevel) &&
      result.rmsLevel >= 0 &&
      result.rmsLevel <= 1 &&
      (result.signalQuality === 'none' ||
        result.signalQuality === 'low' ||
        result.signalQuality === 'good') &&
      (result.heardText === undefined ||
        (typeof result.heardText === 'string' && result.heardText.length <= 500))
    )
  }
  return (
    event.type === 'error' &&
    Object.keys(event).length === 4 &&
    typeof event.code === 'string' &&
    typeof event.message === 'string' &&
    typeof event.fatal === 'boolean'
  )
}

function isAssistantProgress(value: unknown): value is AssistantProgress {
  if (typeof value !== 'object' || value === null) return false
  const progress = value as Record<string, unknown>
  const allowedKeys = new Set(['phase', 'message', 'elapsedMs', 'model'])
  return (
    !Object.keys(progress).some((key) => !allowedKeys.has(key)) &&
    (progress.phase === 'checking' ||
      progress.phase === 'loading' ||
      progress.phase === 'generating' ||
      progress.phase === 'validating') &&
    typeof progress.message === 'string' &&
    progress.message.length <= 300 &&
    typeof progress.elapsedMs === 'number' &&
    Number.isFinite(progress.elapsedMs) &&
    progress.elapsedMs >= 0 &&
    progress.elapsedMs <= 120_000 &&
    (progress.model === undefined ||
      (typeof progress.model === 'string' && progress.model.length <= 200))
  )
}

function isSpeechSynthesisEvent(value: unknown): value is SpeechSynthesisEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const event = value as Record<string, unknown>
  if (typeof event.requestId !== 'string' || event.requestId.length > 100) return false
  if (event.type === 'started') return event.engine === 'kokoro'
  if (event.type === 'cancelled') return Object.keys(event).length === 2
  if (event.type === 'error') {
    return (
      typeof event.code === 'string' &&
      event.code.length <= 100 &&
      typeof event.message === 'string' &&
      event.message.length <= 500
    )
  }
  if (event.type !== 'audio') return false
  if (!(event.samples instanceof Float32Array) || event.samples.length > 720_000) return false
  for (const sample of event.samples)
    if (!Number.isFinite(sample) || Math.abs(sample) > 1.01) return false
  return (
    typeof event.chunkIndex === 'number' &&
    Number.isInteger(event.chunkIndex) &&
    event.chunkIndex >= 0 &&
    event.chunkIndex <= 100 &&
    typeof event.sampleRate === 'number' &&
    Number.isInteger(event.sampleRate) &&
    event.sampleRate >= 8_000 &&
    event.sampleRate <= 48_000 &&
    typeof event.final === 'boolean'
  )
}

const orbit = Object.freeze({
  checkOllama: (): Promise<ActionResult<OllamaHealth>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ollamaHealth),

  askAssistant: (message: string): Promise<ActionResult<AssistantResponse>> =>
    ipcRenderer.invoke(IPC_CHANNELS.assistantAsk, { message }),

  cancelAssistant: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.assistantCancel),
  onAssistantProgress: (listener: (progress: AssistantProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (isAssistantProgress(value)) listener(value)
    }
    ipcRenderer.on(IPC_CHANNELS.assistantProgress, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.assistantProgress, handler)
  },
  synthesizeSpeech: (text: string): Promise<ActionResult<{ requestId: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.speechSynthesize, { text }),
  cancelSpeech: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.speechCancel),
  onSpeechSynthesisEvent: (listener: (event: SpeechSynthesisEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (isSpeechSynthesisEvent(value)) listener(value)
    }
    ipcRenderer.on(IPC_CHANNELS.speechEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.speechEvent, handler)
  },

  getSettings: (): Promise<ActionResult<OrbitSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  updateSettings: (patch: Partial<OrbitSettings>): Promise<ActionResult<OrbitSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  getPinStatus: (): Promise<ActionResult<SecurityPinStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.securityPinStatus),
  createPin: (
    pin: string,
    confirmation: string
  ): Promise<ActionResult<SecurityPinStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.securityPinCreate, { pin, confirmation }),
  changePin: (
    currentPin: string,
    nextPin: string,
    confirmation: string
  ): Promise<ActionResult<SecurityPinStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.securityPinChange, { currentPin, nextPin, confirmation }),
  getSpotifyStatus: (): Promise<ActionResult<SpotifyConnectionStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.spotifyStatus),
  connectSpotify: (): Promise<ActionResult<SpotifyConnectionStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.spotifyConnect),
  disconnectSpotify: (): Promise<ActionResult<SpotifyConnectionStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.spotifyDisconnect),
  getBrowserStatus: (): Promise<ActionResult<BrowserConnectionStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.browserStatus),
  beginBrowserPairing: (): Promise<ActionResult<BrowserPairingSession>> =>
    ipcRenderer.invoke(IPC_CHANNELS.browserPairingBegin),
  retryBrowserConnection: (): Promise<ActionResult<BrowserConnectionStatus>> =>
    ipcRenderer.invoke(IPC_CHANNELS.browserRetry),
  disconnectBrowser: (): Promise<ActionResult<BrowserForgetPairingResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.browserDisconnect),
  getBrowserExtensionPath: (): Promise<ActionResult<{ path: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.browserExtensionPath),
  startWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordStart),
  stopWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordStop),
  pauseWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordPause),
  resumeWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordResume),
  startWakeWordTest: (): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.wakeWordTestStart),
  cancelWakeWordTest: (): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.wakeWordTestCancel),
  sendWakeWordAudio: (samples: Float32Array): void =>
    ipcRenderer.send(IPC_CHANNELS.wakeWordAudioChunk, { samples }),
  transcribeMicrophoneTest: (audio: Uint8Array): Promise<ActionResult<MicrophoneTestResult>> =>
    ipcRenderer.invoke(IPC_CHANNELS.microphoneTestTranscribe, { audio }),
  cancelMicrophoneTest: (): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.microphoneTestCancel),
  onWakeWordEvent: (listener: (event: WakeWordEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (isWakeWordEvent(value)) listener(value)
    }
    ipcRenderer.on(IPC_CHANNELS.wakeWordEvent, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.wakeWordEvent, handler)
  },
  confirmAction: (
    requestId: string,
    approved: boolean,
    pin?: string
  ): Promise<ActionResult<AssistantResponse>> =>
    ipcRenderer.invoke(IPC_CHANNELS.actionConfirm, {
      requestId,
      approved,
      ...(pin === undefined ? {} : { pin })
    })
})

contextBridge.exposeInMainWorld('orbit', orbit)
