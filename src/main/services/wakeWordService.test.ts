import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const WAKE_METRICS = {
  captureDurationMs: 800,
  audioChunkCount: 8,
  peakLevel: 0.18,
  rmsLevel: 0.04,
  signalQuality: 'good' as const
}

const mocks = vi.hoisted(() => {
  type Handler = (value?: unknown) => void
  class FakeWorker {
    handlers = new Map<string, Handler[]>()
    messages: unknown[] = []

    on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }

    once(event: string, handler: Handler): this {
      return this.on(event, handler)
    }

    postMessage(message: unknown): void {
      this.messages.push(message)
      const type = (message as { type?: string }).type
      if (type === 'initialize') {
        queueMicrotask(() => this.emit('message', { type: 'ready' }))
      } else if (type === 'test-window-end') {
        queueMicrotask(() =>
          this.emit('message', {
            type: 'test-window-ended',
            metrics: {
              captureDurationMs: 800,
              audioChunkCount: 8,
              peakLevel: 0.18,
              rmsLevel: 0.04,
              signalQuality: 'good'
            }
          })
        )
      }
    }

    emit(event: string, value?: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) handler(value)
    }

    async terminate(): Promise<number> {
      return 0
    }
  }

  return {
    workers: [] as FakeWorker[],
    diagnoseVoiceRecording: vi.fn(),
    diagnoseWakeCandidateRecording: vi.fn(),
    FakeWorker
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

vi.mock('./loggerService', () => ({
  logOperationalEvent: vi.fn()
}))

vi.mock('./voiceDiagnosticsService', () => ({
  diagnoseVoiceRecording: mocks.diagnoseVoiceRecording,
  diagnoseWakeCandidateRecording: mocks.diagnoseWakeCandidateRecording
}))

vi.mock('./wakeWordWorker?nodeWorker', () => ({
  default: () => {
    const worker = new mocks.FakeWorker()
    mocks.workers.push(worker)
    return worker
  }
}))

import {
  cancelWakeWordTest,
  pauseWakeWord,
  startWakeWord,
  startWakeWordTest,
  stopAllWakeWordSessions
} from './wakeWordService'

function sender(id = 41): {
  id: number
  isDestroyed: () => boolean
  once: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
} {
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn(),
    send: vi.fn()
  }
}

function wakeCandidate(test = false): {
  type: 'wake-candidate'
  candidateId: number
  samples: Float32Array
  metrics: typeof WAKE_METRICS
  test: boolean
} {
  return {
    type: 'wake-candidate',
    candidateId: 7,
    samples: new Float32Array(3_200).fill(0.05),
    metrics: WAKE_METRICS,
    test
  }
}

function successfulFallback(command = true): unknown {
  return {
    ok: true,
    message: 'Orbit was detected by local fallback transcription.',
    data: {
      detected: true,
      heardText: command ? 'Orbit open Spotify' : 'Orbit',
      wakePhrase: 'Orbit',
      transcript: command
        ? { rawText: 'open Spotify', normalizedText: 'open Spotify', corrections: [] }
        : undefined,
      diagnostics: command
        ? {
            durationMs: 200,
            transcriptionLatencyMs: 90,
            peakLevel: 0.1,
            rmsLevel: 0.03,
            transcriptionBackend: 'cpu-small',
            transcriptionModel: 'small',
            detectedLanguage: 'en',
            route: {
              kind: 'deterministic',
              summary: 'Open a registered application',
              capability: 'application.launch',
              parameters: { application: 'Spotify' }
            }
          }
        : undefined,
      transcriptionLatencyMs: 90,
      detectedLanguage: 'en'
    }
  }
}

function successfulCommandDiagnosis(): unknown {
  return {
    ok: true,
    message: 'Command transcribed with the standard backend.',
    data: {
      transcript: {
        rawText: 'open Spotify',
        normalizedText: 'open Spotify',
        corrections: []
      },
      diagnostics: {
        durationMs: 800,
        transcriptionLatencyMs: 180,
        peakLevel: 0.18,
        rmsLevel: 0.04,
        transcriptionBackend: 'vulkan-turbo',
        transcriptionModel: 'large-v3-turbo-q5_0',
        detectedLanguage: 'en',
        route: {
          kind: 'deterministic',
          summary: 'Open a registered application',
          capability: 'application.launch',
          parameters: { application: 'Spotify' }
        }
      }
    }
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.workers.length = 0
  mocks.diagnoseVoiceRecording.mockReset()
  mocks.diagnoseWakeCandidateRecording.mockReset()
})

