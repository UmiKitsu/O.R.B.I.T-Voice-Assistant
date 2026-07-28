import type { VisualTargetPreview } from '../../shared/types'

export type CapabilityRisk = 'automatic' | 'confirmation-required' | 'pin-required' | 'blocked'

export type CapabilityDefinition<TParameters, TResult> = {
  name: string
  risk: CapabilityRisk
  timeoutMs: number
  confirmationSummary?: (parameters: TParameters) => string
  confirmationVisualTarget?: (parameters: TParameters) => VisualTargetPreview | undefined
  execute: (parameters: TParameters, signal: AbortSignal) => Promise<TResult>
}
