import type { ActionResult } from '../../shared/types'
import { createCapabilityRuntime } from '../capabilities/capabilityRuntime'
import { routeDeterministicCommand } from './commandRouter'

const capabilityRuntime = createCapabilityRuntime()

function isActionResult(value: unknown): value is ActionResult<unknown> {
  if (typeof value !== 'object' || value === null || !('ok' in value) || !('message' in value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  if (typeof candidate.ok !== 'boolean' || typeof candidate.message !== 'string') return false
  if (candidate.ok) return true

  return typeof candidate.code === 'string' && typeof candidate.recoverable === 'boolean'
}

export async function executeDeterministicAction(
  message: string
): Promise<ActionResult<{ response: string }> | null> {
  const request = routeDeterministicCommand(message)
  if (!request) return null

  const policyResult = await capabilityRuntime.evaluateAndExecute(request)
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
  return {
    ok: true,
    message: policyResult.result.message,
    data: { response: policyResult.result.message }
  }
}
