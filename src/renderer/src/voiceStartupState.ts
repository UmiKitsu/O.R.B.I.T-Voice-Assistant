import type { OrbitStatus } from '../../shared/types'

export type MicrophoneStartupReadiness = 'idle' | 'pending' | 'prepared' | 'ready' | 'error'
export type OllamaStartupReadiness = 'idle' | 'pending' | 'ready' | 'error'

export type VoiceStartupReadiness = {
  microphone: MicrophoneStartupReadiness
  ollama: OllamaStartupReadiness
}

export function deriveVoiceStartupStatus(readiness: VoiceStartupReadiness): OrbitStatus {
  if (readiness.microphone === 'error' || readiness.ollama === 'error') return 'error'
  if (readiness.microphone === 'idle' || readiness.microphone === 'pending') {
    return 'preparing-voice'
  }
  if (readiness.ollama === 'idle' || readiness.ollama === 'pending') return 'preparing-ai'
  return readiness.microphone === 'ready' ? 'ready' : 'preparing-voice'
}
