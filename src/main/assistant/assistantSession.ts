import type { AssistantSessionContext, ChatMessage } from '../../shared/types'
import { resolveApplication } from '../services/applicationDiscoveryService'
import type { ActionPlan } from './actionPlanSchemas'

export const MAX_RETAINED_MESSAGES = 8
export const MAX_RETAINED_CHARACTERS = 12_000

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

    if (action.capability === 'youtube.playSearch') {
      context.lastApplication = 'browser'
      context.lastMediaApplication = 'youtube'
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

function retainBoundedMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const retained: ChatMessage[] = []
  let characterCount = 0

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || retained.length >= MAX_RETAINED_MESSAGES) break
    const remainingCharacters = MAX_RETAINED_CHARACTERS - characterCount
    if (remainingCharacters <= 0) break
    if (message.content.length > remainingCharacters) {
      if (retained.length === 0) {
        retained.unshift({ ...message, content: message.content.slice(0, remainingCharacters) })
      }
      break
    }
    retained.unshift(message)
    characterCount += message.content.length
  }

  return retained
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
  session.messages = retainBoundedMessages([...session.messages, ...exchange])

  if (plan) updateSessionContext(session.context, plan)
}

export function createSessionContextMessage(context: AssistantSessionContext): ChatMessage | null {
  if (!context.lastApplication && !context.lastMediaApplication) return null

  return {
    role: 'system',
    content: `Current confirmed session context: ${JSON.stringify(context)}. Resolve follow-up references only from this context.`
  }
}
