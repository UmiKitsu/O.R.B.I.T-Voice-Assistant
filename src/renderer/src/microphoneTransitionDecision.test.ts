import { describe, expect, it } from 'vitest'
import type { MicrophonePipelineState } from '../../shared/types'
import {
  decideMicrophoneTransition,
  type MicrophoneTransitionDecision
} from './microphoneTransitionDecision'

const states: readonly MicrophonePipelineState[] = [
  'off',
  'starting',
  'active',
  'paused',
  'recovering',
  'error'
]

const runningMatrix = [
  ['off', 'resume'],
  ['starting', 'none'],
  ['active', 'none'],
  ['paused', 'resume'],
  ['recovering', 'none'],
  ['error', 'none']
] satisfies ReadonlyArray<readonly [MicrophonePipelineState, MicrophoneTransitionDecision]>

const stoppedMatrix = [
  ['off', 'none'],
  ['starting', 'pause'],
  ['active', 'pause'],
  ['paused', 'none'],
  ['recovering', 'pause'],
  ['error', 'none']
] satisfies ReadonlyArray<readonly [MicrophonePipelineState, MicrophoneTransitionDecision]>

describe('decideMicrophoneTransition', () => {
  it.each(runningMatrix)('returns %s -> %s when audio should run', (pipelineState, expected) => {
    expect(decideMicrophoneTransition(true, pipelineState)).toBe(expected)
  })

  it.each(stoppedMatrix)('returns %s -> %s when audio should stop', (pipelineState, expected) => {
    expect(decideMicrophoneTransition(false, pipelineState)).toBe(expected)
  })

  it('never resumes an active or in-progress pipeline', () => {
    const activeOrTransitioning = states.filter(
      (state) => state === 'active' || state === 'starting' || state === 'recovering'
    )

    for (const pipelineState of activeOrTransitioning) {
      expect(decideMicrophoneTransition(true, pipelineState)).toBe('none')
    }
  })

  it('requests one resume across paused, starting, and active events', () => {
    expect(decideMicrophoneTransition(true, 'paused')).toBe('resume')
    expect(decideMicrophoneTransition(true, 'starting')).toBe('none')
    expect(decideMicrophoneTransition(true, 'active')).toBe('none')
  })

  it('requests one pause across active and paused events', () => {
    expect(decideMicrophoneTransition(false, 'active')).toBe('pause')
    expect(decideMicrophoneTransition(false, 'paused')).toBe('none')
  })

  it('ignores repeated armed-state reconciliation while the pipeline stays active', () => {
    const decisions = Array.from({ length: 10 }, () =>
      decideMicrophoneTransition(true, 'active')
    )
    expect(decisions).toEqual(Array.from({ length: 10 }, () => 'none'))
  })
})
