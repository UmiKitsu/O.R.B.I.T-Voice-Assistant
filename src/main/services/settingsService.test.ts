import { afterEach, describe, expect, it } from 'vitest'
import type { OrbitSettings } from '../../shared/types'
import {
  DEFAULT_ORBIT_SETTINGS,
  getSettings,
  parseLegacySettingsForImport,
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
  it('accepts the complete defaults and strict partial updates', () => {
    expect(orbitSettingsSchema.safeParse(DEFAULT_ORBIT_SETTINGS).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ speechVolume: 0.4 }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ recognitionLanguage: 'en' }).success).toBe(true)
    expect(orbitSettingsPatchSchema.safeParse({ recognitionLanguage: 'tl' }).success).toBe(false)
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
    const { recognitionLanguage: _recognitionLanguage, ...legacy } = DEFAULT_ORBIT_SETTINGS
    void _recognitionLanguage
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

  it('adds automatic recognition language to existing settings', () => {
    const { recognitionLanguage: _recognitionLanguage, ...legacy } = DEFAULT_ORBIT_SETTINGS
    void _recognitionLanguage
    const storage = memoryStorage({ ...legacy, speechVolume: 0.6 })
    setSettingsStorageForTests(storage)

    expect(getSettings().recognitionLanguage).toBe('auto')
    expect(storage.store).toEqual({ ...DEFAULT_ORBIT_SETTINGS, speechVolume: 0.6 })
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
