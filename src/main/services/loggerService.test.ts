import { describe, expect, it } from 'vitest'
import { serializeOperationalLogEvent } from './loggerService'

describe('privacy-conscious operational logs', () => {
  it('contains only allowlisted operational metadata', () => {
    const line = serializeOperationalLogEvent(
      { event: 'action.completed', capability: 'browser.openUrl', outcome: 'succeeded' },
      new Date('2026-07-27T00:00:00.000Z')
    )

    expect(JSON.parse(line)).toEqual({
      timestamp: '2026-07-27T00:00:00.000Z',
      event: 'action.completed',
      capability: 'browser.openUrl',
      outcome: 'succeeded'
    })
  })

  it('records privacy-safe Spotify stage timing without query or title data', () => {
    const line = serializeOperationalLogEvent(
      {
        event: 'spotify.playback-stage',
        stage: 'activation',
        outcome: 'succeeded',
        durationMs: 12
      },
      new Date('2026-07-27T00:00:00.000Z')
    )

    expect(JSON.parse(line)).toEqual({
      timestamp: '2026-07-27T00:00:00.000Z',
      event: 'spotify.playback-stage',
      stage: 'activation',
      outcome: 'succeeded',
      durationMs: 12
    })
    expect(line).not.toContain('Bruno Mars')
    expect(line).not.toContain('Locked Out of Heaven')
  })

  it('does not write arbitrary text supplied as a capability name', () => {
    const privateText = 'secret token value'
    const line = serializeOperationalLogEvent(
      { event: 'capability.requested', capability: privateText },
      new Date('2026-07-27T00:00:00.000Z')
    )

    expect(line).not.toContain(privateText)
    expect(JSON.parse(line).capability).toBe('unknown')
  })
})
