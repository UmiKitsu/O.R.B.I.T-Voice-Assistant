import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ActionResult } from '../../shared/types'
import { validateAbsolutePath } from './filesystemService'

export type InstallerLauncher = (executable: string, args: readonly string[]) => Promise<void>

export const launchInstaller: InstallerLauncher = (executable, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
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

export async function startSoftwareInstaller(
  requestedInstallerPath: string,
  launcher: InstallerLauncher = launchInstaller
): Promise<ActionResult<{ installerPath: string }>> {
  const installerPath = validateAbsolutePath(requestedInstallerPath)
  if (!installerPath) {
    return {
      ok: false,
      code: 'INVALID_INSTALLER_PATH',
      message: 'Use the complete absolute path to a local .exe or .msi installer.',
      recoverable: true
    }
  }

  const extension = extname(installerPath).toLocaleLowerCase()
  if (extension !== '.exe' && extension !== '.msi') {
    return {
      ok: false,
      code: 'UNSUPPORTED_INSTALLER',
      message: 'Only local .exe and .msi installers are supported.',
      recoverable: true
    }
  }

  try {
    if (!(await stat(installerPath)).isFile()) throw new Error('Not a file')
  } catch {
    return {
      ok: false,
      code: 'INSTALLER_NOT_FOUND',
      message: 'The installer file was not found.',
      recoverable: true
    }
  }

  try {
    if (extension === '.msi') await launcher('msiexec.exe', ['/i', installerPath])
    else await launcher(installerPath, [])
    return {
      ok: true,
      message: `Started ${basename(installerPath)}. Review and approve the installer and any Windows UAC prompt yourself.`,
      data: { installerPath }
    }
  } catch {
    return {
      ok: false,
      code: 'INSTALLER_LAUNCH_FAILED',
      message: `${basename(installerPath)} could not be started.`,
      recoverable: true
    }
  }
}
