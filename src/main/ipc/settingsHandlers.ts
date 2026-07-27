import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, TitanSettings } from '../../shared/types'
import { getSettings, updateSettings } from '../services/settingsService'

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.settingsGet, (): ActionResult<TitanSettings> => {
    return {
      ok: true,
      message: 'Settings loaded.',
      data: getSettings()
    }
  })

  ipcMain.handle(
    IPC_CHANNELS.settingsUpdate,
    (_event, patch: unknown): ActionResult<TitanSettings> => {
      const settings = updateSettings(patch)
      if (!settings) {
        return {
          ok: false,
          code: 'INVALID_SETTINGS',
          message: 'The settings update was invalid.',
          recoverable: true
        }
      }

      return {
        ok: true,
        message: 'Settings saved locally.',
        data: settings
      }
    }
  )
}
