import type { ActionResult, AssistantResponse, OllamaHealth } from '../shared/types'

type TitanApi = {
  checkOllama: () => Promise<ActionResult<OllamaHealth>>
  askAssistant: (message: string) => Promise<ActionResult<AssistantResponse>>
  cancelAssistant: () => Promise<ActionResult>
  clearConversation: () => Promise<ActionResult>
  confirmAction: (requestId: string, approved: boolean) => Promise<ActionResult>
}

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
