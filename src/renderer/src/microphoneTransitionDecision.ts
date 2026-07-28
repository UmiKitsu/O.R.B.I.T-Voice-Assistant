import type { MicrophonePipelineState } from '../../shared/types'

export type MicrophoneTransitionDecision = 'resume' | 'pause' | 'none'

export function decideMicrophoneTransition(
  shouldRun: boolean,
  pipelineState: MicrophonePipelineState
): MicrophoneTransitionDecision {
  if (shouldRun) {
    return pipelineState === 'off' || pipelineState === 'paused' ? 'resume' : 'none'
  }

  return pipelineState === 'active' ||
    pipelineState === 'starting' ||
    pipelineState === 'recovering'
    ? 'pause'
    : 'none'
}
