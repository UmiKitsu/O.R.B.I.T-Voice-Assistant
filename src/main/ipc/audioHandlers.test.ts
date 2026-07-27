import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipcChannels'

const mocks = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  diagnoseVoiceRecording: vi.fn(),
  startWakeWordTest: vi.fn(() => ({ ok: true, message: 'Wake test started.' })),
  cancelWakeWordTest: vi.fn(() => ({ ok: true, message: 'Wake test cancelled.' }))
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handles.set(channel, handler)
    }),
    on: vi.fn()
  }
}))

vi.mock('../services/voiceDiagnosticsService', () => ({
  diagnoseVoiceRecording: mocks.diagnoseVoiceRecording
}))

vi.mock('../services/wakeWordService', () => ({
  cancelWakeWordTest: mocks.cancelWakeWordTest,
  pauseWakeWord: vi.fn(),
  resumeWakeWord: vi.fn(),
  sendWakeWordAudio: vi.fn(),
  startWakeWord: vi.fn(),
  startWakeWordTest: mocks.startWakeWordTest,
  stopWakeWord: vi.fn()
}))

import { registerAudioHandlers } from './audioHandlers'

function pcmWav(sample = 1_000): Uint8Array {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  for (const [index, value] of [...'RIFF'].entries()) view.setUint8(index, value.charCodeAt(0))
  for (const [index, value] of [...'WAVE'].entries()) view.setUint8(index + 8, value.charCodeAt(0))
  for (const [index, value] of [...'fmt '].entries()) view.setUint8(index + 12, value.charCodeAt(0))
  for (const [index, value] of [...'data'].entries()) view.setUint8(index + 36, value.charCodeAt(0))
  view.setUint32(4, 38, true)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(40, 2, true)
  view.setInt16(44, sample, true)
  return bytes
}

function event(senderId = 7): unknown {
  return { sender: { id: senderId, once: vi.fn() } }
}

beforeEach(() => {
  mocks.handles.clear()
  mocks.diagnoseVoiceRecording.mockReset()
  registerAudioHandlers()
})

describe('wake-word test IPC', () => {
  it('starts and cancels only the detector without invoking transcription', () => {
    const start = mocks.handles.get(IPC_CHANNELS.wakeWordTestStart)
    const cancel = mocks.handles.get(IPC_CHANNELS.wakeWordTestCancel)

    expect(start?.(event(12))).toMatchObject({ ok: true })
    expect(cancel?.(event(12))).toMatchObject({ ok: true })
    expect(mocks.startWakeWordTest).toHaveBeenCalledWith(12)
    expect(mocks.cancelWakeWordTest).toHaveBeenCalledWith(12)
    expect(mocks.diagnoseVoiceRecording).not.toHaveBeenCalled()
  })
})

describe('microphone test IPC', () => {
  it('sends validated audio only to diagnostics and returns a read-only route preview', async () => {
    const diagnosticResult = {
      ok: true,
      message: 'No action was executed.',
      data: {
        transcript: { rawText: 'open Spotify', normalizedText: 'open Spotify', corrections: [] },
        diagnostics: {
          durationMs: 500,
          transcriptionLatencyMs: 200,
          transcriptionBackend: 'vulkan-turbo',
          transcriptionModel: 'large-v3-turbo-q5_0',
          peakLevel: 0.4,
          rmsLevel: 0.1,
          route: {
            kind: 'deterministic',
            summary: 'Open a registered application',
            capability: 'application.launch',
            parameters: { application: 'Spotify' }
          }
        }
      }
    }
    mocks.diagnoseVoiceRecording.mockResolvedValue(diagnosticResult)
    const handler = mocks.handles.get(IPC_CHANNELS.microphoneTestTranscribe)

    await expect(handler?.(event(), { audio: pcmWav() })).resolves.toEqual(diagnosticResult)
    expect(mocks.diagnoseVoiceRecording).toHaveBeenCalledOnce()
  })

  it('rejects extra fields and cancels only the sender pending test', async () => {
    const handler = mocks.handles.get(IPC_CHANNELS.microphoneTestTranscribe)
    await expect(
      handler?.(event(), { audio: pcmWav(), path: 'forbidden.wav' })
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_MICROPHONE_TEST_AUDIO'
    })

    let observedSignal: AbortSignal | undefined
    mocks.diagnoseVoiceRecording.mockImplementation(
      async (_audio: Uint8Array, signal: AbortSignal) => {
        observedSignal = signal
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
        return {
          ok: false,
          code: 'TRANSCRIPTION_CANCELLED',
          message: 'The recording was cancelled.',
          recoverable: true
        }
      }
    )
    const pending = handler?.(event(9), { audio: pcmWav() })
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    const cancel = mocks.handles.get(IPC_CHANNELS.microphoneTestCancel)
    expect(cancel?.(event(9))).toMatchObject({ ok: true })
    await expect(pending).resolves.toMatchObject({ code: 'TRANSCRIPTION_CANCELLED' })
    expect(observedSignal?.aborted).toBe(true)
  })
})
