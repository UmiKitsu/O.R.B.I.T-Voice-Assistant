import type { AssistantSessionContext, ChatMessage } from '../../shared/types'
import { resolveApplication } from '../services/applicationDiscoveryService'
import type { ActionPlan } from './actionPlanSchemas'

export const MAX_RETAINED_MESSAGES = 20

export type AssistantSession = {
  messages: ChatMessage[]
  context: AssistantSessionContext
  pendingMediaDestination?: { query: string }
}

export function createAssistantSession(): AssistantSession {
  return { messages: [], context: {} }
}

function canonicalApplication(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return resolveApplication(value)?.id ?? null
}

export function updateSessionContext(context: AssistantSessionContext, plan: ActionPlan): void {
  for (const action of plan.actions) {
    context.lastSuccessfulCapability = action.capability

    if (action.capability === 'spotify.playSearch') {
      context.lastApplication = 'spotify'
      context.lastMediaApplication = 'spotify'
      continue
    }

    if (action.capability.startsWith('application.')) {
      const application = canonicalApplication(action.parameters.application)
      if (application) {
        context.lastApplication = application
        if (application === 'spotify') context.lastMediaApplication = 'spotify'
      }
    }
  }
}

export function recordSuccessfulExchange(
  session: AssistantSession,
  userContent: string,
  assistantContent: string,
  plan?: ActionPlan
): void {
  const exchange: ChatMessage[] = [
    { role: 'user', content: userContent },
    { role: 'assistant', content: assistantContent }
  ]
  session.messages = [...session.messages, ...exchange].slice(-MAX_RETAINED_MESSAGES)

  if (plan) updateSessionContext(session.context, plan)
}

export function createSessionContextMessage(context: AssistantSessionContext): ChatMessage | null {
  if (!context.lastApplication && !context.lastMediaApplication) return null

  return {
    role: 'system',
    content: `Current confirmed session context: ${JSON.stringify(context)}. Resolve follow-up references only from this context.`
  }
}
