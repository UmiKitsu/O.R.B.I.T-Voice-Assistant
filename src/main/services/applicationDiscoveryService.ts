import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionResult } from '../../shared/types'

export type ResolvedApplication = {
  id: string
  displayName: string
  executable: string
}

export type ApplicationLauncher = (application: ResolvedApplication) => Promise<void>

type ApplicationCandidate = ResolvedApplication & {
  aliases: readonly string[]
  requiresExistingPath: boolean
}

function candidatePaths(...segments: string[]): string[] {
  return segments.filter((path) => path.length > 0)
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
      requiresExistingPath: false
    },
    {
      id: 'explorer',
      displayName: 'File Explorer',
      executable: 'explorer.exe',
      aliases: ['file explorer', 'explorer'],
      requiresExistingPath: false
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
      requiresExistingPath: true
    })),
    ...candidatePaths(appData ? join(appData, 'Spotify', 'Spotify.exe') : '').map((executable) => ({
      id: 'spotify',
      displayName: 'Spotify',
      executable,
      aliases: ['spotify', 'music'],
      requiresExistingPath: true
    })),
    ...candidatePaths(
      localAppData ? join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe') : '',
      programFiles ? join(programFiles, 'Microsoft VS Code', 'Code.exe') : ''
    ).map((executable) => ({
      id: 'vscode',
      displayName: 'Visual Studio Code',
      executable,
      aliases: ['visual studio code', 'vs code', 'vscode', 'code editor'],
      requiresExistingPath: true
    }))
  ]
}

function normalizeApplicationName(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

export function resolveApplication(value: string): ResolvedApplication | null {
  const requestedName = normalizeApplicationName(value)
  const candidate = knownApplications().find(
    (application) =>
      application.aliases.includes(requestedName) &&
      (!application.requiresExistingPath || existsSync(application.executable))
  )

  if (!candidate) return null
  return {
    id: candidate.id,
    displayName: candidate.displayName,
    executable: candidate.executable
  }
}

export const launchResolvedApplication: ApplicationLauncher = (application) =>
  new Promise((resolve, reject) => {
    const child = spawn(application.executable, [], {
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
      message: `I could not find ${applicationName} in the safe application registry.`,
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
