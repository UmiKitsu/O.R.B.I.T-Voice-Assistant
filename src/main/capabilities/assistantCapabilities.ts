import { z } from 'zod'
import type { ActionResult, AssistantEffect } from '../../shared/types'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const noParametersSchema = z.object({}).strict()
const assistantEffectDataSchema = z
  .object({
    effect: z.enum(['stop-speaking', 'disable'])
  })
  .strict()

type AssistantEffectData = {
  effect: AssistantEffect
}

function controlCapability(
  name: string,
  message: string,
  effect: AssistantEffect
): CapabilityDefinition<Record<string, never>, ActionResult<AssistantEffectData>> {
  return {
    name,
    risk: 'automatic',
    timeoutMs: 1_000,
    execute: async (_parameters, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return {
        ok: true,
        message,
        data: { effect }
      }
    }
  }
}

export function registerAssistantCapabilities(registry: CapabilityRegistry): void {
  registry.register(
    controlCapability('assistant.stopSpeaking', 'Speech stopped.', 'stop-speaking'),
    noParametersSchema,
    actionResultSchema(assistantEffectDataSchema)
  )
  registry.register(
    controlCapability('assistant.disable', 'T.I.T.A.N. disabled.', 'disable'),
    noParametersSchema,
    actionResultSchema(assistantEffectDataSchema)
  )
}
