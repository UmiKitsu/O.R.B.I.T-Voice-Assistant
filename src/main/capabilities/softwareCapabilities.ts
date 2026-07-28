import { z } from 'zod'
import { validateAbsolutePath } from '../services/filesystemService'
import {
  startSoftwareInstaller,
  type InstallerLauncher
} from '../services/softwareInstallService'
import type { CapabilityRegistry } from './capabilityRegistry'
import { actionResultSchema } from './resultSchemas'

export function registerSoftwareCapabilities(
  registry: CapabilityRegistry,
  installerLauncher?: InstallerLauncher
): void {
  const parameters = z
    .object({
      installerPath: z
        .string()
        .trim()
        .min(3)
        .max(1_024)
        .refine((value) => validateAbsolutePath(value) !== null, 'An absolute installer path is required.')
    })
    .strict()

  registry.register(
    {
      name: 'software.install',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ installerPath }) =>
        `Start the local installer ${installerPath}. Windows may request UAC approval.`,
      execute: ({ installerPath }) => startSoftwareInstaller(installerPath, installerLauncher)
    },
    parameters,
    actionResultSchema(z.object({ installerPath: z.string() }).strict())
  )
}
