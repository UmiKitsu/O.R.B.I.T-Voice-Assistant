import type { ZodType } from 'zod'
import type { CapabilityDefinition, CapabilityRisk } from './capabilityTypes'

export type RegisteredCapability = {
  name: string
  risk: CapabilityRisk
  timeoutMs: number
  parameterSchema: ZodType
  resultSchema: ZodType
  confirmationSummary?: (parameters: unknown) => string
  execute: (parameters: unknown, signal: AbortSignal) => Promise<unknown>
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>()

  register<TParameters, TResult>(
    definition: CapabilityDefinition<TParameters, TResult>,
    parameterSchema: ZodType<TParameters>,
    resultSchema: ZodType<TResult>
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
      resultSchema,
      confirmationSummary: definition.confirmationSummary
        ? (parameters): string => definition.confirmationSummary?.(parameters as TParameters) ?? ''
        : undefined,
      execute: async (parameters, signal): Promise<unknown> =>
        resultSchema.parse(await definition.execute(parameters as TParameters, signal))
    })
  }

  get(name: string): RegisteredCapability | undefined {
    return this.capabilities.get(name)
  }

  list(): readonly RegisteredCapability[] {
    return [...this.capabilities.values()]
  }
}
