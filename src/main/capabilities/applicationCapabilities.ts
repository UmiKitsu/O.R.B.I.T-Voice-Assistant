import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import {
  launchApplication,
  type ApplicationLauncher
} from '../services/applicationDiscoveryService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const applicationParametersSchema = z
  .object({
    application: z.string().trim().min(1).max(80)
  })
  .strict()

const applicationDataSchema = z.object({ application: z.string().min(1) }).strict()

type ApplicationParameters = z.infer<typeof applicationParametersSchema>
type ApplicationData = z.infer<typeof applicationDataSchema>

export function registerApplicationCapabilities(
  registry: CapabilityRegistry,
  launcher?: ApplicationLauncher
): void {
  const launch: CapabilityDefinition<ApplicationParameters, ActionResult<ApplicationData>> = {
    name: 'application.launch',
    risk: 'automatic',
    timeoutMs: 10_000,
    execute: async ({ application }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return launchApplication(application, launcher)
    }
  }

  registry.register(launch, applicationParametersSchema, actionResultSchema(applicationDataSchema))
}
