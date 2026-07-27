import type { SpeechSynthesisEvent } from '../../shared/types'

export type SpeechSynthesisWorkerResources = {
  model: string
  voices: string
  tokens: string
  dataDir: string
  lexicon: string
}

export type SpeechSynthesisWorkerInput =
  | {
      type: 'initialize'
      resources: SpeechSynthesisWorkerResources
      numThreads: number
    }
  | {
      type: 'synthesize'
      requestId: string
      sentences: string[]
      speakerId: number
      speed: number
    }
  | {
      type: 'cancel'
      requestId: string
    }
  | { type: 'shutdown' }

export type SpeechSynthesisWorkerOutput =
  { type: 'ready'; sampleRate: number; numSpeakers: number } | SpeechSynthesisEvent
