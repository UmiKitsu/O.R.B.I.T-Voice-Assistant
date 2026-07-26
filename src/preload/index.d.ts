import type { ActionResult } from '../shared/types'

type TitanApi = {
  checkOllama: () => Promise<ActionResult>
  askAssistant: (message: string) => Promise<ActionResult>
  cancelAssistant: () => Promise<ActionResult>
  confirmAction: (requestId: string, approved: boolean) => Promise<ActionResult>
}

declare global {
  interface Window {
    titan: TitanApi
  }
}

export {}
