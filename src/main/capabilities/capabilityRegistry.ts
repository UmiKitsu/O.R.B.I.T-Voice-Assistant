import type { ZodType } from 'zod'
import type { CapabilityDefinition, CapabilityRisk } from './capabilityTypes'

export type RegisteredCapability = {
  name: string
  risk: CapabilityRisk
  timeoutMs: number
  parameterSchema: ZodType
  execute: (parameters: unknown, signal: AbortSignal) => Promise<unknown>
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>()

  register<TParameters, TResult>(
    definition: CapabilityDefinition<TParameters, TResult>,
    parameterSchema: ZodType<TParameters>
  ): void {
    if (this.capabilities.has(definition.name)) {
      throw new Error(`Capability "${definition.name}" is already registered.`)
    }

    if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs <= 0) {
      throw new Error(`Capability "${definition.name}" must have a positive integer timeout.`)
    }

    this.capabilities.set(definition.name, {
      name: definition.name,
      risk: definition.risk,
      timeoutMs: definition.timeoutMs,
      parameterSchema,
      execute: async (parameters, signal): Promise<unknown> =>
        definition.execute(parameters as TParameters, signal)
    })
  }

  get(name: string): RegisteredCapability | undefined {
    return this.capabilities.get(name)
  }
}
