import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult } from '../../shared/types'
import { parseWakeWordAudioChunk } from '../services/wakeWordValidation'
import {
  pauseWakeWord,
  resumeWakeWord,
  sendWakeWordAudio,
  startWakeWord,
  stopWakeWord
} from '../services/wakeWordService'

export function registerAudioHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.wakeWordStart, (event: IpcMainInvokeEvent) =>
    startWakeWord(event.sender)
  )
  ipcMain.handle(IPC_CHANNELS.wakeWordStop, (event: IpcMainInvokeEvent): ActionResult =>
    stopWakeWord(event.sender.id)
  )
  ipcMain.handle(IPC_CHANNELS.wakeWordPause, (event: IpcMainInvokeEvent): ActionResult =>
    pauseWakeWord(event.sender.id)
  )
  ipcMain.handle(IPC_CHANNELS.wakeWordResume, (event: IpcMainInvokeEvent): ActionResult =>
    resumeWakeWord(event.sender.id)
  )
  ipcMain.on(IPC_CHANNELS.wakeWordAudioChunk, (event: IpcMainInvokeEvent, request: unknown) => {
    const samples = parseWakeWordAudioChunk(request)
    if (samples) sendWakeWordAudio(event.sender.id, samples)
  })
}
