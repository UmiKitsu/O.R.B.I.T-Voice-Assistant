import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcChannels'
import type { ActionResult, OllamaHealth } from '../shared/types'

const titan = Object.freeze({
  checkOllama: (): Promise<ActionResult<OllamaHealth>> =>
    ipcRenderer.invoke(IPC_CHANNELS.ollamaHealth),

  askAssistant: (message: string): Promise<ActionResult<{ response: string }>> =>
    ipcRenderer.invoke(IPC_CHANNELS.assistantAsk, { message }),

  cancelAssistant: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.assistantCancel),

  clearConversation: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.assistantClear),

  confirmAction: (requestId: string, approved: boolean): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.actionConfirm, {
      requestId,
      approved
    })
})

contextBridge.exposeInMainWorld('titan', titan)
