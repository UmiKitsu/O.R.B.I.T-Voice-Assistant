import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AssistantProgress, OllamaHealth } from '../../shared/types'
import { checkConnection, warmConnection, type OllamaProgressCallback } from './ollamaService'

const STARTUP_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 500
const PREPARATION_RESULT_CACHE_MS = 30_000

type ConnectionChecker = () => Promise<OllamaHealth>
type OllamaLauncher = (executablePath: string) => Promise<void>

export type OllamaStartupDependencies = {
  check?: ConnectionChecker
  resolveExecutable?: () => Promise<string | null>
  launch?: OllamaLauncher
  delay?: (milliseconds: number) => Promise<void>
  now?: () => number
}

export type OllamaPreparationDependencies = {
  ensure?: () => Promise<boolean>
  check?: ConnectionChecker
  warm?: (signal?: AbortSignal, onProgress?: OllamaProgressCallback) => Promise<OllamaHealth>
}

type SharedOllamaPreparation = {
  promise: Promise<OllamaHealth>
  subscribers: Set<OllamaProgressCallback>
  latestProgress?: AssistantProgress
}

let sharedPreparation: SharedOllamaPreparation | null = null
let lastSuccessfulPreparation: { health: OllamaHealth; expiresAt: number } | null = null

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function fixedOllamaPaths(): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? ''

  return [
    localAppData ? join(localAppData, 'Programs', 'Ollama', 'ollama app.exe') : '',
    localAppData ? join(localAppData, 'Ollama', 'ollama app.exe') : '',
    programFiles ? join(programFiles, 'Ollama', 'ollama app.exe') : ''
  ].filter(Boolean)
}

function ollamaShortcutPaths(): string[] {
  const appData = process.env.APPDATA ?? ''
  const programData = process.env.PROGRAMDATA ?? ''

  return [
    appData ? join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ollama.lnk') : '',
    appData
      ? join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ollama', 'Ollama.lnk')
      : '',
    programData
      ? join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Ollama.lnk')
      : ''
  ].filter(Boolean)
}

function isTrustedOllamaApp(path: string): boolean {
  return basename(path).toLocaleLowerCase() === 'ollama app.exe'
}

export async function resolveOllamaAppExecutable(): Promise<string | null> {
  if (process.platform !== 'win32') return null

  for (const candidate of fixedOllamaPaths()) {
    if (isTrustedOllamaApp(candidate) && (await pathExists(candidate))) return candidate
  }

  for (const shortcutPath of ollamaShortcutPaths()) {
    if (!(await pathExists(shortcutPath))) continue

    try {
      const { shell } = await import('electron')
      const target = shell.readShortcutLink(shortcutPath).target
      if (isTrustedOllamaApp(target) && (await pathExists(target))) return target
    } catch {
      // Ignore malformed or inaccessible shortcuts and continue safe discovery.
    }
  }

  return null
}

export const launchOllamaApp: OllamaLauncher = (executablePath) =>
  new Promise((resolve, reject) => {
    if (!isTrustedOllamaApp(executablePath)) {
      reject(new Error('The resolved Ollama application is invalid.'))
      return
    }

    const child = spawn(executablePath, [], {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

export async function ensureOllamaRunning(
  dependencies: OllamaStartupDependencies = {}
): Promise<boolean> {
  const check = dependencies.check ?? checkConnection
  const initialHealth = await check()
  if (initialHealth.connected) return true

  const resolveExecutable = dependencies.resolveExecutable ?? resolveOllamaAppExecutable
  const executablePath = await resolveExecutable()
  if (!executablePath) return false

  try {
    await (dependencies.launch ?? launchOllamaApp)(executablePath)
  } catch {
    return false
  }

  const wait = dependencies.delay ?? delay
  const now = dependencies.now ?? Date.now
  const deadline = now() + STARTUP_TIMEOUT_MS

  while (now() < deadline) {
    await wait(POLL_INTERVAL_MS)
    if ((await check()).connected) return true
  }

  return false
}

function publishPreparationProgress(progress: AssistantProgress): void {
  const current = sharedPreparation
  if (!current) return
  current.latestProgress = progress
  for (const subscriber of current.subscribers) {
    try {
      subscriber(progress)
    } catch {
      // A closed renderer must not interrupt the shared startup operation.
    }
  }
}

export function prepareOllama(
  onProgress?: OllamaProgressCallback,
  dependencies: OllamaPreparationDependencies = {}
): Promise<OllamaHealth> {
  if (
    !sharedPreparation &&
    lastSuccessfulPreparation &&
    lastSuccessfulPreparation.expiresAt > Date.now()
  ) {
    onProgress?.({
      phase: 'checking',
      message: 'The local Ollama service is already prepared.',
      elapsedMs: 0,
      ...(lastSuccessfulPreparation.health.activeModel
        ? { model: lastSuccessfulPreparation.health.activeModel }
        : {})
    })
    return Promise.resolve(lastSuccessfulPreparation.health)
  }

  if (!sharedPreparation) {
    const subscribers = new Set<OllamaProgressCallback>()
    const ensure = dependencies.ensure ?? (() => ensureOllamaRunning())
    const check = dependencies.check ?? checkConnection
    const warm = dependencies.warm ?? warmConnection

    const preparation: SharedOllamaPreparation = {
      subscribers,
      promise: Promise.resolve({
        connected: false,
        modelInstalled: false,
        models: [],
        configuredModel: '',
        fallbackActive: false,
        warm: false
      })
    }
    sharedPreparation = preparation
    publishPreparationProgress({
      phase: 'checking',
      message: 'Starting or checking the local Ollama service.',
      elapsedMs: 0
    })

    preparation.promise = (async () => {
      try {
        const running = await ensure()
        if (!running) return check()
        return warm(undefined, publishPreparationProgress)
      } catch {
        return check()
      }
    })()
      .then((health) => {
        if (health.connected && health.modelInstalled) {
          lastSuccessfulPreparation = {
            health,
            expiresAt: Date.now() + PREPARATION_RESULT_CACHE_MS
          }
        }
        return health
      })
      .finally(() => {
        if (sharedPreparation === preparation) sharedPreparation = null
      })
  }

  const preparation = sharedPreparation
  if (!preparation) return prepareOllama(onProgress, dependencies)
  if (onProgress) {
    preparation.subscribers.add(onProgress)
    if (preparation.latestProgress) onProgress(preparation.latestProgress)
  }

  return preparation.promise.finally(() => {
    if (onProgress) preparation.subscribers.delete(onProgress)
  })
}

export function resetOllamaPreparationForTests(): void {
  sharedPreparation = null
  lastSuccessfulPreparation = null
}
