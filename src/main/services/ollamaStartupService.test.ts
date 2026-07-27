import { describe, expect, it, vi } from 'vitest'
import type { OllamaHealth } from '../../shared/types'
import { ensureOllamaRunning } from './ollamaStartupService'

const connected: OllamaHealth = {
  connected: true,
  modelInstalled: true,
  models: ['qwen3:8b']
}
const disconnected: OllamaHealth = {
  connected: false,
  modelInstalled: false,
  models: []
}

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
