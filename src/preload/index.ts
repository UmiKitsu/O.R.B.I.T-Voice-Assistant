import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcChannels'
import type {
  ActionResult,
  AssistantResponse,
  MicrophoneTestResult,
  OllamaHealth,
  OrbitSettings,
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

const orbit = Object.freeze({
  checkOllama: (): Promise<ActionResult<OllamaHealth>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ollamaHealth),

  askAssistant: (message: string): Promise<ActionResult<AssistantResponse>> =>
    ipcRenderer.invoke(IPC_CHANNELS.assistantAsk, { message }),

  cancelAssistant: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.assistantCancel),

  getSettings: (): Promise<ActionResult<OrbitSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  updateSettings: (patch: Partial<OrbitSettings>): Promise<ActionResult<OrbitSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
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
  confirmAction: (requestId: string, approved: boolean): Promise<ActionResult<AssistantResponse>> =>
    ipcRenderer.invoke(IPC_CHANNELS.actionConfirm, {
      requestId,
      approved
    })
})

contextBridge.exposeInMainWorld('orbit', orbit)
