import type {
  ActionResult,
  AssistantProgress,
  AssistantResponse,
  MicrophoneTestResult,
  OllamaHealth,
  OrbitSettings,
  SpeechSynthesisEvent,
  WakeWordEvent
} from '../shared/types'

type OrbitApi = {
  checkOllama: () => Promise<ActionResult<OllamaHealth>>
  askAssistant: (message: string) => Promise<ActionResult<AssistantResponse>>
  cancelAssistant: () => Promise<ActionResult>
  onAssistantProgress: (listener: (progress: AssistantProgress) => void) => () => void
  synthesizeSpeech: (text: string) => Promise<ActionResult<{ requestId: string }>>
  cancelSpeech: () => Promise<ActionResult>
  onSpeechSynthesisEvent: (listener: (event: SpeechSynthesisEvent) => void) => () => void
  getSettings: () => Promise<ActionResult<OrbitSettings>>
  updateSettings: (patch: Partial<OrbitSettings>) => Promise<ActionResult<OrbitSettings>>
  startWakeWord: () => Promise<ActionResult>
  stopWakeWord: () => Promise<ActionResult>
  pauseWakeWord: () => Promise<ActionResult>
  resumeWakeWord: () => Promise<ActionResult>
  startWakeWordTest: () => Promise<ActionResult>
  cancelWakeWordTest: () => Promise<ActionResult>
  sendWakeWordAudio: (samples: Float32Array) => void
  transcribeMicrophoneTest: (audio: Uint8Array) => Promise<ActionResult<MicrophoneTestResult>>
  cancelMicrophoneTest: () => Promise<ActionResult>
  onWakeWordEvent: (listener: (event: WakeWordEvent) => void) => () => void
  confirmAction: (requestId: string, approved: boolean) => Promise<ActionResult<AssistantResponse>>
}

declare global {
  interface Window {
    orbit: OrbitApi
  }
}

export {}
