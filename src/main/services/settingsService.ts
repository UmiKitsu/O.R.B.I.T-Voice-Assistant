import { app } from 'electron'
import { z } from 'zod'
import type { TitanSettings } from '../../shared/types'

const applicationAliasesSchema = z.record(
  z.string().trim().min(1).max(100),
  z.array(z.string().trim().min(1).max(100)).max(20)
)

export const titanSettingsSchema = z
  .object({
    ollamaBaseUrl: z.url().refine((value) => {
      const url = new URL(value)
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
    }, 'The Ollama URL must be an HTTP or HTTPS base URL without credentials.'),
    ollamaModel: z.string().trim().min(1).max(200),
    thinkMode: z.boolean(),
    speechRate: z.number().min(0.5).max(2),
    speechVolume: z.number().min(0).max(1),
    launchAtStartup: z.boolean(),
    minimizeToTray: z.boolean(),
    saveConversationHistory: z.boolean(),
    confirmationTimeoutSeconds: z.number().int().min(5).max(300),
    applicationAliases: applicationAliasesSchema,
    recognitionLanguage: z.enum(['auto', 'en'])
  })
  .strict()

export const titanSettingsPatchSchema = titanSettingsSchema.partial().strict()

export const DEFAULT_TITAN_SETTINGS: Readonly<TitanSettings> = Object.freeze({
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3:8b',
  thinkMode: false,
  speechRate: 1,
  speechVolume: 1,
  launchAtStartup: false,
  minimizeToTray: false,
  saveConversationHistory: false,
  confirmationTimeoutSeconds: 20,
  applicationAliases: {},
  recognitionLanguage: 'auto'
})

type SettingsStorage = {
  store: unknown
  set(settings: TitanSettings): void
}

let storage: SettingsStorage | undefined

function cloneSettings(settings: TitanSettings): TitanSettings {
  return {
    ...settings,
    applicationAliases: Object.fromEntries(
      Object.entries(settings.applicationAliases).map(([name, aliases]) => [name, [...aliases]])
    )
  }
}

function migrateLegacySettings(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, changed: false }
  }

  const migrated = { ...(value as Record<string, unknown>) }
  let changed = 'speechEnabled' in migrated || 'wakeWordEnabled' in migrated
  delete migrated.speechEnabled
  delete migrated.wakeWordEnabled
  if (!('recognitionLanguage' in migrated)) {
    migrated.recognitionLanguage = 'auto'
    changed = true
  }
  return { value: migrated, changed }
}

export async function initializeSettingsService(): Promise<void> {
  if (storage) return

  const { default: ElectronStore } = await import('electron-store')
  storage = new ElectronStore<TitanSettings>({
    name: 'titan-settings',
    cwd: app.getPath('userData'),
    defaults: cloneSettings(DEFAULT_TITAN_SETTINGS)
  })
  getSettings()
}
export function getSettings(): TitanSettings {
  if (!storage) return cloneSettings(DEFAULT_TITAN_SETTINGS)
  const currentStorage = storage

  const migrated = migrateLegacySettings(currentStorage.store)
  const parsed = titanSettingsSchema.safeParse(migrated.value)
  if (parsed.success) {
    if (migrated.changed) currentStorage.set(parsed.data)
    return cloneSettings(parsed.data)
  }

  const defaults = cloneSettings(DEFAULT_TITAN_SETTINGS)
  currentStorage.set(defaults)
  return defaults
}

export function updateSettings(patch: unknown): TitanSettings | null {
  const parsedPatch = titanSettingsPatchSchema.safeParse(patch)
  if (!parsedPatch.success) return null

  const next = titanSettingsSchema.safeParse({
    ...getSettings(),
    ...parsedPatch.data
  })
  if (!next.success) return null

  storage?.set(next.data)
  return cloneSettings(next.data)
}

export function setSettingsStorageForTests(nextStorage: SettingsStorage | undefined): void {
  storage = nextStorage
}
