import type { ActionResult, OllamaHealth } from '../shared/types'

type TitanApi = {
  checkOllama: () => Promise<ActionResult<OllamaHealth>>
  askAssistant: (message: string) => Promise<ActionResult<{ response: string }>>
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
