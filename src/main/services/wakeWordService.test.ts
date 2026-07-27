import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
      if ((message as { type?: string }).type === 'initialize') {
        queueMicrotask(() => this.emit('message', { type: 'ready' }))
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
  diagnoseVoiceRecording: mocks.diagnoseVoiceRecording
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

beforeEach(() => {
  vi.useFakeTimers()
  mocks.workers.length = 0
  mocks.diagnoseVoiceRecording.mockReset()
})

afterEach(() => {
  stopAllWakeWordSessions()
  vi.useRealTimers()
})

describe('wake-word diagnostic mode', () => {
  it('times out after eight seconds without transcribing or routing audio', async () => {
    const webContents = sender()
    await expect(startWakeWord(webContents as never)).resolves.toMatchObject({ ok: true })

    expect(startWakeWordTest(webContents.id)).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(8_000)

    expect(webContents.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'test-result',
        result: { detected: false }
      })
    )
    expect(mocks.diagnoseVoiceRecording).not.toHaveBeenCalled()
    expect(mocks.workers[0].messages).toContainEqual({ type: 'test-cancel' })
  })

  it('reports detection latency and cancellation produces no result', async () => {
    const detectedSender = sender(42)
    await startWakeWord(detectedSender as never)
    expect(startWakeWordTest(detectedSender.id)).toMatchObject({ ok: true })
    mocks.workers[0].emit('message', { type: 'test-detected', latencyMs: 375 })

    expect(detectedSender.send).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        type: 'test-result',
        result: { detected: true, latencyMs: 375 }
      })
    )
    expect(mocks.diagnoseVoiceRecording).not.toHaveBeenCalled()

    const cancelledSender = sender(43)
    await startWakeWord(cancelledSender as never)
    expect(startWakeWordTest(cancelledSender.id)).toMatchObject({ ok: true })
    expect(cancelWakeWordTest(cancelledSender.id)).toMatchObject({ ok: true })
    await vi.advanceTimersByTimeAsync(8_000)
    expect(cancelledSender.send).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'test-result' })
    )
  })
})
