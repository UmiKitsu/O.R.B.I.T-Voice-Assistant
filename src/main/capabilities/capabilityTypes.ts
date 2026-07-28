export type CapabilityRisk = 'automatic' | 'confirmation-required' | 'pin-required' | 'blocked'

export type CapabilityDefinition<TParameters, TResult> = {
  name: string
  risk: CapabilityRisk
  timeoutMs: number
  confirmationSummary?: (parameters: TParameters) => string
  execute: (parameters: TParameters, signal: AbortSignal) => Promise<TResult>
}
