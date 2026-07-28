import { useEffect, useState } from 'react'
import type {
  ActionResult,
  MusicProvider,
  SpotifyConnectionStatus,
  SpotifyPlaybackMode
} from '../../shared/types'

type SpotifySettingsProps = {
  onError: (message: string) => void
  onSuccess: (message: string) => void
}

export function SpotifySettings({
  onError,
  onSuccess
}: SpotifySettingsProps): React.JSX.Element {
  const [clientId, setClientId] = useState('')
  const [playbackMode, setPlaybackMode] = useState<SpotifyPlaybackMode>('desktop')
  const [preferredProvider, setPreferredProvider] = useState<MusicProvider>('spotify')
  const [fallbackEnabled, setFallbackEnabled] = useState(true)
  const [status, setStatus] = useState<SpotifyConnectionStatus | null>(null)
  const [notice, setNotice] = useState<ActionResult<SpotifyConnectionStatus> | null>(null)
  const [busy, setBusy] = useState<'saving' | 'connecting' | 'disconnecting' | null>(null)

  useEffect(() => {
    let active = true

    void Promise.all([window.orbit.getSettings(), window.orbit.getSpotifyStatus()])
      .then(([settingsResult, statusResult]) => {
        if (!active) return
        if (settingsResult.ok && settingsResult.data) {
          setClientId(settingsResult.data.spotifyClientId)
          setPlaybackMode(settingsResult.data.spotifyPlaybackMode)
          setPreferredProvider(settingsResult.data.preferredMusicProvider)
          setFallbackEnabled(settingsResult.data.musicFallbackEnabled)
        }
        if (statusResult.ok && statusResult.data) setStatus(statusResult.data)
      })
      .catch(() => {
        if (!active) return
        const message = 'Orbit could not load Spotify settings.'
        setNotice({
          ok: false,
          code: 'SPOTIFY_SETTINGS_LOAD_FAILED',
          message,
          recoverable: true
        })
        onError(message)
      })

    return () => {
      active = false
    }
  }, [onError])

  const saveConnectionSettings = async (): Promise<boolean> => {
    const result = await window.orbit.updateSettings({
      spotifyClientId: clientId.trim(),
      spotifyPlaybackMode: playbackMode,
      preferredMusicProvider: preferredProvider,
      musicFallbackEnabled: fallbackEnabled
    })
    if (!result.ok) {
      setNotice(result)
      onError(result.message)
      return false
    }
    return true
  }

  const save = async (): Promise<void> => {
    setBusy('saving')
    setNotice(null)
    try {
      if (!(await saveConnectionSettings())) return
      const statusResult = await window.orbit.getSpotifyStatus()
      if (statusResult.ok && statusResult.data) setStatus(statusResult.data)
      const message =
        playbackMode === 'desktop'
          ? 'Spotify desktop-app control is ready.'
          : 'Spotify Web API settings saved.'
      const result: ActionResult<SpotifyConnectionStatus> = {
        ok: true,
        message,
        ...(statusResult.ok && statusResult.data ? { data: statusResult.data } : {})
      }
      setNotice(result)
      onSuccess(message)
    } catch {
      const message = 'Orbit could not save the music settings.'
      setNotice({
        ok: false,
        code: 'SPOTIFY_SETTINGS_SAVE_FAILED',
        message,
        recoverable: true
      })
      onError(message)
    } finally {
      setBusy(null)
    }
  }

  const connect = async (): Promise<void> => {
    setBusy('connecting')
    setNotice(null)
    try {
      if (!(await saveConnectionSettings())) return
      const result = await window.orbit.connectSpotify()
      setNotice(result)
      if (result.ok && result.data) {
        setStatus(result.data)
        onSuccess(result.message)
      } else {
        onError(result.message)
      }
    } catch {
      const message = 'Orbit could not start Spotify authorization.'
      setNotice({
        ok: false,
        code: 'SPOTIFY_CONNECT_FAILED',
        message,
        recoverable: true
      })
      onError(message)
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (): Promise<void> => {
    setBusy('disconnecting')
    setNotice(null)
    try {
      const result = await window.orbit.disconnectSpotify()
      setNotice(result)
      if (result.ok && result.data) {
        setStatus(result.data)
        onSuccess(result.message)
      } else {
        onError(result.message)
      }
    } catch {
      const message = 'Orbit could not disconnect Spotify.'
      setNotice({
        ok: false,
        code: 'SPOTIFY_DISCONNECT_FAILED',
        message,
        recoverable: true
      })
      onError(message)
    } finally {
      setBusy(null)
    }
  }

  const webApiMode = playbackMode === 'web-api'

  return (
    <fieldset className="spotify-settings">
      <legend>Music playback</legend>
      <p>
        Downloaded Spotify app control works with Spotify Free and does not require a Client ID.
        Orbit opens Spotify Quick Search, selects the top result, and uses Windows media keys for
        play, pause, next, and previous. Web API mode is optional and requires Spotify Premium.
      </p>

      <div className="spotify-grid">
        <label>
          Spotify control
          <select
            value={playbackMode}
            onChange={(event) =>
              setPlaybackMode(event.target.value === 'web-api' ? 'web-api' : 'desktop')
            }
          >
            <option value="desktop">Downloaded app (works with Free)</option>
            <option value="web-api">Official Web API (Premium)</option>
          </select>
        </label>
        <label>
          Preferred provider
          <select
            value={preferredProvider}
            onChange={(event) =>
              setPreferredProvider(event.target.value === 'youtube' ? 'youtube' : 'spotify')
            }
          >
            <option value="spotify">Spotify</option>
            <option value="youtube">YouTube browser</option>
          </select>
        </label>
        <label className="spotify-fallback-toggle">
          <input
            type="checkbox"
            checked={fallbackEnabled}
            onChange={(event) => setFallbackEnabled(event.target.checked)}
          />
          Open YouTube only when Spotify desktop control fails
        </label>
      </div>

      {webApiMode ? (
        <>
          <div className="spotify-grid spotify-web-api-grid">
            <label className="spotify-client-id">
              Spotify Client ID
              <input
                type="text"
                value={clientId}
                maxLength={100}
                spellCheck={false}
                autoComplete="off"
                placeholder="Paste the Client ID from Spotify Developer Dashboard"
                onChange={(event) => setClientId(event.target.value.replace(/\s/g, ''))}
              />
            </label>
          </div>

          <div className="spotify-redirect">
            <span>Redirect URI to add in Spotify:</span>
            <code>{status?.redirectUri ?? 'http://127.0.0.1:43821/spotify/callback'}</code>
          </div>
        </>
      ) : null}

      <div className="spotify-actions">
        <span
          className={
            webApiMode && status?.connected ? 'spotify-connected' : 'spotify-disconnected'
          }
        >
          {webApiMode
            ? status?.connected
              ? `Connected${status.displayName ? ` as ${status.displayName}` : ''}${status.product ? ` · ${status.product}` : ''}`
              : 'Web API not connected'
            : 'Downloaded Spotify app mode · no Premium required'}
        </span>
        <div>
          <button type="button" onClick={() => void save()} disabled={busy !== null}>
            {busy === 'saving' ? 'Saving...' : 'Save'}
          </button>
          {webApiMode ? (
            status?.connected ? (
              <button type="button" onClick={() => void disconnect()} disabled={busy !== null}>
                {busy === 'disconnecting' ? 'Disconnecting...' : 'Disconnect'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void connect()}
                disabled={busy !== null || clientId.trim().length < 16}
              >
                {busy === 'connecting' ? 'Waiting for Spotify...' : 'Connect Spotify'}
              </button>
            )
          ) : null}
        </div>
      </div>

      {notice ? (
        <p className={notice.ok ? 'spotify-success' : 'spotify-error'} role="status">
          {notice.message}
        </p>
      ) : null}
    </fieldset>
  )
}
