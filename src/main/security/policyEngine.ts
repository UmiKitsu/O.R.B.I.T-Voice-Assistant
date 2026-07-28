import type { ZodError } from 'zod'
import type { ActionAuthorization } from '../../shared/types'
import type { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import { logOperationalEvent } from '../services/loggerService'
import { blockedCapabilities } from './blockedCapabilities'
import { ConfirmationManager, type PendingConfirmation } from './confirmationManager'
import { confirmationRequiredCapabilities } from './confirmationRequiredCapabilities'
import {
  getSecurityPinStatus,
  verifySecurityPin,
  type PinVerificationResult
} from './securityPinService'

export type PolicyRequest = {
  capability: string
  parameters: unknown
  summary: string
  confirmationRequestId?: string
  signal?: AbortSignal
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

type PinAuthorizer = {
  hasPin(): boolean
  verify(pin: string): Promise<PinVerificationResult>
}

const defaultPinAuthorizer: PinAuthorizer = {
  hasPin: () => getSecurityPinStatus().hasPin,
  verify: verifySecurityPin
}

export class PolicyEngine {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly confirmations: ConfirmationManager,
    private readonly confirmationTimeout: ConfirmationTimeout = 20_000,
    private readonly pinAuthorizer: PinAuthorizer = defaultPinAuthorizer
  ) {}

  async evaluateAndExecute(request: PolicyRequest): Promise<PolicyResult> {
    // Only capability names and outcomes are audited. Parameters and summaries may be private.
    logOperationalEvent({ event: 'capability.requested', capability: request.capability })

    if (blockedCapabilities.has(request.capability)) {
      this.logPolicyDecision(request.capability, 'blocked')
      return {
        status: 'blocked',
        message: 'That action remains blocked because it could bypass Orbit security controls.'
      }
    }

    const capability = this.registry.get(request.capability)
    if (!capability) {
      this.logPolicyDecision(request.capability, 'blocked')
      return { status: 'not-registered', message: 'That action is not supported yet.' }
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

    if (capability.risk === 'blocked') {
      this.logPolicyDecision(request.capability, 'blocked')
      return {
        status: 'blocked',
        message: 'That action remains blocked because it could bypass Orbit security controls.'
      }
    }

    const parameters = parsedParameters.data
    const authorization = this.requiredAuthorization(capability.name, capability.risk)

    if (authorization && !request.confirmationRequestId) {
      this.logPolicyDecision(request.capability, 'allowed')
      return {
        status: 'confirmation-required',
        confirmation: this.confirmations.create({
          capability: capability.name,
          parameters,
          summary: capability.confirmationSummary?.(parameters) ?? request.summary,
          timeoutMs:
            authorization === 'pin'
              ? Math.max(this.getConfirmationTimeoutMs(), 120_000)
              : this.getConfirmationTimeoutMs(),
          authorization,
          pinConfigured: authorization === 'pin' ? this.pinAuthorizer.hasPin() : true,
          ...(capability.confirmationVisualTarget
            ? { visualTarget: capability.confirmationVisualTarget(parameters) }
            : {})
        })
      }
    }

    if (
      authorization &&
      !this.confirmations.consume(request.confirmationRequestId ?? '', capability.name, parameters)
    ) {
      this.logPolicyDecision(request.capability, 'blocked')
      return {
        status: 'confirmation-invalid',
        message:
          'The authorization is missing, expired, cancelled, already used, or does not match.'
      }
    }

    this.logPolicyDecision(request.capability, 'allowed')
    if (request.signal?.aborted) {
      return { status: 'execution-failed', message: 'The action was cancelled.' }
    }
    const controller = new AbortController()
    const abortFromRequest = (): void => controller.abort()
    request.signal?.addEventListener('abort', abortFromRequest, { once: true })
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
      request.signal?.removeEventListener('abort', abortFromRequest)
    }
  }

  approveConfirmation(requestId: string): boolean {
    return this.confirmations.confirm(requestId, 'confirmation')
  }

  async approvePinAuthorization(requestId: string, pin: string): Promise<PinVerificationResult> {
    const pending = this.confirmations.get(requestId)
    if (!pending || pending.authorization !== 'pin') {
      return {
        ok: false,
        code: 'PIN_UNAVAILABLE',
        message: 'That protected action is missing, expired, or does not require a PIN.'
      }
    }

    const verification = await this.pinAuthorizer.verify(pin)
    if (!verification.ok) return verification
    if (!this.confirmations.confirm(requestId, 'pin')) {
      return {
        ok: false,
        code: 'PIN_UNAVAILABLE',
        message: 'That protected action expired. Request it again.'
      }
    }
    return { ok: true }
  }

  cancelConfirmation(requestId: string): boolean {
    return this.confirmations.cancel(requestId)
  }

  private requiredAuthorization(
    capabilityName: string,
    risk: 'automatic' | 'confirmation-required' | 'pin-required' | 'blocked'
  ): ActionAuthorization | null {
    if (risk === 'pin-required') return 'pin'
    if (risk === 'confirmation-required' || confirmationRequiredCapabilities.has(capabilityName)) {
      return 'confirmation'
    }
    return null
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
