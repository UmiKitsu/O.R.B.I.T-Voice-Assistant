import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, Transcription } from '../../shared/types'
import { transcribeRecording } from '../services/speechToTextService'
import { isPcmWav } from '../services/speechToTextValidation'
import { logOperationalEvent } from '../services/loggerService'
import { parseWakeWordAudioChunk } from '../services/wakeWordValidation'
import {
  pauseWakeWord,
  resumeWakeWord,
  sendWakeWordAudio,
  startWakeWord,
  stopWakeWord
} from '../services/wakeWordService'

const activeTranscriptions = new Map<number, AbortController>()

function parseTranscriptionRequest(value: unknown): Uint8Array | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('audio' in value) ||
    Object.keys(value).length !== 1
  ) {
    return null
  }

  const audio = (value as { audio?: unknown }).audio
  return isPcmWav(audio) ? audio : null
}

export function registerAudioHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.speechRecordingStarted, (): ActionResult => {
    logOperationalEvent({ event: 'recording.started' })
    return { ok: true, message: 'Recording start logged.' }
  })
  ipcMain.handle(
    IPC_CHANNELS.speechTranscribe,
    async (event: IpcMainInvokeEvent, request: unknown): Promise<ActionResult<Transcription>> => {
      const audio = parseTranscriptionRequest(request)
      if (!audio) {
        return {
          ok: false,
          code: 'INVALID_RECORDING',
          message: 'The recording format was invalid.',
          recoverable: true
        }
      }

      const senderId = event.sender.id
      if (activeTranscriptions.has(senderId)) {
        return {
          ok: false,
          code: 'TRANSCRIPTION_IN_PROGRESS',
          message: 'A recording is already being transcribed.',
          recoverable: true
        }
      }

      const controller = new AbortController()
      activeTranscriptions.set(senderId, controller)
      const abortOnDestroyed = (): void => controller.abort()
      event.sender.once('destroyed', abortOnDestroyed)
      try {
        const result = await transcribeRecording(audio, controller.signal)
        logOperationalEvent({
          event: 'transcription.completed',
          outcome: result.ok ? 'succeeded' : 'failed'
        })
        return result
      } finally {
        event.sender.removeListener('destroyed', abortOnDestroyed)
        if (activeTranscriptions.get(senderId) === controller) {
          activeTranscriptions.delete(senderId)
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.speechCancelTranscription,
    (event: IpcMainInvokeEvent): ActionResult => {
      const controller = activeTranscriptions.get(event.sender.id)
      if (controller) {
        controller.abort()
        activeTranscriptions.delete(event.sender.id)
      }

      return {
        ok: true,
        message: controller ? 'The recording was cancelled.' : 'There is no active transcription.'
      }
    }
  )
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
