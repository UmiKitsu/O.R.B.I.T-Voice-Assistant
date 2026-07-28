import type {
  ActionResult,
  AssistantProgress,
  AssistantResponse,
  BrowserConnectionStatus,
  BrowserPairingSession,
  MicrophoneTestResult,
  OllamaHealth,
  OrbitSettings,
  SecurityPinStatus,
  SpotifyConnectionStatus,
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
  getPinStatus: () => Promise<ActionResult<SecurityPinStatus>>
  createPin: (pin: string, confirmation: string) => Promise<ActionResult<SecurityPinStatus>>
  changePin: (
    currentPin: string,
    nextPin: string,
    confirmation: string
  ) => Promise<ActionResult<SecurityPinStatus>>
  getSpotifyStatus: () => Promise<ActionResult<SpotifyConnectionStatus>>
  connectSpotify: () => Promise<ActionResult<SpotifyConnectionStatus>>
  disconnectSpotify: () => Promise<ActionResult<SpotifyConnectionStatus>>
  getBrowserStatus: () => Promise<ActionResult<BrowserConnectionStatus>>
  beginBrowserPairing: () => Promise<ActionResult<BrowserPairingSession>>
  disconnectBrowser: () => Promise<ActionResult<BrowserConnectionStatus>>
  getBrowserExtensionPath: () => Promise<ActionResult<{ path: string }>>
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
  confirmAction: (
    requestId: string,
    approved: boolean,
    pin?: string
  ) => Promise<ActionResult<AssistantResponse>>
}

declare global {
  interface Window {
    orbit: OrbitApi
  }
}

export {}
