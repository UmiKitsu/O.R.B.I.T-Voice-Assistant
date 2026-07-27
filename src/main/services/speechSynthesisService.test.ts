import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipcChannels'

const mocks = vi.hoisted(() => {
  type Handler = (value?: unknown) => void

  class FakeProcess {
    connected = true
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

    send(message: unknown): boolean {
      this.messages.push(message)
      if ((message as { type?: string }).type === 'initialize') {
        queueMicrotask(() =>
          this.emit('message', { type: 'ready', sampleRate: 24_000, numSpeakers: 53 })
        )
      }
      return true
    }

    disconnect = vi.fn(() => {
      this.connected = false
    })

    kill = vi.fn(() => {
      this.connected = false
      return true
    })
  }

  return {
    appPath: 'C:\\OrbitApp',
    access: vi.fn(async () => undefined),
    cp: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => {
      throw new Error('cache marker missing')
    }),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
    stat: vi.fn(async (path: string) => {
      const normalized = path.replace(/\\/g, '/')
      const sizes: Record<string, number> = {
        'model.onnx': 325_630_829,
        'voices.bin': 27_678_720,
        'tokens.txt': 687,
        'lexicon-us-en.txt': 5_956_885,
        'lexicon-zh.txt': 2_364_621,
        'espeak-ng-data/en_dict': 166_944
      }
      const match = Object.entries(sizes).find(([suffix]) => normalized.endsWith(suffix))
      if (!match) throw new Error(`Unexpected stat path: ${path}`)
      return { size: match[1] }
    }),
    writeFile: vi.fn(async () => undefined),
    processes: [] as FakeProcess[],
    fork: vi.fn(),
    FakeProcess
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => mocks.appPath,
    getPath: (name: string) => (name === 'userData' ? 'C:\\OrbitData' : 'C:\\OrbitTemp')
  }
}))

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  cp: mocks.cp,
  mkdir: mocks.mkdir,
  readFile: mocks.readFile,
  rename: mocks.rename,
  rm: mocks.rm,
  stat: mocks.stat,
  writeFile: mocks.writeFile
}))

vi.mock('node:child_process', () => ({
  fork: mocks.fork
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
  mocks.appPath = 'C:\\OrbitApp'
  mocks.processes.length = 0
  mocks.fork.mockReset().mockImplementation(() => {
    const process = new mocks.FakeProcess()
    mocks.processes.push(process)
    return process
  })
  mocks.access.mockReset().mockResolvedValue(undefined)
  mocks.cp.mockReset().mockResolvedValue(undefined)
  mocks.mkdir.mockReset().mockResolvedValue(undefined)
  mocks.readFile.mockReset().mockRejectedValue(new Error('cache marker missing'))
  mocks.rename.mockReset().mockResolvedValue(undefined)
  mocks.rm.mockReset().mockResolvedValue(undefined)
  mocks.stat.mockClear()
  mocks.writeFile.mockReset().mockResolvedValue(undefined)
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

  it('copies Unicode-path resources into a verified ASCII runtime cache for Electron', async () => {
    mocks.appPath = 'D:\\T.I.T.A.N. — Voice Assistant'

    await expect(
      startSpeechSynthesis(sender(80) as never, { text: 'Kokoro cache test.' })
    ).resolves.toMatchObject({ ok: true })

    expect(mocks.cp).toHaveBeenCalledOnce()
    expect(mocks.rename).toHaveBeenCalledOnce()
    const initializeMessage = mocks.processes[0].messages.find(
      (message) => (message as { type?: string }).type === 'initialize'
    ) as { resources: Record<string, string> }
    expect(Object.values(initializeMessage.resources).every((path) => !/[^\x20-\x7e]/.test(path))).toBe(
      true
    )
    expect(initializeMessage.resources.model).toContain('C:\\OrbitData\\kokoro-runtime')
  })

  it('starts a CPU Kokoro process with bm_george and forwards bounded PCM events', async () => {
    const webContents = sender()
    const result = await startSpeechSynthesis(webContents as never, { text: 'Opening Spotify.' })

    expect(result).toMatchObject({ ok: true, data: { requestId: expect.any(String) } })
    const requestId = result.ok ? result.data?.requestId : undefined
    const process = mocks.processes[0]
    expect(process.messages).toContainEqual(
      expect.objectContaining({
        type: 'initialize',
        numThreads: expect.any(Number)
      })
    )
    expect(process.messages).toContainEqual({
      type: 'synthesize',
      requestId,
      sentences: ['Opening Spotify.'],
      speakerId: 26,
      speed: 1
    })

    const samples = new Float32Array([0, 0.25, -0.25])
    process.emit('message', {
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

  it('resets an interrupted Kokoro process so the next request can restart locally', async () => {
    const firstSender = sender(82)
    const firstResult = await startSpeechSynthesis(firstSender as never, {
      text: 'First local response.'
    })
    expect(firstResult).toMatchObject({ ok: true })

    const firstProcess = mocks.processes[0]
    firstProcess.emit('error', new Error('native process interruption'))
    expect(firstSender.send).toHaveBeenCalledWith(
      IPC_CHANNELS.speechEvent,
      expect.objectContaining({
        type: 'error',
        code: 'KOKORO_RUNTIME_FAILED'
      })
    )
    expect(firstProcess.kill).toHaveBeenCalledOnce()

    const secondSender = sender(83)
    await expect(
      startSpeechSynthesis(secondSender as never, { text: 'Kokoro restarted.' })
    ).resolves.toMatchObject({ ok: true })
    expect(mocks.processes).toHaveLength(2)
  })

  it('never advertises or selects Windows speech when Kokoro resources are unavailable', async () => {
    mocks.access.mockRejectedValue(new Error('missing resource'))

    const result = await startSpeechSynthesis(sender(84) as never, { text: 'Speak locally.' })

    expect(result).toMatchObject({
      ok: false,
      code: 'KOKORO_RESOURCES_MISSING'
    })
    expect(result.message).not.toMatch(/Windows speech/i)
  })

  it('cancels only the active sender request', async () => {
    const webContents = sender(82)
    const result = await startSpeechSynthesis(webContents as never, {
      text: 'A cancellable sentence.'
    })
    const requestId = result.ok ? result.data?.requestId : undefined

    expect(cancelSpeechSynthesis(webContents.id)).toMatchObject({ ok: true })
    expect(mocks.processes[0].messages).toContainEqual({ type: 'cancel', requestId })
    expect(webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.speechEvent, {
      type: 'cancelled',
      requestId
    })
  })
})
