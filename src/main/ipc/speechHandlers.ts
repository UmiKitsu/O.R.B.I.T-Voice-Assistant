import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult } from '../../shared/types'
import { cancelSpeechSynthesis, startSpeechSynthesis } from '../services/speechSynthesisService'

export function registerSpeechHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.speechSynthesize,
    (event: IpcMainInvokeEvent, request: unknown): Promise<ActionResult<{ requestId: string }>> =>
      startSpeechSynthesis(event.sender, request)
  )
  ipcMain.handle(IPC_CHANNELS.speechCancel, (event: IpcMainInvokeEvent): ActionResult =>
    cancelSpeechSynthesis(event.sender.id)
  )
}
