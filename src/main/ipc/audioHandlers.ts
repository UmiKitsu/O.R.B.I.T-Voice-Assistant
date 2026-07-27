import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, Transcription } from '../../shared/types'
import { transcribeRecording } from '../services/speechToTextService'
import { isPcmWav } from '../services/speechToTextValidation'

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
        return await transcribeRecording(audio, controller.signal)
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
}
