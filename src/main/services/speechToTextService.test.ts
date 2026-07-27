import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePcm16Wav } from './wakeWordValidation'

const mocks = vi.hoisted(() => {
  type Handler = (...values: unknown[]) => void

  class FakeEmitter {
    private handlers = new Map<string, Handler[]>()

    on(event: string, handler: Handler): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
      return this
    }

    emit(event: string, ...values: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...values)
    }

    setEncoding(): this {
      return this
    }
  }

  class FakeChild extends FakeEmitter {
    stdout = new FakeEmitter()
    stderr = new FakeEmitter()
    kill = vi.fn()
  }

  return {
    access: vi.fn(),
    children: [] as FakeChild[],
    FakeChild,
    spawn: vi.fn(),
    unlink: vi.fn(),
    writeFile: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => 'C:\\OrbitTemp'
  }
}))

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn
}))

vi.mock('node:fs/promises', () => ({
  access: mocks.access,
  unlink: mocks.unlink,
  writeFile: mocks.writeFile
}))

import { resolveWhisperCandidates, transcribeRecording } from './speechToTextService'

function audibleAudio(seconds = 0.2): Uint8Array {
  return encodePcm16Wav(new Float32Array(Math.round(16_000 * seconds)).fill(0.05))
}

async function waitForChild(count = 1): Promise<InstanceType<typeof mocks.FakeChild>> {
  for (let attempt = 0; attempt < 30 && mocks.children.length < count; attempt += 1) {
    await Promise.resolve()
  }
  const child = mocks.children[count - 1]
  if (!child) throw new Error('Whisper child process was not started.')
  return child
}

function finishSuccessfully(child: InstanceType<typeof mocks.FakeChild>): void {
  child.stdout.emit('data', 'Orbit.\n')
  child.stderr.emit('data', 'auto-detected language: en (0.99)\n')
  child.emit('close', 0)
}

beforeEach(() => {
  mocks.children.length = 0
  mocks.access.mockReset().mockResolvedValue(undefined)
  mocks.unlink.mockReset().mockResolvedValue(undefined)
  mocks.writeFile.mockReset().mockResolvedValue(undefined)
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new mocks.FakeChild()
    mocks.children.push(child)
    return child
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Whisper backend selection and temporary audio cleanup', () => {
  it('uses Vulkan Turbo for commands and CPU Small only for wake fallback', async () => {
    await expect(resolveWhisperCandidates('standard')).resolves.toMatchObject([
      { backend: 'vulkan-turbo', modelName: 'large-v3-turbo-q5_0', timeoutMs: 5_000 },
      { backend: 'cpu-small', modelName: 'small', timeoutMs: 7_000 }
    ])
    await expect(resolveWhisperCandidates('wake-candidate')).resolves.toMatchObject([
      { backend: 'cpu-small', modelName: 'small', timeoutMs: 4_000 }
    ])
  })

  it('deletes the temporary WAV after a successful optimized wake transcription', async () => {
    const pending = transcribeRecording(
      audibleAudio(),
      new AbortController().signal,
      'wake-candidate'
    )
    const child = await waitForChild()
    finishSuccessfully(child)

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: {
        text: 'Orbit.',
        detectedLanguage: 'en',
        backend: 'cpu-small',
        model: 'small'
      }
    })
    const arguments_ = mocks.spawn.mock.calls[0]?.[1] as string[]
    expect(arguments_).toEqual(
      expect.arrayContaining([
        '--audio-ctx',
        '256',
        '--beam-size',
        '1',
        '--best-of',
        '1',
        '--no-fallback'
      ])
    )
    expect(mocks.unlink).toHaveBeenCalledOnce()
    expect(mocks.unlink).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0]?.[0])
  })

  it('falls back from a failed Vulkan runtime directly to CPU Small without rewriting audio', async () => {
    const pending = transcribeRecording(audibleAudio(), new AbortController().signal)
    const vulkanChild = await waitForChild()
    vulkanChild.emit('close', 1)
    const cpuChild = await waitForChild(2)
    finishSuccessfully(cpuChild)

    await expect(pending).resolves.toMatchObject({
      ok: true,
      data: { backend: 'cpu-small', model: 'small' }
    })
    expect(mocks.writeFile).toHaveBeenCalledOnce()
    expect(mocks.unlink).toHaveBeenCalledOnce()
  })

  it('deletes the temporary WAV after unclear transcription', async () => {
    const pending = transcribeRecording(audibleAudio(), new AbortController().signal)
    const child = await waitForChild()
    child.emit('close', 0)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'TRANSCRIPTION_UNCLEAR'
    })
    expect(mocks.unlink).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0]?.[0])
  })

  it('falls back after backend timeouts and deletes the temporary WAV', async () => {
    vi.useFakeTimers()
    const pending = transcribeRecording(audibleAudio(), new AbortController().signal)

    const children: InstanceType<typeof mocks.FakeChild>[] = []
    const vulkanChild = await waitForChild(1)
    children.push(vulkanChild)
    await vi.advanceTimersByTimeAsync(5_000)
    const cpuChild = await waitForChild(2)
    children.push(cpuChild)
    await vi.advanceTimersByTimeAsync(7_000)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'TRANSCRIPTION_TIMEOUT'
    })
    for (const child of children) expect(child.kill).toHaveBeenCalledOnce()
    expect(mocks.unlink).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0]?.[0])
  })

  it('deletes the temporary WAV and kills Whisper after cancellation', async () => {
    const controller = new AbortController()
    const pending = transcribeRecording(audibleAudio(), controller.signal, 'wake-candidate')
    const child = await waitForChild()
    controller.abort()

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'TRANSCRIPTION_CANCELLED'
    })
    expect(child.kill).toHaveBeenCalledOnce()
    expect(mocks.unlink).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0]?.[0])
  })

  it('keeps full Whisper context for wake candidates longer than five seconds', async () => {
    const pending = transcribeRecording(
      audibleAudio(6),
      new AbortController().signal,
      'wake-candidate'
    )
    const child = await waitForChild()
    finishSuccessfully(child)
    await expect(pending).resolves.toMatchObject({ ok: true })

    const arguments_ = mocks.spawn.mock.calls[0]?.[1] as string[]
    expect(arguments_).not.toContain('--audio-ctx')
    expect(arguments_).toEqual(
      expect.arrayContaining(['--beam-size', '1', '--best-of', '1', '--no-fallback'])
    )
    expect(mocks.unlink).toHaveBeenCalledOnce()
  })
})