afterEach(() => {
  stopAllWakeWordSessions()
  vi.useRealTimers()
})

describe('wake-word diagnostic mode', () => {
  it('ends after eight seconds without invoking Whisper when no speech candidate exists', async () => {
    const webContents = sender()
    await expect(startWakeWord(webContents as never)).resolves.toMatchObject({ ok: true })

    expect(startWakeWordTest(webContents.id)).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(8_000)
    await flushAsyncWork()

    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'test-result',
        result: { detected: false, ...WAKE_METRICS }
      })
    )
    expect(mocks.diagnoseWakeCandidateRecording).not.toHaveBeenCalled()
    expect(mocks.diagnoseVoiceRecording).not.toHaveBeenCalled()
    expect(mocks.workers[0].messages).toContainEqual({ type: 'test-cancel' })
  })

  it('reports primary keyword metrics and bypasses Whisper', async () => {
    const webContents = sender(42)
    await startWakeWord(webContents as never)
    expect(startWakeWordTest(webContents.id)).toMatchObject({ ok: true })
    mocks.workers[0].emit('message', {
      type: 'test-detected',
      latencyMs: 375,
      metrics: WAKE_METRICS
    })

    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'test-result',
        result: {
          detected: true,
          method: 'keyword',
          latencyMs: 375,
          heardText: 'Orbit',
          ...WAKE_METRICS
        }
      })
    )
    expect(mocks.diagnoseWakeCandidateRecording).not.toHaveBeenCalled()
    expect(mocks.diagnoseVoiceRecording).not.toHaveBeenCalled()
  })

  it('uses Whisper diagnostically without emitting a routed transcription', async () => {
    const webContents = sender(43)
    await startWakeWord(webContents as never)
    mocks.diagnoseWakeCandidateRecording.mockResolvedValue(successfulFallback(false))
    expect(startWakeWordTest(webContents.id)).toMatchObject({ ok: true })

    mocks.workers[0].emit('message', wakeCandidate(true))
    await flushAsyncWork()

    expect(mocks.workers[0].messages).toContainEqual({
      type: 'fallback-result',
      candidateId: 7,
      detected: true,
      hasCommand: false
    })
    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'test-result',
        result: expect.objectContaining({
          detected: true,
          method: 'whisper-fallback',
          heardText: 'Orbit',
          ...WAKE_METRICS
        })
      })
    )
    expect(webContents.send).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'transcription' })
    )
  })

  it('cancels active fallback transcription and produces no result', async () => {
    const webContents = sender(44)
    let fallbackSignal: AbortSignal | undefined
    mocks.diagnoseWakeCandidateRecording.mockImplementation(
      (_audio: Uint8Array, signal: AbortSignal) => {
        fallbackSignal = signal
        return new Promise(() => undefined)
      }
    )
    await startWakeWord(webContents as never)
    expect(startWakeWordTest(webContents.id)).toMatchObject({ ok: true })
    mocks.workers[0].emit('message', wakeCandidate(true))
    await flushAsyncWork()

    expect(cancelWakeWordTest(webContents.id)).toMatchObject({ ok: true })
    expect(fallbackSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(12_000)
    expect(webContents.send).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'test-result' })
    )
  })
})

