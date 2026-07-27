import { describe, expect, it } from 'vitest'
import type { ActionPlan } from './actionPlanSchemas'
import {
  createAssistantSession,
  createSessionContextMessage,
  recordSuccessfulExchange
} from './assistantSession'

function plan(capability: string, parameters: Record<string, unknown>): ActionPlan {
  return {
    kind: 'action_plan',
    summary: capability,
    actions: [{ capability, parameters }]
  }
}

describe('assistant session context', () => {
  it('records successful deterministic exchanges and canonical application context', () => {
    const session = createAssistantSession()
    recordSuccessfulExchange(
      session,
      'Open calculator',
      'Opening Calculator.',
      plan('application.launch', { application: 'calc' })
    )

    expect(session.messages).toEqual([
      { role: 'user', content: 'Open calculator' },
      { role: 'assistant', content: 'Opening Calculator.' }
    ])
    expect(session.context).toMatchObject({
      lastApplication: 'calculator',
      lastSuccessfulCapability: 'application.launch'
    })
  })

  it('keeps Spotify as the media target until another media application replaces it', () => {
    const session = createAssistantSession()
    recordSuccessfulExchange(
      session,
      'Play Bruno Mars',
      'Playing the top Spotify result for Bruno Mars.',
      plan('spotify.playSearch', { query: 'Bruno Mars' })
    )
    recordSuccessfulExchange(
      session,
      'Open calculator',
      'Opening Calculator.',
      plan('application.launch', { application: 'calculator' })
    )

    expect(session.context.lastApplication).toBe('calculator')
    expect(session.context.lastMediaApplication).toBe('spotify')
    expect(createSessionContextMessage(session.context)?.content).toContain('spotify')
  })

  it('does not update context unless a successful exchange is explicitly recorded', () => {
    const session = createAssistantSession()
    expect(session.context).toEqual({})
    expect(session.messages).toEqual([])
  })
})
