import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcChannels'
import type {
  ActionResult,
  AssistantResponse,
  OllamaHealth,
  TitanSettings,
  Transcription
} from '../shared/types'

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

  confirmAction: (requestId: string, approved: boolean): Promise<ActionResult<AssistantResponse>> =>
    ipcRenderer.invoke(IPC_CHANNELS.actionConfirm, {
      requestId,
      approved
    })
})

contextBridge.exposeInMainWorld('titan', titan)
