import { describe, expect, it } from 'vitest'
import type { ActionPlan } from './actionPlanSchemas'
import {
  MAX_RETAINED_CHARACTERS,
  MAX_RETAINED_MESSAGES,
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

  it('keeps a verified YouTube session confirmed while the video is paused', () => {
    const session = createAssistantSession()
    recordSuccessfulExchange(
      session,
      'Pause the YouTube video',
      'Paused the YouTube video.',
      plan('youtube.pause', {}),
      {
        controlledTabId: 42,
        videoId: 'dQw4w9WgXcQ',
        title: 'Fixture video',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        paused: true,
        ended: false,
        muted: false,
        volume: 50,
        currentTime: 15,
        duration: 300,
        confirmedPlaying: false
      }
    )

    expect(session.context).toMatchObject({
      lastMediaApplication: 'youtube',
      controlledBrowserTabId: 42,
      selectedYouTubeVideoId: 'dQw4w9WgXcQ',
      confirmedYouTubePlayback: true
    })
  })

  it('does not update context unless a successful exchange is explicitly recorded', () => {
    const session = createAssistantSession()
    expect(session.context).toEqual({})
    expect(session.messages).toEqual([])
  })
  it('retains only the newest eight conversation messages', () => {
    const session = createAssistantSession()
    for (let index = 0; index < 6; index += 1) {
      recordSuccessfulExchange(session, `User ${index}`, `Assistant ${index}`)
    }

    expect(session.messages).toHaveLength(MAX_RETAINED_MESSAGES)
    expect(session.messages[0]).toEqual({ role: 'user', content: 'User 2' })
    expect(session.messages.at(-1)).toEqual({ role: 'assistant', content: 'Assistant 5' })
  })

  it('caps retained context at twelve thousand characters', () => {
    const session = createAssistantSession()
    recordSuccessfulExchange(session, 'Short request', 'x'.repeat(MAX_RETAINED_CHARACTERS + 1_000))

    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]?.content).toHaveLength(MAX_RETAINED_CHARACTERS)
  })
})
