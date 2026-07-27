import type { ActionResult, AssistantEffect, AssistantResponse } from '../../shared/types'
import type { PolicyEngine } from '../security/policyEngine'
import type { ActionPlan } from './actionPlanSchemas'

type PendingPlan = {
  plan: ActionPlan
  actionIndex: number
  requestId: string
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
    approved: boolean
  ): Promise<ActionResult<AssistantResponse>> {
    const pending = this.pendingBySender.get(senderId)
    if (!pending || pending.requestId !== requestId) {
      return {
        ok: false,
        code: 'CONFIRMATION_NOT_FOUND',
        message: 'That confirmation is missing, expired, cancelled, or belongs to another request.',
        recoverable: true
      }
    }

    this.pendingBySender.delete(senderId)
    if (!approved) {
      this.policyEngine.cancelConfirmation(requestId)
      return {
        ok: true,
        message: 'The action was cancelled.',
        data: { response: 'The action was cancelled.' }
      }
    }

    if (!this.policyEngine.approveConfirmation(requestId)) {
      return {
        ok: false,
        code: 'CONFIRMATION_EXPIRED',
        message: 'That confirmation expired. Please request the action again.',
        recoverable: true
      }
    }

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
          requestId: policyResult.confirmation.requestId
        })
        return {
          ok: true,
          message: policyResult.confirmation.summary,
          data: {
            response: policyResult.confirmation.summary,
            confirmation: {
              requestId: policyResult.confirmation.requestId,
              summary: policyResult.confirmation.summary,
              expiresAt: policyResult.confirmation.expiresAt
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
): { requestId: string; approved: boolean } | null {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 2) return null
  const candidate = value as Record<string, unknown>
  return typeof candidate.requestId === 'string' &&
    candidate.requestId.length > 0 &&
    candidate.requestId.length <= 100 &&
    typeof candidate.approved === 'boolean'
    ? { requestId: candidate.requestId, approved: candidate.approved }
    : null
}