describe('armed hybrid recognition', () => {
  it('uses Small only for wake detection and retranscribes the preserved command with Turbo', async () => {
    const webContents = sender(51)
    mocks.diagnoseWakeCandidateRecording.mockResolvedValue(successfulFallback(true))
    mocks.diagnoseVoiceRecording.mockResolvedValue(successfulCommandDiagnosis())
    await startWakeWord(webContents as never)

    mocks.workers[0].emit('message', wakeCandidate(false))
    await flushAsyncWork()

    expect(mocks.diagnoseWakeCandidateRecording).toHaveBeenCalledOnce()
    expect(mocks.diagnoseVoiceRecording).toHaveBeenCalledOnce()
    expect(mocks.workers[0].messages).toContainEqual({
      type: 'fallback-result',
      candidateId: 7,
      detected: true,
      hasCommand: true
    })
    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'transcription',
        transcript: expect.objectContaining({ normalizedText: 'open Spotify' })
      })
    )
  })

  it('keeps an already captured command transcribing when microphone listening is paused', async () => {
    const webContents = sender(56)
    let transcriptionSignal: AbortSignal | undefined
    let resolveDiagnosis: ((value: unknown) => void) | undefined
    mocks.diagnoseVoiceRecording.mockImplementation((_audio: Uint8Array, signal: AbortSignal) => {
      transcriptionSignal = signal
      return new Promise((resolve) => {
        resolveDiagnosis = resolve
      })
    })
    await startWakeWord(webContents as never)

    mocks.workers[0].emit('message', {
      type: 'command',
      samples: new Float32Array(3_200).fill(0.05)
    })
    await flushAsyncWork()

    expect(pauseWakeWord(webContents.id)).toMatchObject({ ok: true })
    expect(transcriptionSignal?.aborted).toBe(false)

    resolveDiagnosis?.(successfulCommandDiagnosis())
    await flushAsyncWork()

    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'transcription',
        transcript: expect.objectContaining({ normalizedText: 'open Spotify' })
      })
    )
  })

  it('reports unexpected transcription failures instead of remaining paused forever', async () => {
    const webContents = sender(54)
    mocks.diagnoseVoiceRecording.mockRejectedValue(new Error('native transcription failure'))
    await startWakeWord(webContents as never)

    mocks.workers[0].emit('message', {
      type: 'command',
      samples: new Float32Array(3_200).fill(0.05)
    })
    await flushAsyncWork()

    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'error',
        code: 'TRANSCRIPTION_FAILED',
        fatal: false
      })
    )
  })

  it('times out a hung command transcription and aborts its native work', async () => {
    const webContents = sender(55)
    let transcriptionSignal: AbortSignal | undefined
    mocks.diagnoseVoiceRecording.mockImplementation((_audio: Uint8Array, signal: AbortSignal) => {
      transcriptionSignal = signal
      return new Promise(() => undefined)
    })
    await startWakeWord(webContents as never)

    mocks.workers[0].emit('message', {
      type: 'command',
      samples: new Float32Array(3_200).fill(0.05)
    })
    await vi.advanceTimersByTimeAsync(12_500)
    await flushAsyncWork()

    expect(transcriptionSignal?.aborted).toBe(true)
    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'error',
        code: 'TRANSCRIPTION_TIMEOUT',
        fatal: false
      })
    )
  })

  it('keeps buffered follow-up audio when fallback hears only Orbit', async () => {
    const webContents = sender(52)
    mocks.diagnoseWakeCandidateRecording.mockResolvedValue(successfulFallback(false))
    await startWakeWord(webContents as never)

    mocks.workers[0].emit('message', wakeCandidate(false))
    await flushAsyncWork()

    expect(mocks.workers[0].messages).toContainEqual({
      type: 'fallback-result',
      candidateId: 7,
      detected: true,
      hasCommand: false
    })
    expect(webContents.send).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'transcription' })
    )
  })

  it('discards non-Orbit speech without routing or command transcription', async () => {
    const webContents = sender(53)
    mocks.diagnoseWakeCandidateRecording.mockResolvedValue({
      ok: true,
      message: 'No trusted wake phrase.',
      data: {
        detected: false,
        heardText: 'Play some music',
        transcriptionLatencyMs: 80
      }
    })
    await startWakeWord(webContents as never)

    mocks.workers[0].emit('message', wakeCandidate(false))
    await flushAsyncWork()

    expect(mocks.workers[0].messages).toContainEqual({
      type: 'fallback-result',
      candidateId: 7,
      detected: false,
      hasCommand: false
    })
    expect(mocks.diagnoseVoiceRecording).not.toHaveBeenCalled()
    expect(webContents.send).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'transcription' })
    )
  })
})
