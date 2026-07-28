import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OllamaHealth } from '../../shared/types'
import {
  ensureOllamaRunning,
  prepareOllama,
  resetOllamaPreparationForTests
} from './ollamaStartupService'

const connected: OllamaHealth = {
  connected: true,
  modelInstalled: true,
  models: ['qwen3:8b'],
  configuredModel: 'qwen3.5:9b-q4_K_M',
  activeModel: 'qwen3:8b',
  fallbackActive: true,
  warm: false
}
const disconnected: OllamaHealth = {
  connected: false,
  modelInstalled: false,
  models: [],
  configuredModel: 'qwen3.5:9b-q4_K_M',
  fallbackActive: false,
  warm: false
}

const warmed: OllamaHealth = {
  ...connected,
  warm: true
}

afterEach(() => {
  resetOllamaPreparationForTests()
})

describe('ensureOllamaRunning', () => {
  it('does not launch Ollama when the service is already available', async () => {
    const resolveExecutable = vi.fn()
    const launch = vi.fn()

    await expect(
      ensureOllamaRunning({
        check: vi.fn().mockResolvedValue(connected),
        resolveExecutable,
        launch
      })
    ).resolves.toBe(true)

    expect(resolveExecutable).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
  })

  it('launches the trusted Ollama app and waits for the service', async () => {
    const check = vi
      .fn<() => Promise<OllamaHealth>>()
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValue(connected)
    const launch = vi.fn().mockResolvedValue(undefined)

    await expect(
      ensureOllamaRunning({
        check,
        resolveExecutable: vi.fn().mockResolvedValue('D:\\Ollama\\ollama app.exe'),
        launch,
        delay: vi.fn().mockResolvedValue(undefined),
        now: () => 0
      })
    ).resolves.toBe(true)

    expect(launch).toHaveBeenCalledWith('D:\\Ollama\\ollama app.exe')
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('returns false when Ollama is unavailable and cannot be safely resolved', async () => {
    await expect(
      ensureOllamaRunning({
        check: vi.fn().mockResolvedValue(disconnected),
        resolveExecutable: vi.fn().mockResolvedValue(null)
      })
    ).resolves.toBe(false)
  })
})

describe('prepareOllama', () => {
  it('shares one startup and warm-up operation across concurrent callers', async () => {
    let finishEnsure: ((value: boolean) => void) | undefined
    const ensure = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishEnsure = resolve
        })
    )
    const warm = vi.fn(async (_signal, onProgress) => {
      onProgress?.({
        phase: 'loading',
        message: 'Loading qwen3:8b locally.',
        elapsedMs: 10,
        model: 'qwen3:8b'
      })
      return warmed
    })
    const firstProgress = vi.fn()
    const secondProgress = vi.fn()
    const dependencies = {
      ensure,
      check: vi.fn().mockResolvedValue(disconnected),
      warm
    }

    const first = prepareOllama(firstProgress, dependencies)
    const second = prepareOllama(secondProgress, dependencies)

    expect(ensure).toHaveBeenCalledTimes(1)
    finishEnsure?.(true)

    await expect(Promise.all([first, second])).resolves.toEqual([warmed, warmed])
    await expect(prepareOllama(undefined, dependencies)).resolves.toEqual(warmed)
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(warm).toHaveBeenCalledTimes(1)
    expect(firstProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'checking' })
    )
    expect(secondProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'checking' })
    )
    expect(firstProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'loading', model: 'qwen3:8b' })
    )
    expect(secondProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'loading', model: 'qwen3:8b' })
    )
  })

  it('uses one availability check when startup cannot connect', async () => {
    const ensure = vi.fn().mockResolvedValue(false)
    const check = vi.fn().mockResolvedValue(disconnected)
    const warm = vi.fn()

    await expect(
      Promise.all([
        prepareOllama(undefined, { ensure, check, warm }),
        prepareOllama(undefined, { ensure, check, warm })
      ])
    ).resolves.toEqual([disconnected, disconnected])

    expect(ensure).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalledTimes(1)
    expect(warm).not.toHaveBeenCalled()
  })
})
