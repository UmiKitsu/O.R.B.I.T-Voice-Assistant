import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type {
  ActionResult,
  BrowserConnectionStatus,
  BrowserPairingSession
} from '../../shared/types'
import {
  beginBrowserPairing,
  disconnectBrowser,
  getBrowserExtensionPath,
  getBrowserStatus
} from '../services/browserBridgeService'

export function registerBrowserHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.browserStatus,
    (): ActionResult<BrowserConnectionStatus> => ({
      ok: true,
      message: 'Browser connection status loaded.',
      data: getBrowserStatus()
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.browserExtensionPath,
    (): ActionResult<{ path: string }> => ({
      ok: true,
      message: 'Browser extension path loaded.',
      data: { path: getBrowserExtensionPath() }
    })
  )

  ipcMain.handle(
    IPC_CHANNELS.browserPairingBegin,
    async (): Promise<ActionResult<BrowserPairingSession>> => {
      try {
        return {
          ok: true,
          message: 'Browser pairing is ready.',
          data: await beginBrowserPairing()
        }
      } catch (error: unknown) {
        return {
          ok: false,
          code: 'BROWSER_PAIRING_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Orbit could not start browser pairing.',
          recoverable: true
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.browserDisconnect,
    async (): Promise<ActionResult<BrowserConnectionStatus>> => ({
      ok: true,
      message: 'The browser extension was disconnected.',
      data: await disconnectBrowser()
    })
  )
}
