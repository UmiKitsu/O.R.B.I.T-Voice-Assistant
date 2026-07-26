import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/ipcChannels'
import type { ActionResult } from '../shared/types'

const titan = Object.freeze({
  checkOllama: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.ollamaHealth),

  askAssistant: (message: string): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.assistantAsk, { message }),

  cancelAssistant: (): Promise<ActionResult> => ipcRenderer.invoke(IPC_CHANNELS.assistantCancel),

  confirmAction: (requestId: string, approved: boolean): Promise<ActionResult> =>
    ipcRenderer.invoke(IPC_CHANNELS.actionConfirm, {
      requestId,
      approved
    })
})

contextBridge.exposeInMainWorld('titan', titan)
