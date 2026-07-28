import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { ActionResult } from '../../shared/types'
import { getSettings } from './settingsService'

export type ResolvedApplication = {
  id: string
  displayName: string
  executable: string
  args?: readonly string[]
  source: 'built-in' | 'installed-shortcut' | 'known-path'
}

export type ApplicationLauncher = (application: ResolvedApplication) => Promise<void>

type ApplicationCandidate = ResolvedApplication & {
  aliases: readonly string[]
  requiresExistingPath: boolean
  priority: number
}

const SHORTCUT_CACHE_MS = 30_000
const MAX_DISCOVERY_ENTRIES = 6_000
let shortcutCache: { expiresAt: number; candidates: ApplicationCandidate[] } | null = null

function candidatePaths(...segments: string[]): string[] {
  return segments.filter((path) => path.length > 0)
}

function normalizeApplicationName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/\.(?:exe|lnk|url)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function aliasVariants(displayName: string): string[] {
  const normalized = normalizeApplicationName(displayName)
  const stripped = normalized
    .replace(/\b(?:desktop|application|app|launcher|player|client|shortcut|x64|x86)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...new Set([normalized, stripped].filter(Boolean))]
}

function knownApplications(): ApplicationCandidate[] {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const appData = process.env.APPDATA ?? ''
  const programFiles = process.env.ProgramFiles ?? ''
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? ''

  return [
    {
      id: 'calculator',
      displayName: 'Calculator',
      executable: 'calc.exe',
      aliases: ['calculator', 'calc'],
      requiresExistingPath: false,
      priority: 200,
      source: 'built-in'
    },
    {
      id: 'explorer',
      displayName: 'File Explorer',
      executable: 'explorer.exe',
      aliases: ['file explorer', 'explorer'],
      requiresExistingPath: false,
      priority: 200,
      source: 'built-in'
    },
    {
      id: 'powershell',
      displayName: 'PowerShell',
      executable: 'powershell.exe',
      aliases: ['powershell', 'windows powershell'],
      requiresExistingPath: false,
      priority: 200,
      source: 'built-in'
    },
    ...candidatePaths(
      programFiles ? join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      programFilesX86 ? join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
    ).map((executable) => ({
      id: 'chrome',
      displayName: 'Google Chrome',
      executable,
      aliases: ['google chrome', 'chrome', 'browser'],
      requiresExistingPath: true,
      priority: 180,
      source: 'known-path' as const
    })),
    ...candidatePaths(appData ? join(appData, 'Spotify', 'Spotify.exe') : '').map((executable) => ({
      id: 'spotify',
      displayName: 'Spotify',
      executable,
      aliases: ['spotify', 'music'],
      requiresExistingPath: true,
      priority: 180,
      source: 'known-path' as const
    })),
    ...candidatePaths(
      localAppData ? join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe') : '',
      programFiles ? join(programFiles, 'Microsoft VS Code', 'Code.exe') : ''
    ).map((executable) => ({
      id: 'vscode',
      displayName: 'Visual Studio Code',
      executable,
      aliases: ['visual studio code', 'vs code', 'vscode', 'code editor'],
      requiresExistingPath: true,
      priority: 180,
      source: 'known-path' as const
    }))
  ]
}

function shortcutRoots(): string[] {
  const appData = process.env.APPDATA ?? ''
  const programData = process.env.ProgramData ?? ''
  const userProfile = process.env.USERPROFILE ?? ''
  const publicProfile = process.env.PUBLIC ?? ''
  return candidatePaths(
    appData ? join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
    programData ? join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
    userProfile ? join(userProfile, 'Desktop') : '',
    publicProfile ? join(publicProfile, 'Desktop') : ''
  )
}

export function discoverShortcutApplications(roots = shortcutRoots()): ApplicationCandidate[] {
  const candidates: ApplicationCandidate[] = []
  let visitedEntries = 0

  const visit = (directory: string, depth: number): void => {
    if (depth > 10 || visitedEntries >= MAX_DISCOVERY_ENTRIES) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      visitedEntries += 1
      if (visitedEntries >= MAX_DISCOVERY_ENTRIES) return
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(fullPath, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      const extension = extname(entry.name).toLocaleLowerCase()
      if (extension !== '.lnk' && extension !== '.url') continue
      const displayName = basename(entry.name, extension).trim()
      if (!displayName) continue
      const aliases = aliasVariants(displayName)
      candidates.push({
        id: aliases.at(-1)?.replace(/\s+/g, '-') ?? normalizeApplicationName(displayName),
        displayName,
        executable: 'explorer.exe',
        args: [fullPath],
        aliases,
        requiresExistingPath: false,
        priority: 120,
        source: 'installed-shortcut'
      })
    }
  }

  for (const root of roots) visit(root, 0)
  return candidates
}

