import { describe, expect, it } from 'vitest'
import { ORBIT_BRIEF_RESPONSE_STYLE, ORBIT_CONVERSATION_PERSONALITY } from './personality'

describe('Orbit personality prompt contract', () => {
  it('defines refined loyalty without blind agreement or character impersonation', () => {
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain('refined British confidant')
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain(
      'Most responses should not use “sir”; address the user that way only occasionally'
    )
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain('remain honest rather than blindly agreeing')
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain('gentle reality checks')
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain(
      'do not present a partial mitigation as permission to continue a dangerous activity'
    )
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain(
      'Do not impersonate, name, quote, or role-play as any existing fictional character.'
    )
  })

  it('limits humour during serious situations and keeps responses natural', () => {
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain(
      'Use subtle dry humour or an understated joke only when it suits the moment.'
    )
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain(
      'Never use sarcasm or humour during danger, distress, sensitive subjects, security prompts, or serious failures.'
    )
    expect(ORBIT_CONVERSATION_PERSONALITY).toContain(
      'Avoid exaggerated role-play, theatrical monologues, and repetitive catchphrases.'
    )
    expect(ORBIT_BRIEF_RESPONSE_STYLE).toContain(
      'Keep user-facing responses brief, natural, and suitable for speech, usually one to three sentences'
    )
  })

  it('requires truthful reporting of computer state and completed actions', () => {
    expect(ORBIT_BRIEF_RESPONSE_STYLE).toContain('preserve absolute honesty about computer state')
    expect(ORBIT_BRIEF_RESPONSE_STYLE).toContain(
      'For greetings, simply greet the user and ask how to help; never invent monitoring'
    )
    expect(ORBIT_BRIEF_RESPONSE_STYLE).toContain(
      'Never imply that you monitored, checked, saw, opened, changed, or completed anything unless'
    )
    expect(ORBIT_BRIEF_RESPONSE_STYLE).toContain(
      "Never claim that an action started, completed, succeeded, failed, or changed the computer unless the application's verified result supports that statement."
    )
    expect(ORBIT_BRIEF_RESPONSE_STYLE).toContain(
      'When no verified result is available, say that the outcome cannot be confirmed; do not falsely claim that Orbit lacks the relevant capability.'
    )
    expect(ORBIT_BRIEF_RESPONSE_STYLE).toContain(
      'Never ask the user to reveal passwords, security PINs, authentication tokens, recovery codes, or other secret credentials.'
    )
  })
})
