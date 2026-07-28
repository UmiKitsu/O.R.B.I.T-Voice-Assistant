import type {
  ActionAuthorization,
  ActionResult,
  AssistantEffect,
  AssistantResponse
} from '../../shared/types'
import type { PolicyEngine } from '../security/policyEngine'
import type { ActionPlan } from './actionPlanSchemas'

type PendingPlan = {
  plan: ActionPlan
  actionIndex: number
  requestId: string
  authorization: ActionAuthorization
}

function asActionResult(value: unknown): ActionResult<unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.ok !== 'boolean' || typeof candidate.message !== 'string') return null
  if (candidate.ok) return candidate as ActionResult<unknown>
  return typeof candidate.code === 'string' && typeof candidate.recoverable === 'boolean'
    ? (candidate as ActionResult<unknown>)
    : null
}

export class ConfirmationFlow {
  private readonly pendingBySender = new Map<number, PendingPlan>()

  constructor(private readonly policyEngine: PolicyEngine) {}

  execute(plan: ActionPlan, senderId: number): Promise<ActionResult<AssistantResponse>> {
    this.cancelSender(senderId)
    return this.executeFrom(plan, senderId, 0)
  }

  async respond(
    senderId: number,
    requestId: string,
    approved: boolean,
    pin?: string
  ): Promise<ActionResult<AssistantResponse>> {
    const pending = this.pendingBySender.get(senderId)
    if (!pending || pending.requestId !== requestId) {
      return {
        ok: false,
        code: 'CONFIRMATION_NOT_FOUND',
        message:
          'That authorization is missing, expired, cancelled, or belongs to another request.',
        recoverable: true
      }
    }

    if (!approved) {
      this.pendingBySender.delete(senderId)
      this.policyEngine.cancelConfirmation(requestId)
      return {
        ok: true,
        message: 'The action was cancelled.',
        data: { response: 'The action was cancelled.' }
      }
    }

    if (pending.authorization === 'pin') {
      const verification = await this.policyEngine.approvePinAuthorization(requestId, pin ?? '')
      if (!verification.ok) {
        return {
          ok: false,
          code: verification.code,
          message: verification.message,
          recoverable: true
        }
      }
    } else if (!this.policyEngine.approveConfirmation(requestId)) {
      this.pendingBySender.delete(senderId)
      return {
        ok: false,
        code: 'CONFIRMATION_EXPIRED',
        message: 'That confirmation expired. Please request the action again.',
        recoverable: true
      }
    }

    this.pendingBySender.delete(senderId)
    return this.executeFrom(pending.plan, senderId, pending.actionIndex, requestId)
  }

  cancelSender(senderId: number): void {
    const pending = this.pendingBySender.get(senderId)
    if (!pending) return
    this.policyEngine.cancelConfirmation(pending.requestId)
    this.pendingBySender.delete(senderId)
  }

  private async executeFrom(
    plan: ActionPlan,
    senderId: number,
    startIndex: number,
    confirmationRequestId?: string
  ): Promise<ActionResult<AssistantResponse>> {
    const messages: string[] = []
    const effects: AssistantEffect[] = []

    for (let actionIndex = startIndex; actionIndex < plan.actions.length; actionIndex += 1) {
      const action = plan.actions[actionIndex]
      const policyResult = await this.policyEngine.evaluateAndExecute({
        capability: action.capability,
        parameters: action.parameters,
        summary: plan.summary,
        ...(actionIndex === startIndex && confirmationRequestId ? { confirmationRequestId } : {})
      })

      if (policyResult.status === 'confirmation-required') {
        this.pendingBySender.set(senderId, {
          plan,
          actionIndex,
          requestId: policyResult.confirmation.requestId,
          authorization: policyResult.confirmation.authorization
        })
        const response =
          policyResult.confirmation.authorization === 'pin'
            ? `${policyResult.confirmation.summary} This protected action requires your four-digit security PIN.`
            : policyResult.confirmation.summary
        return {
          ok: true,
          message: response,
          data: {
            response,
            confirmation: {
              requestId: policyResult.confirmation.requestId,
              summary: policyResult.confirmation.summary,
              expiresAt: policyResult.confirmation.expiresAt,
              authorization: policyResult.confirmation.authorization,
              pinConfigured: policyResult.confirmation.pinConfigured,
              ...(policyResult.confirmation.visualTarget
                ? { visualTarget: policyResult.confirmation.visualTarget }
                : {})
            }
          }
        }
      }

      if (policyResult.status !== 'executed') {
        return {
          ok: false,
          code: `ACTION_${policyResult.status.toUpperCase().replaceAll('-', '_')}`,
          message: policyResult.message,
          recoverable: true
        }
      }

      const result = asActionResult(policyResult.result)
      if (!result) {
        return {
          ok: false,
          code: 'INVALID_ACTION_RESULT',
          message: 'The action returned an invalid result.',
          recoverable: true
        }
      }
      if (!result.ok) return result
      messages.push(result.message)

      const data = result.data
      if (
        typeof data === 'object' &&
        data !== null &&
        'effect' in data &&
        (data.effect === 'stop-speaking' || data.effect === 'disable')
      ) {
        effects.push(data.effect)
      }
    }

    const response = messages.join(' ')
    return {
      ok: true,
      message: response,
      data: {
        response,
        ...(effects.length > 0 ? { effects } : {})
      }
    }
  }
}

export function parseConfirmationResponse(
  value: unknown
): { requestId: string; approved: boolean; pin?: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const allowedKeys = new Set(['requestId', 'approved', 'pin'])
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return null
  if (
    typeof candidate.requestId !== 'string' ||
    candidate.requestId.length === 0 ||
    candidate.requestId.length > 100 ||
    typeof candidate.approved !== 'boolean' ||
    (candidate.pin !== undefined &&
      (typeof candidate.pin !== 'string' || !/^\d{4}$/.test(candidate.pin)))
  ) {
    return null
  }

  return {
    requestId: candidate.requestId,
    approved: candidate.approved,
    ...(typeof candidate.pin === 'string' ? { pin: candidate.pin } : {})
  }
}
