import { describe, expect, it } from 'vitest'
import {
  remainingWakeAcknowledgement,
  TRANSCRIPT_READY_HOLD_MS,
  WAKE_ACKNOWLEDGEMENT_MS
} from './voiceCueTiming'

describe('voice cue timing', () => {
  it('keeps the wake acknowledgement visible for at least 900 milliseconds', () => {
    expect(WAKE_ACKNOWLEDGEMENT_MS).toBe(900)
    expect(remainingWakeAcknowledgement(1_000, 1_400)).toBe(500)
    expect(remainingWakeAcknowledgement(1_000, 1_900)).toBe(0)
  })

  it('retains a completed transcript for four seconds after returning ready', () => {
    expect(TRANSCRIPT_READY_HOLD_MS).toBe(4_000)
  })
})
