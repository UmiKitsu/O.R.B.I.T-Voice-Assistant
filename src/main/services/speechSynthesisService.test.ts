import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipcChannels'

const mocks = vi.hoisted(() => {
  type Handler = (value?: unknown) => void

  class FakeWorker {
    threadId = 1
    messages: unknown[] = []
    private handlers = new Map<string, Handler[]>()

    on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }

    once(event: string, handler: Handler): this {
      return this.on(event, handler)
    }

    emit(event: string, value?: unknown): void {
      for (const handler of this.handlers.get(event) ?? []) handler(value)
    }

    postMessage(message: unknown): void {
      this.messages.push(message)
      if ((message as { type?: string }).type === 'initialize') {
        queueMicrotask(() =>
          this.emit('message', { type: 'ready', sampleRate: 24_000, numSpeakers: 53 })
        )
      }
    }

    terminate = vi.fn(async () => 0)
  }

  return {
    access: vi.fn(async () => undefined),
    realpath: vi.fn(async (path: string) => path),
    symlink: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    workers: [] as FakeWorker[],
    FakeWorker
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => 'C:\\OrbitTemp'
  }
}))

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  realpath: mocks.realpath,
  symlink: mocks.symlink,
  unlink: mocks.unlink
}))

vi.mock('./speechSynthesisWorker?nodeWorker', () => ({
  default: () => {
    const worker = new mocks.FakeWorker()
    mocks.workers.push(worker)
    return worker
  }
}))

import {
  KOKORO_SPEAKER_IDS,
  cancelSpeechSynthesis,
  parseSpeechSynthesisRequest,
  splitSpeechText,
  startSpeechSynthesis,
  stopAllSpeechSynthesis
} from './speechSynthesisService'

function sender(id = 81): {
  id: number
  isDestroyed: () => boolean
  once: Mock
  send: Mock
} {
  return {
    id,
    isDestroyed: () => false,
    once: vi.fn(),
    send: vi.fn()
  }
}

beforeEach(() => {
  mocks.workers.length = 0
  mocks.access.mockClear()
  mocks.symlink.mockClear()
  mocks.unlink.mockClear()
})

afterEach(() => {
  stopAllSpeechSynthesis()
})

describe('Kokoro speech synthesis validation', () => {
  it('uses the official bm_george speaker and a small curated manifest', () => {
    expect(KOKORO_SPEAKER_IDS.bm_george).toBe(26)
    expect(KOKORO_SPEAKER_IDS).toEqual({
      bm_george: 26,
      bm_lewis: 27,
      bm_daniel: 24,
      am_adam: 11,
      am_michael: 16,
      bf_emma: 21,
      af_heart: 3
    })
  })

  it('accepts only a bounded one-field text request', () => {
    expect(parseSpeechSynthesisRequest({ text: ' Hello Orbit. ' })).toBe('Hello Orbit.')
    expect(parseSpeechSynthesisRequest({ text: '' })).toBeNull()
    expect(parseSpeechSynthesisRequest({ text: 'x'.repeat(4_001) })).toBeNull()
    expect(parseSpeechSynthesisRequest({ text: 'Hello', path: 'unsafe.wav' })).toBeNull()
    expect(parseSpeechSynthesisRequest('Hello')).toBeNull()
  })

  it('splits at sentence boundaries and bounds every in-memory synthesis chunk', () => {
    const longSentence = `${'word '.repeat(80).trim()}.`
    const chunks = splitSpeechText(`First sentence! ${longSentence} Final sentence?`)

    expect(chunks[0]).toBe('First sentence!')
    expect(chunks.at(-1)).toBe('Final sentence?')
    expect(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 240)).toBe(true)
    expect(chunks.length).toBeLessThanOrEqual(50)
  })

  it('starts a CPU Kokoro worker with bm_george and forwards bounded PCM events', async () => {
    const webContents = sender()
    const result = await startSpeechSynthesis(webContents as never, { text: 'Opening Spotify.' })

    expect(result).toMatchObject({ ok: true, data: { requestId: expect.any(String) } })
    const requestId = result.ok ? result.data?.requestId : undefined
    const worker = mocks.workers[0]
    expect(worker.messages).toContainEqual(
      expect.objectContaining({
        type: 'initialize',
        numThreads: expect.any(Number)
      })
    )
    expect(worker.messages).toContainEqual({
      type: 'synthesize',
      requestId,
      sentences: ['Opening Spotify.'],
      speakerId: 26,
      speed: 1
    })

    const samples = new Float32Array([0, 0.25, -0.25])
    worker.emit('message', {
      type: 'audio',
      requestId,
      chunkIndex: 0,
      sampleRate: 24_000,
      samples,
      final: true
    })
    expect(webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.speechEvent,
      expect.objectContaining({ type: 'audio', requestId, samples })
    )
  })

  it('cancels only the active sender request', async () => {
    const webContents = sender(82)
    const result = await startSpeechSynthesis(webContents as never, {
      text: 'A cancellable sentence.'
    })
    const requestId = result.ok ? result.data?.requestId : undefined

    expect(cancelSpeechSynthesis(webContents.id)).toMatchObject({ ok: true })
    expect(mocks.workers[0].messages).toContainEqual({ type: 'cancel', requestId })
    expect(webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.speechEvent, {
      type: 'cancelled',
      requestId
    })
  })
})
