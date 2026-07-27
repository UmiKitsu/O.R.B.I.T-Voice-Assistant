export type CapabilityRisk = 'automatic' | 'confirmation-required' | 'blocked'

export type CapabilityDefinition<TParameters, TResult> = {
  name: string
  risk: CapabilityRisk
  timeoutMs: number
  execute: (parameters: TParameters, signal: AbortSignal) => Promise<TResult>
}
