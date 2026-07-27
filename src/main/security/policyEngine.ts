import type { ZodError } from 'zod'
import type { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import { blockedCapabilities } from './blockedCapabilities'
import { ConfirmationManager, type PendingConfirmation } from './confirmationManager'

export type PolicyRequest = {
  capability: string
  parameters: unknown
  summary: string
  confirmationRequestId?: string
}

export type PolicyResult =
  | { status: 'executed'; result: unknown }
  | { status: 'confirmation-required'; confirmation: PendingConfirmation }
  | {
      status:
        | 'blocked'
        | 'not-registered'
        | 'invalid-parameters'
        | 'confirmation-invalid'
        | 'timed-out'
        | 'execution-failed'
      message: string
      validationErrors?: ZodError['issues']
    }

class CapabilityTimeoutError extends Error {}

export class PolicyEngine {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly confirmations: ConfirmationManager,
    private readonly confirmationTimeoutMs = 20_000
  ) {}

  async evaluateAndExecute(request: PolicyRequest): Promise<PolicyResult> {
    // This order is security-sensitive. A model-provided request cannot alter it.
    if (blockedCapabilities.has(request.capability)) {
      return {
        status: 'blocked',
        message: 'That action is blocked because it would violate T.I.T.A.N. safety policy.'
      }
    }

    const capability = this.registry.get(request.capability)
    if (!capability) {
      return { status: 'not-registered', message: 'That action is not supported.' }
    }

    const parsedParameters = capability.parameterSchema.safeParse(request.parameters)
    if (!parsedParameters.success) {
      return {
        status: 'invalid-parameters',
        message: 'The action parameters are invalid.',
        validationErrors: parsedParameters.error.issues
      }
    }

    const parameters = parsedParameters.data

    if (capability.risk === 'blocked') {
      return {
        status: 'blocked',
        message: 'That action is blocked because it would violate T.I.T.A.N. safety policy.'
      }
    }

    if (capability.risk === 'confirmation-required' && !request.confirmationRequestId) {
      return {
        status: 'confirmation-required',
        confirmation: this.confirmations.create({
          capability: capability.name,
          parameters,
          summary: capability.confirmationSummary?.(parameters) ?? request.summary,
          timeoutMs: this.confirmationTimeoutMs
        })
      }
    }

    if (
      capability.risk === 'confirmation-required' &&
      !this.confirmations.consume(request.confirmationRequestId ?? '', capability.name, parameters)
    ) {
      return {
        status: 'confirmation-invalid',
        message: 'The confirmation is missing, expired, cancelled, already used, or does not match.'
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), capability.timeoutMs)
    const timeoutFailure = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new CapabilityTimeoutError('Capability execution timed out.')),
        { once: true }
      )
    })

    try {
      const result = await Promise.race([
        capability.execute(parameters, controller.signal),
        timeoutFailure
      ])
      return { status: 'executed', result }
    } catch (error: unknown) {
      if (error instanceof CapabilityTimeoutError) {
        return { status: 'timed-out', message: 'The action timed out.' }
      }

      return {
        status: 'execution-failed',
        message: error instanceof Error ? error.message : 'The action failed.'
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  approveConfirmation(requestId: string): boolean {
    return this.confirmations.confirm(requestId)
  }

  cancelConfirmation(requestId: string): boolean {
    return this.confirmations.cancel(requestId)
  }
}
