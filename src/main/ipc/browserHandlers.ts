import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type {
  ActionResult,
  BrowserConnectionStatus,
  BrowserForgetPairingResult,
  BrowserPairingSession
} from '../../shared/types'
import {
  beginBrowserPairing,
  disconnectBrowser,
  getBrowserExtensionPath,
  getBrowserStatus,
  retryBrowserConnection
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
    IPC_CHANNELS.browserRetry,
    async (): Promise<ActionResult<BrowserConnectionStatus>> => {
      try {
        return {
          ok: true,
          message: 'Orbit is ready for the browser extension to reconnect.',
          data: await retryBrowserConnection()
        }
      } catch (error: unknown) {
        return {
          ok: false,
          code: 'BROWSER_RETRY_FAILED',
          message:
            error instanceof Error
              ? error.message
              : 'Orbit could not prepare the browser connection retry.',
          recoverable: true
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.browserDisconnect,
    async (): Promise<ActionResult<BrowserForgetPairingResult>> => {
      try {
        const result = await disconnectBrowser()
        return {
          ok: true,
          message: result.warning ?? 'The browser pairing was forgotten.',
          data: result
        }
      } catch (error: unknown) {
        return {
          ok: false,
          code: 'BROWSER_FORGET_FAILED',
          message:
            error instanceof Error ? error.message : 'Orbit could not forget the browser pairing.',
          recoverable: true
        }
      }
    }
  )
}
