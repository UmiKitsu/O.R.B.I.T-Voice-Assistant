import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcChannels'
import type {
  ActionResult,
  AssistantResponse,
  OllamaHealth,
  TitanSettings,
  Transcription,
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
    return Object.keys(event).length === 2 && typeof event.text === 'string'
  }
  return (
    event.type === 'error' &&
    Object.keys(event).length === 4 &&
    typeof event.code === 'string' &&
    typeof event.message === 'string' &&
    typeof event.fatal === 'boolean'
  )
}
const titan = Object.freeze({
  checkOllama: (): Promise<ActionResult<OllamaHealth>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ollamaHealth),

  askAssistant: (message: string): Promise<ActionResult<AssistantResponse>> =>
    ipcRenderer.invoke(IPC_CHANNELS.assistantAsk, { message }),

  cancelAssistant: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.assistantCancel),

  clearConversation: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.assistantClear),
  getSettings: (): Promise<ActionResult<TitanSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
  updateSettings: (patch: Partial<TitanSettings>): Promise<ActionResult<TitanSettings>> =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, patch),
  recordingStarted: (): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.speechRecordingStarted),
  transcribeAudio: (audio: Uint8Array): Promise<ActionResult<Transcription>> =>
    ipcRenderer.invoke(IPC_CHANNELS.speechTranscribe, { audio }),

  cancelTranscription: (): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.speechCancelTranscription),

  startWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordStart),
  stopWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordStop),
  pauseWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordPause),
  resumeWakeWord: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.wakeWordResume),
  sendWakeWordAudio: (samples: Float32Array): void =>
    ipcRenderer.send(IPC_CHANNELS.wakeWordAudioChunk, { samples }),
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

contextBridge.exposeInMainWorld('titan', titan)
