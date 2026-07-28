import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrbitSettings } from '../../shared/types'
import { getSettings } from './settingsService'
import {
  executeBrowserCommand,
  getBrowserStatus,
  resetBrowserBridgeServiceForTests
} from './browserBridgeService'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/OrbitTest'),
    getAppPath: vi.fn(() => 'C:/OrbitProject'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
  }
}))

vi.mock('./settingsService', () => ({
  getSettings: vi.fn()
}))

function settings(browserControlEnabled: boolean): OrbitSettings {
  return {
    ollamaBaseUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen3:8b',
    thinkMode: false,
    speechEngine: 'kokoro',
    kokoroVoice: 'bm_george',
    speechRate: 1,
    speechVolume: 1,
    launchAtStartup: false,
    minimizeToTray: false,
    saveConversationHistory: false,
    confirmationTimeoutSeconds: 20,
    applicationAliases: {},
    recognitionLanguage: 'auto',
    wakeRecognitionMode: 'hybrid',
    spotifyClientId: '',
    spotifyPlaybackMode: 'desktop',
    preferredMusicProvider: 'spotify',
    musicFallbackEnabled: true,
    browserControlEnabled,
    screenAwarenessEnabled: false,
    visionModel: 'qwen3-vl:4b'
  }
}

describe('browserBridgeService disconnected behavior', () => {
  beforeEach(() => {
    resetBrowserBridgeServiceForTests()
    vi.mocked(getSettings).mockReturnValue(settings(false))
  })

  it('returns a recoverable disabled result without exposing connection internals', async () => {
    await expect(executeBrowserCommand('browser.reload', {})).resolves.toEqual({
      ok: false,
      code: 'BROWSER_CONTROL_DISABLED',
      message: 'Browser control is disabled in Orbit settings.',
      recoverable: true
    })
    expect(getBrowserStatus()).toEqual({
      paired: false,
      connected: false,
      browser: 'chrome',
      phase: 'unpaired',
      pairingState: 'none',
      expectedExtensionId: 'bpnhommpdnofjjgbgjoehmdjglfglkje',
      siteAccessMode: 'restricted'
    })
    expect(JSON.stringify(getBrowserStatus())).not.toMatch(/secret|nonce|hmac/i)
  })

  it('returns a recoverable disconnected result when enabled but not paired', async () => {
    vi.mocked(getSettings).mockReturnValue(settings(true))
    await expect(executeBrowserCommand('browser.reload', {})).resolves.toMatchObject({
      ok: false,
      code: 'BROWSER_EXTENSION_DISCONNECTED',
      recoverable: true
    })
  })

  it('honors cancellation before settings or connection checks', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(executeBrowserCommand('browser.reload', {}, controller.signal)).resolves.toEqual({
      ok: false,
      code: 'ACTION_CANCELLED',
      message: 'The request was cancelled.',
      recoverable: true
    })
  })
})
