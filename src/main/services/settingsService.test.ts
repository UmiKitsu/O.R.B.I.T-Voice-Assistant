import { afterEach, describe, expect, it } from 'vitest'
import type { OrbitSettings } from '../../shared/types'
import {
  DEFAULT_ORBIT_SETTINGS,
  getSettings,
  parseLegacySettingsForImport,
  parseSettingsJson,
  setSettingsStorageForTests,
  orbitSettingsPatchSchema,
  orbitSettingsSchema,
  updateSettings
} from './settingsService'

type MemoryStorage = {
  store: unknown
  set(settings: OrbitSettings): void
}

function memoryStorage(initial: unknown): MemoryStorage {
  return {
    store: initial,
    set(settings) {
      this.store = settings
    }
  }
}

afterEach(() => {
  setSettingsStorageForTests(undefined)
})

describe('settings validation', () => {
  it('accepts UTF-8 BOM-prefixed settings JSON', () => {
    expect(parseSettingsJson('\uFEFF{"speechEngine":"kokoro"}')).toEqual({
      speechEngine: 'kokoro'
    })
  })

  it('accepts the complete defaults and strict partial updates', () => {
    expect(orbitSettingsSchema.safeParse(DEFAULT_ORBIT_SETTINGS).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ speechVolume: 0.4 }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ speechEngine: 'kokoro' }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ speechEngine: 'windows' }).success).toBe(false)
    expect(orbitSettingsPatchSchema.safeParse({ kokoroVoice: 'bm_george' }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ kokoroVoice: 'unknown' }).success).toBe(false)
    expect(orbitSettingsPatchSchema.safeParse({ recognitionLanguage: 'en' }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ wakeRecognitionMode: 'hybrid' }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ wakeRecognitionMode: 'cloud' }).success).toBe(false)
    expect(orbitSettingsPatchSchema.safeParse({ recognitionLanguage: 'tl' }).success).toBe(false)
    expect(orbitSettingsPatchSchema.safeParse({ spotifyClientId: 'abc123' }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ spotifyPlaybackMode: 'desktop' }).success).toBe(
      true
    )
    expect(orbitSettingsPatchSchema.safeParse({ spotifyPlaybackMode: 'web-api' }).success).toBe(
      true
    )
    expect(orbitSettingsPatchSchema.safeParse({ spotifyPlaybackMode: 'legacy' }).success).toBe(
      false
    )
    expect(
      orbitSettingsPatchSchema.safeParse({ preferredMusicProvider: 'youtube' }).success
    ).toBe(true)
    expect(
      orbitSettingsPatchSchema.safeParse({ preferredMusicProvider: 'soundcloud' }).success
    ).toBe(false)
    expect(orbitSettingsPatchSchema.safeParse({ musicFallbackEnabled: false }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ unexpected: true }).success).toBe(false)
    expect(
      orbitSettingsPatchSchema.safeParse({ ollamaBaseUrl: 'http://token@localhost:11434' }).success
    ).toBe(false)
    expect(orbitSettingsPatchSchema.safeParse({ ollamaBaseUrl: 'file:///C:/ollama' }).success).toBe(
      false
    )
    expect(orbitSettingsPatchSchema.safeParse({ confirmationTimeoutSeconds: 301 }).success).toBe(
      false
    )
    expect(
      orbitSettingsPatchSchema.safeParse({ applicationAliases: { chrome: [''] } }).success
    ).toBe(false)
  })

  it('imports only valid legacy settings and applies current migrations', () => {
    const {
      recognitionLanguage: _recognitionLanguage,
      wakeRecognitionMode: _wakeRecognitionMode,
      speechEngine: _speechEngine,
      kokoroVoice: _kokoroVoice,
      ...legacy
    } = DEFAULT_ORBIT_SETTINGS
    void _recognitionLanguage
    void _wakeRecognitionMode
    void _speechEngine
    void _kokoroVoice
    expect(parseLegacySettingsForImport({ ...legacy, speechVolume: 0.7 })).toEqual({
      ...DEFAULT_ORBIT_SETTINGS,
      speechVolume: 0.7
    })
    expect(parseLegacySettingsForImport({ ...legacy, speechVolume: 3 })).toBeUndefined()
    expect(parseLegacySettingsForImport('not settings')).toBeUndefined()
  })

  it('resets invalid loaded settings before returning them', () => {
    const storage = memoryStorage({ ...DEFAULT_ORBIT_SETTINGS, speechVolume: 2 })
    setSettingsStorageForTests(storage)

    expect(getSettings()).toEqual(DEFAULT_ORBIT_SETTINGS)
    expect(storage.store).toEqual(DEFAULT_ORBIT_SETTINGS)
  })

  it('persists valid patches and rejects invalid values', () => {
    const storage = memoryStorage({ ...DEFAULT_ORBIT_SETTINGS })
    setSettingsStorageForTests(storage)

    expect(updateSettings({ speechRate: 1.4 })?.speechRate).toBe(1.4)
    expect((storage.store as OrbitSettings).speechRate).toBe(1.4)
    expect(updateSettings({ confirmationTimeoutSeconds: 1 })).toBeNull()
    expect((storage.store as OrbitSettings).confirmationTimeoutSeconds).toBe(20)
  })

  it('adds current recognition, speech, and music defaults to existing settings', () => {
    const {
      recognitionLanguage: _recognitionLanguage,
      wakeRecognitionMode: _wakeRecognitionMode,
      speechEngine: _speechEngine,
      kokoroVoice: _kokoroVoice,
      ...legacy
    } = DEFAULT_ORBIT_SETTINGS
    void _recognitionLanguage
    void _wakeRecognitionMode
    void _speechEngine
    void _kokoroVoice
    const storage = memoryStorage({ ...legacy, speechVolume: 0.6 })
    setSettingsStorageForTests(storage)

    expect(getSettings()).toMatchObject({
      recognitionLanguage: 'auto',
      wakeRecognitionMode: 'hybrid',
      speechEngine: 'kokoro',
      kokoroVoice: 'bm_george',
      spotifyClientId: '',
      spotifyPlaybackMode: 'desktop',
      preferredMusicProvider: 'spotify',
      musicFallbackEnabled: true
    })
    expect(storage.store).toEqual({ ...DEFAULT_ORBIT_SETTINGS, speechVolume: 0.6 })
  })

  it('migrates the removed Windows speech option to Kokoro without resetting other settings', () => {
    const storage = memoryStorage({
      ...DEFAULT_ORBIT_SETTINGS,
      speechEngine: 'windows',
      speechVolume: 0.45,
      ollamaModel: 'qwen3:8b'
    })
    setSettingsStorageForTests(storage)

    expect(getSettings()).toMatchObject({
      speechEngine: 'kokoro',
      speechVolume: 0.45,
      ollamaModel: 'qwen3:8b'
    })
    expect(storage.store).toMatchObject({ speechEngine: 'kokoro', speechVolume: 0.45 })
  })

  it('preserves an existing Ollama model choice while adding speech defaults', () => {
    const {
      speechEngine: _speechEngine,
      kokoroVoice: _kokoroVoice,
      ...legacy
    } = DEFAULT_ORBIT_SETTINGS
    void _speechEngine
    void _kokoroVoice
    const storage = memoryStorage({ ...legacy, ollamaModel: 'qwen3:8b' })
    setSettingsStorageForTests(storage)

    expect(getSettings()).toMatchObject({
      ollamaModel: 'qwen3:8b',
      speechEngine: 'kokoro',
      kokoroVoice: 'bm_george'
    })
  })

  it('removes deprecated automatic voice flags without resetting other settings', () => {
    const storage = memoryStorage({
      ...DEFAULT_ORBIT_SETTINGS,
      speechEnabled: false,
      wakeWordEnabled: false,
      speechVolume: 0.4
    })
    setSettingsStorageForTests(storage)

    expect(getSettings().speechVolume).toBe(0.4)
    expect(storage.store).toEqual({ ...DEFAULT_ORBIT_SETTINGS, speechVolume: 0.4 })
  })
})
