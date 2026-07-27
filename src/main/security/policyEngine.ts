import type { ZodError } from 'zod'
import type { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import { logOperationalEvent } from '../services/loggerService'
import { blockedCapabilities } from './blockedCapabilities'
import { ConfirmationManager, type PendingConfirmation } from './confirmationManager'
import { confirmationRequiredCapabilities } from './confirmationRequiredCapabilities'

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

type ConfirmationTimeout = number | (() => number)

export class PolicyEngine {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly confirmations: ConfirmationManager,
    private readonly confirmationTimeout: ConfirmationTimeout = 20_000
  ) {}

  async evaluateAndExecute(request: PolicyRequest): Promise<PolicyResult> {
    // Only the capability name and outcomes are audited. Parameters and summaries may be private.
    logOperationalEvent({ event: 'capability.requested', capability: request.capability })

    // This order is security-sensitive. A model-provided request cannot alter it.
    if (blockedCapabilities.has(request.capability)) {
      this.logPolicyDecision(request.capability, 'blocked')
      return {
        status: 'blocked',
        message: 'That action is blocked because it would violate T.I.T.A.N. safety policy.'
      }
    }

    const capability = this.registry.get(request.capability)
    if (!capability) {
      this.logPolicyDecision(request.capability, 'blocked')
      return { status: 'not-registered', message: 'That action is not supported.' }
    }

    const parsedParameters = capability.parameterSchema.safeParse(request.parameters)
    if (!parsedParameters.success) {
      this.logPolicyDecision(request.capability, 'blocked')
      return {
        status: 'invalid-parameters',
        message: 'The action parameters are invalid.',
        validationErrors: parsedParameters.error.issues
      }
    }

    const parameters = parsedParameters.data
    const requiresConfirmation =
      capability.risk === 'confirmation-required' ||
      confirmationRequiredCapabilities.has(capability.name)

    if (capability.risk === 'blocked') {
      this.logPolicyDecision(request.capability, 'blocked')
      return {
        status: 'blocked',
        message: 'That action is blocked because it would violate T.I.T.A.N. safety policy.'
      }
    }

    if (requiresConfirmation && !request.confirmationRequestId) {
      this.logPolicyDecision(request.capability, 'allowed')
      return {
        status: 'confirmation-required',
        confirmation: this.confirmations.create({
          capability: capability.name,
          parameters,
          summary: capability.confirmationSummary?.(parameters) ?? request.summary,
          timeoutMs: this.getConfirmationTimeoutMs()
        })
      }
    }

    if (
      requiresConfirmation &&
      !this.confirmations.consume(request.confirmationRequestId ?? '', capability.name, parameters)
    ) {
      this.logPolicyDecision(request.capability, 'blocked')
      return {
        status: 'confirmation-invalid',
        message: 'The confirmation is missing, expired, cancelled, already used, or does not match.'
      }
    }

    this.logPolicyDecision(request.capability, 'allowed')
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
      logOperationalEvent({
        event: 'action.completed',
        capability: request.capability,
        outcome: this.actionSucceeded(result) ? 'succeeded' : 'failed'
      })
      return { status: 'executed', result }
    } catch (error: unknown) {
      logOperationalEvent({
        event: 'action.completed',
        capability: request.capability,
        outcome: 'failed'
      })
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

  private getConfirmationTimeoutMs(): number {
    return typeof this.confirmationTimeout === 'function'
      ? this.confirmationTimeout()
      : this.confirmationTimeout
  }

  private logPolicyDecision(capability: string, decision: 'allowed' | 'blocked'): void {
    logOperationalEvent({ event: 'policy.decided', capability, decision })
  }

  private actionSucceeded(result: unknown): boolean {
    return (
      typeof result === 'object' &&
      result !== null &&
      'ok' in result &&
      (result as { ok?: unknown }).ok === true
    )
  }
}