function cachedShortcutApplications(): ApplicationCandidate[] {
  const now = Date.now()
  if (shortcutCache && shortcutCache.expiresAt > now) return shortcutCache.candidates
  const candidates = process.platform === 'win32' ? discoverShortcutApplications() : []
  shortcutCache = { expiresAt: now + SHORTCUT_CACHE_MS, candidates }
  return candidates
}

function customAliases(candidate: ApplicationCandidate): string[] {
  const configured = getSettings().applicationAliases
  const directAliases = configured[candidate.id] ?? configured[candidate.displayName] ?? []
  return directAliases.map(normalizeApplicationName).filter(Boolean)
}

function matchScore(requested: string, candidate: ApplicationCandidate): number {
  const aliases = [...candidate.aliases.map(normalizeApplicationName), ...customAliases(candidate)]
  if (aliases.includes(requested)) return 1_000 + candidate.priority

  let score = 0
  for (const alias of aliases) {
    if (alias.startsWith(`${requested} `)) score = Math.max(score, 800)
    else if (requested.startsWith(`${alias} `)) score = Math.max(score, 700)
    else if (alias.includes(requested) && requested.length >= 4) score = Math.max(score, 600)
  }
  return score + (score > 0 ? candidate.priority : 0)
}

export function clearApplicationDiscoveryCache(): void {
  shortcutCache = null
}

export function listAvailableApplications(limit = 100): Array<Pick<ResolvedApplication, 'id' | 'displayName' | 'source'>> {
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const unique = new Map<string, Pick<ResolvedApplication, 'id' | 'displayName' | 'source'>>()
  for (const candidate of [...knownApplications(), ...cachedShortcutApplications()]) {
    if (candidate.requiresExistingPath && !existsSync(candidate.executable)) continue
    const key = `${candidate.id}\n${candidate.displayName}`.toLocaleLowerCase()
    if (!unique.has(key)) {
      unique.set(key, {
        id: candidate.id,
        displayName: candidate.displayName,
        source: candidate.source
      })
    }
    if (unique.size >= boundedLimit) break
  }
  return [...unique.values()].sort((left, right) => left.displayName.localeCompare(right.displayName))
}

export function resolveApplication(value: string): ResolvedApplication | null {
  const requestedName = normalizeApplicationName(value)
  if (!requestedName) return null

  const candidates = [...knownApplications(), ...cachedShortcutApplications()]
    .filter((candidate) => !candidate.requiresExistingPath || existsSync(candidate.executable))
    .map((candidate) => ({ candidate, score: matchScore(requestedName, candidate) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.candidate.displayName.localeCompare(right.candidate.displayName))

  const selected = candidates[0]?.candidate
  if (!selected) return null
  return {
    id: selected.id,
    displayName: selected.displayName,
    executable: selected.executable,
    ...(selected.args ? { args: [...selected.args] } : {}),
    source: selected.source
  }
}

export const launchResolvedApplication: ApplicationLauncher = (application) =>
  new Promise((resolve, reject) => {
    const child = spawn(application.executable, [...(application.args ?? [])], {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: false
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

export async function launchApplication(
  applicationName: string,
  launcher: ApplicationLauncher = launchResolvedApplication
): Promise<ActionResult<{ application: string }>> {
  const application = resolveApplication(applicationName)
  if (!application) {
    return {
      ok: false,
      code: 'APPLICATION_NOT_FOUND',
      message: `I could not find ${applicationName} in installed applications or Start Menu shortcuts.`,
      recoverable: true
    }
  }

  try {
    await launcher(application)
    return {
      ok: true,
      message: `Opening ${application.displayName}.`,
      data: { application: application.id }
    }
  } catch {
    return {
      ok: false,
      code: 'APPLICATION_LAUNCH_FAILED',
      message: `${application.displayName} could not be opened.`,
      recoverable: true
    }
  }
}
