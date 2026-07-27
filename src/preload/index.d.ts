import type { ActionResult, AssistantResponse, OllamaHealth, Transcription } from '../shared/types'

type TitanApi = {
  checkOllama: () => Promise<ActionResult<OllamaHealth>>
  askAssistant: (message: string) => Promise<ActionResult<AssistantResponse>>
  cancelAssistant: () => Promise<ActionResult>
  clearConversation: () => Promise<ActionResult>
  transcribeAudio: (audio: Uint8Array) => Promise<ActionResult<Transcription>>
  cancelTranscription: () => Promise<ActionResult>
  confirmAction: (requestId: string, approved: boolean) => Promise<ActionResult<AssistantResponse>>
}

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
