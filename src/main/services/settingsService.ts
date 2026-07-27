import { app } from 'electron'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { OrbitSettings } from '../../shared/types'

export const KOKORO_VOICES = [
  'bm_george',
  'bm_lewis',
  'bm_daniel',
  'am_adam',
  'am_michael',
  'bf_emma',
  'af_heart'
] as const

const applicationAliasesSchema = z.record(
  z.string().trim().min(1).max(100),
  z.array(z.string().trim().min(1).max(100)).max(20)
)

export const orbitSettingsSchema = z
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
    speechEngine: z.enum(['kokoro', 'windows']),
    kokoroVoice: z.enum(KOKORO_VOICES),
    speechRate: z.number().min(0.5).max(2),
    speechVolume: z.number().min(0).max(1),
    launchAtStartup: z.boolean(),
    minimizeToTray: z.boolean(),
    saveConversationHistory: z.boolean(),
    confirmationTimeoutSeconds: z.number().int().min(5).max(300),
    applicationAliases: applicationAliasesSchema,
    recognitionLanguage: z.enum(['auto', 'en']),
    wakeRecognitionMode: z.enum(['hybrid', 'keyword-only'])
  })
  .strict()

export const orbitSettingsPatchSchema = orbitSettingsSchema.partial().strict()

export const DEFAULT_ORBIT_SETTINGS: Readonly<OrbitSettings> = Object.freeze({
  ollamaBaseUrl: 'http://localhost:11434',
  ollamaModel: 'qwen3.5:9b-q4_K_M',
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
  wakeRecognitionMode: 'hybrid'
})

type SettingsStorage = {
  store: unknown
  set(settings: OrbitSettings): void
}

let storage: SettingsStorage | undefined

function cloneSettings(settings: OrbitSettings): OrbitSettings {
  return {
    ...settings,
    applicationAliases: Object.fromEntries(
      Object.entries(settings.applicationAliases).map(([name, aliases]) => [name, [...aliases]])
    )
  }
}

export function migrateLegacySettings(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { value, changed: false }
  }

  const migrated = { ...(value as Record<string, unknown>) }
  let changed = 'speechEnabled' in migrated || 'wakeWordEnabled' in migrated
  delete migrated.speechEnabled
  delete migrated.wakeWordEnabled
  if (!('speechEngine' in migrated)) {
    migrated.speechEngine = 'kokoro'
    changed = true
  }
  if (!('kokoroVoice' in migrated)) {
    migrated.kokoroVoice = 'bm_george'
    changed = true
  }
  if (!('recognitionLanguage' in migrated)) {
    migrated.recognitionLanguage = 'auto'
    changed = true
  }
  if (!('wakeRecognitionMode' in migrated)) {
    migrated.wakeRecognitionMode = 'hybrid'
    changed = true
  }
  return { value: migrated, changed }
}

export function parseLegacySettingsForImport(value: unknown): OrbitSettings | undefined {
  const migrated = migrateLegacySettings(value)
  const parsed = orbitSettingsSchema.safeParse(migrated.value)
  return parsed.success ? cloneSettings(parsed.data) : undefined
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readLegacySettings(): Promise<OrbitSettings | undefined> {
  const candidates = [
    join(app.getPath('userData'), 'titan-settings.json'),
    join(app.getPath('appData'), 'T.I.T.A.N. Voice Assistant', 'titan-settings.json'),
    join(app.getPath('appData'), 'titan-voice-assistant', 'titan-settings.json')
  ]
  for (const candidate of candidates) {
    try {
      const parsedJson: unknown = JSON.parse(await readFile(candidate, 'utf8'))
      const parsedSettings = parseLegacySettingsForImport(parsedJson)
      if (parsedSettings) return parsedSettings
    } catch {
      // Ignore missing or invalid legacy files and continue through the fixed allowlist.
    }
  }
  return undefined
}

export async function initializeSettingsService(): Promise<void> {
  if (storage) return

  const userData = app.getPath('userData')
  const currentSettingsExist = await pathExists(join(userData, 'orbit-settings.json'))
  const importedSettings = currentSettingsExist ? undefined : await readLegacySettings()
  const { default: ElectronStore } = await import('electron-store')
  storage = new ElectronStore<OrbitSettings>({
    name: 'orbit-settings',
    cwd: userData,
    defaults: cloneSettings(DEFAULT_ORBIT_SETTINGS)
  })
  if (importedSettings) storage.set(importedSettings)
  getSettings()
}
export function getSettings(): OrbitSettings {
  if (!storage) return cloneSettings(DEFAULT_ORBIT_SETTINGS)
  const currentStorage = storage

  const migrated = migrateLegacySettings(currentStorage.store)
  const parsed = orbitSettingsSchema.safeParse(migrated.value)
  if (parsed.success) {
    if (migrated.changed) currentStorage.set(parsed.data)
    return cloneSettings(parsed.data)
  }

  const defaults = cloneSettings(DEFAULT_ORBIT_SETTINGS)
  currentStorage.set(defaults)
  return defaults
}

export function updateSettings(patch: unknown): OrbitSettings | null {
  const parsedPatch = orbitSettingsPatchSchema.safeParse(patch)
  if (!parsedPatch.success) return null

  const next = orbitSettingsSchema.safeParse({
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
