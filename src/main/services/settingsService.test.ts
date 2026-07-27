import { afterEach, describe, expect, it } from 'vitest'
import type { TitanSettings } from '../../shared/types'
import {
  DEFAULT_TITAN_SETTINGS,
  getSettings,
  setSettingsStorageForTests,
  titanSettingsPatchSchema,
  titanSettingsSchema,
  updateSettings
} from './settingsService'

type MemoryStorage = {
  store: unknown
  set(settings: TitanSettings): void
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
    expect(titanSettingsSchema.safeParse(DEFAULT_TITAN_SETTINGS).success).toBe(true)
    expect(titanSettingsPatchSchema.safeParse({ speechVolume: 0.4 }).success).toBe(true)
    expect(titanSettingsPatchSchema.safeParse({ unexpected: true }).success).toBe(false)
    expect(
      titanSettingsPatchSchema.safeParse({ ollamaBaseUrl: 'http://token@localhost:11434' }).success
    ).toBe(false)
    expect(titanSettingsPatchSchema.safeParse({ ollamaBaseUrl: 'file:///C:/ollama' }).success).toBe(
      false
    )
    expect(titanSettingsPatchSchema.safeParse({ confirmationTimeoutSeconds: 301 }).success).toBe(
      false
    )
    expect(
      titanSettingsPatchSchema.safeParse({ applicationAliases: { chrome: [''] } }).success
    ).toBe(false)
  })

  it('resets invalid loaded settings before returning them', () => {
    const storage = memoryStorage({ ...DEFAULT_TITAN_SETTINGS, speechVolume: 2 })
    setSettingsStorageForTests(storage)

    expect(getSettings()).toEqual(DEFAULT_TITAN_SETTINGS)
    expect(storage.store).toEqual(DEFAULT_TITAN_SETTINGS)
  })

  it('persists valid patches and rejects invalid values', () => {
    const storage = memoryStorage({ ...DEFAULT_TITAN_SETTINGS })
    setSettingsStorageForTests(storage)

    expect(updateSettings({ speechRate: 1.4 })?.speechRate).toBe(1.4)
    expect((storage.store as TitanSettings).speechRate).toBe(1.4)
    expect(updateSettings({ confirmationTimeoutSeconds: 1 })).toBeNull()
    expect((storage.store as TitanSettings).confirmationTimeoutSeconds).toBe(20)
  })

  it('removes deprecated automatic voice flags without resetting other settings', () => {
    const storage = memoryStorage({
      ...DEFAULT_TITAN_SETTINGS,
      speechEnabled: false,
      wakeWordEnabled: false,
      speechVolume: 0.4
    })
    setSettingsStorageForTests(storage)

    expect(getSettings().speechVolume).toBe(0.4)
    expect(storage.store).toEqual({ ...DEFAULT_TITAN_SETTINGS, speechVolume: 0.4 })
  })
})
