import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, MicrophoneTestResult } from '../../shared/types'
import { parseMicrophoneTestRequest } from '../services/speechToTextValidation'
import { diagnoseVoiceRecording } from '../services/voiceDiagnosticsService'
import { parseWakeWordAudioChunk } from '../services/wakeWordValidation'
import {
  cancelWakeWordTest,
  pauseWakeWord,
  resumeWakeWord,
  sendWakeWordAudio,
  startWakeWord,
  startWakeWordTest,
  stopWakeWord
} from '../services/wakeWordService'

const microphoneTests = new Map<number, AbortController>()
const microphoneCleanupSenders = new Set<number>()

function cancelMicrophoneTest(senderId: number): ActionResult {
  const controller = microphoneTests.get(senderId)
  if (!controller) return { ok: true, message: 'No microphone test is running.' }
  microphoneTests.delete(senderId)
  controller.abort()
  return { ok: true, message: 'Microphone test cancelled.' }
}

async function transcribeMicrophoneTest(
  event: IpcMainInvokeEvent,
  request: unknown
): Promise<ActionResult<MicrophoneTestResult>> {
  const audio = parseMicrophoneTestRequest(request)
  if (!audio) {
    return {
      ok: false,
      code: 'INVALID_MICROPHONE_TEST_AUDIO',
      message: 'The microphone test audio was invalid.',
      recoverable: true
    }
  }

  cancelMicrophoneTest(event.sender.id)
  const controller = new AbortController()
  const senderId = event.sender.id
  microphoneTests.set(senderId, controller)
  if (!microphoneCleanupSenders.has(senderId)) {
    microphoneCleanupSenders.add(senderId)
    event.sender.once('destroyed', () => {
      microphoneCleanupSenders.delete(senderId)
      cancelMicrophoneTest(senderId)
    })
  }
  try {
    return await diagnoseVoiceRecording(audio, controller.signal)
  } finally {
    if (microphoneTests.get(event.sender.id) === controller) {
      microphoneTests.delete(event.sender.id)
    }
  }
}

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
  ipcMain.handle(IPC_CHANNELS.wakeWordTestStart, (event: IpcMainInvokeEvent): ActionResult =>
    startWakeWordTest(event.sender.id)
  )
  ipcMain.handle(IPC_CHANNELS.wakeWordTestCancel, (event: IpcMainInvokeEvent): ActionResult =>
    cancelWakeWordTest(event.sender.id)
  )
  ipcMain.on(IPC_CHANNELS.wakeWordAudioChunk, (event: IpcMainInvokeEvent, request: unknown) => {
    const samples = parseWakeWordAudioChunk(request)
    if (samples) sendWakeWordAudio(event.sender.id, samples)
  })
  ipcMain.handle(IPC_CHANNELS.microphoneTestTranscribe, transcribeMicrophoneTest)
  ipcMain.handle(IPC_CHANNELS.microphoneTestCancel, (event: IpcMainInvokeEvent): ActionResult =>
    cancelMicrophoneTest(event.sender.id)
  )
}
