import type { WakeRecognitionMode } from '../../shared/types'
import type { WakeAudioMetrics } from './wakeWordCandidateSegmenter'

export type WakeWordWorkerResources = {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
  keywords: string
}

export type WakeWordWorkerInput =
  | {
      type: 'initialize'
      resources: WakeWordWorkerResources
      recognitionMode: WakeRecognitionMode
    }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'test-start' }
  | { type: 'test-window-end' }
  | { type: 'test-cancel' }
  | {
      type: 'fallback-result'
      candidateId: number
      detected: boolean
      hasCommand: boolean
    }
  | { type: 'shutdown' }

export type WakeWordWorkerOutput =
  | { type: 'ready' }
  | { type: 'state'; state: 'detected' | 'capturing' | 'paused' | 'armed' }
  | { type: 'command'; samples: Float32Array }
  | { type: 'test-detected'; latencyMs: number; metrics: WakeAudioMetrics }
  | { type: 'test-window-ended'; metrics: WakeAudioMetrics }
  | {
      type: 'wake-candidate'
      candidateId: number
      samples: Float32Array
      metrics: WakeAudioMetrics
      test: boolean
      latencyMs?: number
    }
  | { type: 'error'; message: string }
