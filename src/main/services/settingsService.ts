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
    speechEnabled: z.boolean(),
    speechRate: z.number().min(0.5).max(2),
    speechVolume: z.number().min(0).max(1),
    wakeWordEnabled: z.boolean(),
    launchAtStartup: z.boolean(),
    minimizeToTray: z.boolean(),
    saveConversationHistory: z.boolean(),
    confirmationTimeoutSeconds: z.number().int().min(5).max(300),
    applicationAliases: applicationAliasesSchema
  })
  .strict()

export const titanSettingsPatchSchema = titanSettingsSchema.partial().strict()

export const DEFAULT_TITAN_SETTINGS: Readonly<TitanSettings> = Object.freeze({
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3:8b',
  thinkMode: false,
  speechEnabled: true,
  speechRate: 1,
  speechVolume: 1,
  wakeWordEnabled: false,
  launchAtStartup: false,
  minimizeToTray: false,
  saveConversationHistory: false,
  confirmationTimeoutSeconds: 20,
  applicationAliases: {}
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

  const parsed = titanSettingsSchema.safeParse(currentStorage.store)
  if (parsed.success) return cloneSettings(parsed.data)

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
