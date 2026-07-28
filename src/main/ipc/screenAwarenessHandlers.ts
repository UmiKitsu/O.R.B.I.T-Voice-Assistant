import { BrowserWindow, ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, ScreenAwarenessStatus } from '../../shared/types'
import {
  getScreenAwarenessStatus,
  refreshScreenAwarenessStatus,
  subscribeScreenAwarenessStatus
} from '../services/screenAwarenessService'

let subscribed = false

function success(status: ScreenAwarenessStatus): ActionResult<ScreenAwarenessStatus> {
  return { ok: true, message: status.message, data: status }
}

export function registerScreenAwarenessHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.screenAwarenessStatus, (): ActionResult<ScreenAwarenessStatus> => {
    return success(getScreenAwarenessStatus())
  })
  ipcMain.handle(
    IPC_CHANNELS.screenAwarenessRefresh,
    async (): Promise<ActionResult<ScreenAwarenessStatus>> => {
      return success(await refreshScreenAwarenessStatus())
    }
  )

  if (!subscribed) {
    subscribed = true
    subscribeScreenAwarenessStatus((status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed())
          window.webContents.send(IPC_CHANNELS.screenAwarenessEvent, status)
      }
    })
  }
}
