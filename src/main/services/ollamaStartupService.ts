import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { OllamaHealth } from '../../shared/types'
import { checkConnection } from './ollamaService'

const STARTUP_TIMEOUT_MS = 15_000
const POLL_INTERVAL_MS = 500

type ConnectionChecker = () => Promise<OllamaHealth>
type OllamaLauncher = (executablePath: string) => Promise<void>

export type OllamaStartupDependencies = {
  check?: ConnectionChecker
  resolveExecutable?: () => Promise<string | null>
  launch?: OllamaLauncher
  delay?: (milliseconds: number) => Promise<void>
  now?: () => number
}

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
