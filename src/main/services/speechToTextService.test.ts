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

import { transcribeRecording } from './speechToTextService'

function audibleAudio(seconds = 0.2): Uint8Array {
  return encodePcm16Wav(new Float32Array(Math.round(16_000 * seconds)).fill(0.05))
}

async function waitForChild(): Promise<InstanceType<typeof mocks.FakeChild>> {
  for (let attempt = 0; attempt < 20 && mocks.children.length === 0; attempt += 1) {
    await Promise.resolve()
  }
  const child = mocks.children.at(-1)
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

describe('Whisper temporary audio cleanup', () => {
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
      data: { text: 'Orbit.', detectedLanguage: 'en' }
    })
    const arguments_ = mocks.spawn.mock.calls[0]?.[1] as string[]
    expect(arguments_).toEqual(expect.arrayContaining(['--audio-ctx', '256', '--beam-size', '1']))
    expect(mocks.unlink).toHaveBeenCalledOnce()
    expect(mocks.unlink).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0]?.[0])
  })

  it('deletes the temporary WAV after Whisper returns a failure', async () => {
    const pending = transcribeRecording(audibleAudio(), new AbortController().signal)
    const child = await waitForChild()
    child.emit('close', 1)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'TRANSCRIPTION_UNCLEAR'
    })
    const arguments_ = mocks.spawn.mock.calls[0]?.[1] as string[]
    expect(arguments_).not.toContain('--audio-ctx')
    expect(mocks.unlink).toHaveBeenCalledWith(mocks.writeFile.mock.calls[0]?.[0])
  })

  it('deletes the temporary WAV after a timeout', async () => {
    vi.useFakeTimers()
    const pending = transcribeRecording(audibleAudio(), new AbortController().signal)
    const child = await waitForChild()
    await vi.advanceTimersByTimeAsync(45_000)

    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'TRANSCRIPTION_TIMEOUT'
    })
    expect(child.kill).toHaveBeenCalledOnce()
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
    expect(mocks.unlink).toHaveBeenCalledOnce()
  })
})
