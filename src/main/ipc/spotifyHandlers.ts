import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, SpotifyConnectionStatus } from '../../shared/types'
import { getSettings } from '../services/settingsService'
import {
  connectSpotify,
  disconnectSpotify,
  getSpotifyConnectionStatus
} from '../services/spotifyAuthService'

export function registerSpotifyHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.spotifyStatus,
    async (): Promise<ActionResult<SpotifyConnectionStatus>> => {
      const status = await getSpotifyConnectionStatus(getSettings().spotifyClientId)
      return {
        ok: true,
        message: status.connected ? 'Spotify is connected.' : 'Spotify is not connected.',
        data: status
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.spotifyConnect,
    async (): Promise<ActionResult<SpotifyConnectionStatus>> => {
      return connectSpotify(getSettings().spotifyClientId)
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.spotifyDisconnect,
    async (): Promise<ActionResult<SpotifyConnectionStatus>> => {
      const status = await disconnectSpotify(getSettings().spotifyClientId)
      return {
        ok: true,
        message: 'Spotify disconnected from Orbit.',
        data: status
      }
    }
  )
}
