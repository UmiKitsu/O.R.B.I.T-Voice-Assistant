import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OllamaHealth, OrbitSettings } from '../../shared/types'
import { getExactModelHealth } from './ollamaService'
import {
  getScreenAwarenessStatus,
  refreshScreenAwarenessStatus,
  resetScreenAwarenessForTests
} from './screenAwarenessService'
import { DEFAULT_ORBIT_SETTINGS, setSettingsStorageForTests } from './settingsService'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/OrbitTest'),
    getAppPath: vi.fn(() => 'C:/OrbitProject'),
    isPackaged: false
  }
}))

vi.mock('./ollamaService', () => ({
  getExactModelHealth: vi.fn()
}))

const healthMock = vi.mocked(getExactModelHealth)

function settings(screenAwarenessEnabled = true): void {
  const storage: { store: OrbitSettings; set(value: OrbitSettings): void } = {
    store: { ...DEFAULT_ORBIT_SETTINGS, screenAwarenessEnabled },
    set(value) {
      this.store = value
    }
  }
  setSettingsStorageForTests(storage)
}

function health(warm: boolean): OllamaHealth {
  return {
    connected: true,
    modelInstalled: true,
    models: ['qwen3-vl:4b'],
    configuredModel: 'qwen3-vl:4b',
    activeModel: 'qwen3-vl:4b',
    fallbackActive: false,
    warm,
    processor: warm ? 'gpu' : 'unknown'
  }
}

afterEach(() => {
  healthMock.mockReset()
  resetScreenAwarenessForTests()
  setSettingsStorageForTests(undefined)
})

describe('screen awareness lifecycle', () => {
  it('checks installation without warming the vision model', async () => {
    settings()
    healthMock.mockResolvedValue(health(false))

    const status = await refreshScreenAwarenessStatus()

    expect(healthMock).toHaveBeenCalledOnce()
    expect(healthMock).toHaveBeenCalledWith('qwen3-vl:4b', undefined)
    expect(status).toMatchObject({
      enabled: true,
      phase: 'ready',
      visionReady: true,
      visionWarm: false,
      message: expect.stringContaining('installed and idle')
    })
  })

  it('reports a loaded vision model as warm', async () => {
    settings()
    healthMock.mockResolvedValue(health(true))

    await expect(refreshScreenAwarenessStatus()).resolves.toMatchObject({
      phase: 'ready',
      visionReady: true,
      visionWarm: true,
      processor: 'gpu',
      message: expect.stringContaining('loaded and ready')
    })
  })

  it('does not query Ollama while screen awareness is disabled', async () => {
    settings(false)

    await expect(refreshScreenAwarenessStatus()).resolves.toMatchObject({
      enabled: false,
      phase: 'off',
      visionReady: false,
      visionWarm: false
    })
    expect(healthMock).not.toHaveBeenCalled()
    expect(getScreenAwarenessStatus().message).toBe('Screen awareness is off.')
  })
})
