import type {
  ActionResult,
  AssistantResponse,
  MicrophoneTestResult,
  OllamaHealth,
  TitanSettings,
  WakeWordEvent
} from '../shared/types'

type TitanApi = {
  checkOllama: () => Promise<ActionResult<OllamaHealth>>
  askAssistant: (message: string) => Promise<ActionResult<AssistantResponse>>
  cancelAssistant: () => Promise<ActionResult>
  getSettings: () => Promise<ActionResult<TitanSettings>>
  updateSettings: (patch: Partial<TitanSettings>) => Promise<ActionResult<TitanSettings>>
  startWakeWord: () => Promise<ActionResult>
  stopWakeWord: () => Promise<ActionResult>
  pauseWakeWord: () => Promise<ActionResult>
  resumeWakeWord: () => Promise<ActionResult>
  sendWakeWordAudio: (samples: Float32Array) => void
  transcribeMicrophoneTest: (audio: Uint8Array) => Promise<ActionResult<MicrophoneTestResult>>
  cancelMicrophoneTest: () => Promise<ActionResult>
  onWakeWordEvent: (listener: (event: WakeWordEvent) => void) => () => void
  confirmAction: (requestId: string, approved: boolean) => Promise<ActionResult<AssistantResponse>>
}

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
