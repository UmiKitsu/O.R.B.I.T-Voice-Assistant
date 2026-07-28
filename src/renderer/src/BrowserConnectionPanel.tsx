import { useCallback, useEffect, useState } from 'react'
import type {
  BrowserConnectionStatus,
  BrowserPairingSession
} from '../../shared/types'
import { getBrowserConnectionView } from './browserConnectionView'

const EMPTY_STATUS: BrowserConnectionStatus = {
  paired: false,
  connected: false,
  browser: 'chrome',
  phase: 'unpaired',
  pairingState: 'none',
  expectedExtensionId: 'unknown',
  grantedOrigins: []
}

export function BrowserConnectionPanel(): React.JSX.Element {
  const [status, setStatus] = useState<BrowserConnectionStatus>(EMPTY_STATUS)
  const [pairing, setPairing] = useState<BrowserPairingSession | null>(null)
  const [extensionPath, setExtensionPath] = useState('')
  const [browserControlEnabled, setBrowserControlEnabled] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [secondsRemaining, setSecondsRemaining] = useState(0)

  const applyStatus = useCallback((nextStatus: BrowserConnectionStatus): void => {
    setStatus(nextStatus)
    if (nextStatus.paired) {
      setPairing(null)
      setSecondsRemaining(0)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.orbit.getBrowserStatus().catch(() => null)
    if (result?.ok && result.data) applyStatus(result.data)
  }, [applyStatus])

  useEffect(() => {
    let active = true
    void Promise.all([
      window.orbit.getBrowserExtensionPath(),
      window.orbit.getSettings(),
      window.orbit.getBrowserStatus()
    ]).then(([pathResult, settingsResult, statusResult]) => {
      if (!active) return
      if (pathResult.ok && pathResult.data) setExtensionPath(pathResult.data.path)
      if (settingsResult.ok && settingsResult.data) {
        setBrowserControlEnabled(settingsResult.data.browserControlEnabled)
      }
      if (statusResult.ok && statusResult.data) applyStatus(statusResult.data)
    })
    const timer = setInterval(() => void refresh(), 2_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [applyStatus, refresh])

  useEffect(() => {
    if (!pairing) return undefined
    const timer = setInterval(() => {
      setSecondsRemaining(Math.max(0, Math.ceil((pairing.expiresAt - Date.now()) / 1_000)))
    }, 1_000)
    return () => clearInterval(timer)
  }, [pairing])

  const beginPairing = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const result = await window.orbit.beginBrowserPairing().catch(() => null)
    setBusy(false)
    if (!result?.ok || !result.data) {
      setNotice(result?.message ?? 'Orbit could not start browser pairing.')
      return
    }
    setPairing(result.data)
    setSecondsRemaining(Math.max(0, Math.ceil((result.data.expiresAt - Date.now()) / 1_000)))
    setExtensionPath(result.data.extensionPath)
    setNotice('Open the extension options and enter this port and one-time code.')
    await refresh()
  }

  const retry = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    const result = await window.orbit.retryBrowserConnection().catch(() => null)
    setBusy(false)
    if (!result?.ok || !result.data) {
      setNotice(result?.message ?? 'Orbit could not prepare the browser reconnection.')
      return
    }
    applyStatus(result.data)
    setNotice('Orbit is ready. Use Retry connection in the extension if Chrome has not reconnected yet.')
  }

  const forgetPairing = async (): Promise<void> => {
    setBusy(true)
    const result = await window.orbit.disconnectBrowser().catch(() => null)
    setBusy(false)
    setPairing(null)
    setSecondsRemaining(0)
    if (result?.ok && result.data) {
      applyStatus(result.data.status)
      setNotice(result.data.warning ?? 'Orbit and Chrome forgot the pairing.')
    } else {
      setNotice(result?.message ?? 'Orbit could not forget the browser pairing.')
    }
  }

  const saveBrowserSetting = async (
    patch: Parameters<typeof window.orbit.updateSettings>[0]
  ): Promise<void> => {
    const result = await window.orbit.updateSettings(patch).catch(() => null)
    if (!result?.ok || !result.data) {
      setNotice(result?.message ?? 'The browser setting could not be saved.')
      return
    }
    setBrowserControlEnabled(result.data.browserControlEnabled)
  }

  const view = getBrowserConnectionView(status)

  return (
    <fieldset className="browser-connection-panel">
      <legend>Chrome browser connection</legend>
      <div className="browser-connection-heading">
        <div>
          <strong>{view.heading}</strong>
          <p>{view.description}</p>
          {view.showPairedSummary ? (
            <p><strong>Paired—reconnects automatically after updates and restarts.</strong></p>
          ) : null}
        </div>
        <span className={`browser-health ${status.connected ? 'online' : ''}`} aria-hidden="true" />
      </div>

      {view.showMigration ? (
        <ol className="browser-setup-steps">
          <li>
            Open <code>chrome://extensions</code> and remove the legacy Orbit Browser Control
            {status.legacyExtensionId ? <code> ({status.legacyExtensionId})</code> : null}.
          </li>
          <li>Choose Load unpacked and select <code>{extensionPath || 'Loading extension path…'}</code>.</li>
          <li>Click Begin one-time pairing below, then enter the new code in the updated extension.</li>
        </ol>
      ) : null}

      {view.showSetup ? (
        <ol className="browser-setup-steps">
          <li>Open <code>chrome://extensions</code> in Chrome.</li>
          <li>Enable Developer mode, then choose Load unpacked.</li>
          <li>Select <code>{extensionPath || 'Loading extension path…'}</code>.</li>
          <li>Open Orbit Browser Control and enter the pairing details below.</li>
        </ol>
      ) : null}

      {pairing && !status.paired ? (
        <div className="browser-pairing-code" role="status">
          <span>Port <strong>{pairing.port}</strong></span>
          <span>One-time code <strong>{pairing.code}</strong></span>
          <small>Expires in about {secondsRemaining} seconds.</small>
        </div>
      ) : null}

      <div className="browser-panel-actions">
        {view.canBeginPairing ? (
          <button type="button" disabled={busy} onClick={() => void beginPairing()}>
            {busy ? 'Working…' : view.showMigration ? 'Begin one-time pairing' : 'Begin pairing'}
          </button>
        ) : null}
        {view.canRetry ? (
          <button type="button" disabled={busy} onClick={() => void retry()}>
            Retry connection
          </button>
        ) : null}
        {view.canForget ? (
          <button type="button" disabled={busy} onClick={() => void forgetPairing()}>
            Forget pairing
          </button>
        ) : null}
      </div>

      <label className="browser-setting-toggle">
        <input
          type="checkbox"
          checked={browserControlEnabled}
          onChange={(event) => {
            const enabled = event.target.checked
            setBrowserControlEnabled(enabled)
            void saveBrowserSetting({ browserControlEnabled: enabled })
          }}
        />
        Enable typed browser control
      </label>
      <div className="browser-granted-sites">
        <strong>Granted sites</strong>
        {status.grantedOrigins.length > 0 ? (
          <ul>
            {status.grantedOrigins.map((origin) => <li key={origin}>{origin}</li>)}
          </ul>
        ) : (
          <p>No optional sites granted. YouTube access is included for stage one.</p>
        )}
      </div>

      {notice ? <p className="browser-panel-notice" role="status">{notice}</p> : null}
      {status.retryAt ? (
        <small>Next automatic retry: {new Date(status.retryAt).toLocaleTimeString()}</small>
      ) : status.lastSeenAt ? (
        <small>Last extension contact: {new Date(status.lastSeenAt).toLocaleTimeString()}</small>
      ) : null}
    </fieldset>
  )
}
