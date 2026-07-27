import type { ActionResult, AssistantResponse } from '../../shared/types'
import { createCapabilityRuntime } from '../capabilities/capabilityRuntime'
import { executeActionPlan } from './actionPlanExecutor'
import { routeDeterministicCommand } from './commandRouter'

const capabilityRuntime = createCapabilityRuntime()

export async function executeDeterministicAction(
  message: string
): Promise<ActionResult<AssistantResponse> | null> {
  const plan = routeDeterministicCommand(message)
  if (!plan) return null

  // Deterministic plans use the same sequential policy boundary as model-generated plans.
  return executeActionPlan(plan, capabilityRuntime)
}
