import type { ActionResult, AssistantEffect, AssistantResponse } from '../../shared/types'
import type { PolicyEngine } from '../security/policyEngine'
import type { ActionPlan } from './actionPlanSchemas'

function isActionResult(value: unknown): value is ActionResult<unknown> {
  if (typeof value !== 'object' || value === null || !('ok' in value) || !('message' in value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.ok !== 'boolean' || typeof candidate.message !== 'string') return false
  if (candidate.ok) return true

  return typeof candidate.code === 'string' && typeof candidate.recoverable === 'boolean'
}

export async function executeActionPlan(
  plan: ActionPlan,
  policyEngine: PolicyEngine
): Promise<ActionResult<AssistantResponse>> {
  const messages: string[] = []
  const effects: AssistantEffect[] = []

  for (const action of plan.actions) {
    const policyResult = await policyEngine.evaluateAndExecute({
      capability: action.capability,
      parameters: action.parameters,
      summary: plan.summary
    })

    if (policyResult.status !== 'executed') {
      return {
        ok: false,
        code: `ACTION_${policyResult.status.toUpperCase().replaceAll('-', '_')}`,
        message:
          policyResult.status === 'confirmation-required'
            ? policyResult.confirmation.summary
            : policyResult.message,
        recoverable: true
      }
    }

    if (!isActionResult(policyResult.result)) {
      return {
        ok: false,
        code: 'INVALID_ACTION_RESULT',
        message: 'The action returned an invalid result.',
        recoverable: true
      }
    }

    if (!policyResult.result.ok) return policyResult.result
    messages.push(policyResult.result.message)

    const data = policyResult.result.data
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
