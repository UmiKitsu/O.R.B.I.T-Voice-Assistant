import { useCallback, useEffect, useState } from 'react'
import type {
  BrowserConnectionStatus,
  BrowserPairingSession
} from '../../shared/types'

const EMPTY_STATUS: BrowserConnectionStatus = {
  paired: false,
  connected: false,
  browser: 'chrome',
  grantedOrigins: []
}

export function BrowserConnectionPanel(): React.JSX.Element {
  const [status, setStatus] = useState<BrowserConnectionStatus>(EMPTY_STATUS)
  const [pairing, setPairing] = useState<BrowserPairingSession | null>(null)
  const [extensionPath, setExtensionPath] = useState('')
  const [browserControlEnabled, setBrowserControlEnabled] = useState(false)
  const [generalAutomationEnabled, setGeneralAutomationEnabled] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [secondsRemaining, setSecondsRemaining] = useState(0)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await window.orbit.getBrowserStatus().catch(() => null)
    if (result?.ok && result.data) setStatus(result.data)
  }, [])

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
        setGeneralAutomationEnabled(settingsResult.data.generalBrowserAutomationEnabled)
      }
      if (statusResult.ok && statusResult.data) setStatus(statusResult.data)
    })
    const timer = setInterval(() => void refresh(), 2_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [refresh])

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
  }

  const disconnect = async (): Promise<void> => {
    setBusy(true)
    const result = await window.orbit.disconnectBrowser().catch(() => null)
    setBusy(false)
    setPairing(null)
    setSecondsRemaining(0)
    if (result?.ok && result.data) {
      setStatus(result.data)
      setNotice('Orbit forgot its browser pairing. Also choose “Forget pairing” in the extension.')
    } else {
      setNotice(result?.message ?? 'Orbit could not disconnect the browser extension.')
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
    setGeneralAutomationEnabled(result.data.generalBrowserAutomationEnabled)
  }

  return (
    <fieldset className="browser-connection-panel">
      <legend>Chrome browser connection</legend>
      <div className="browser-connection-heading">
        <div>
          <strong>{status.connected ? 'Connected' : status.paired ? 'Paired, offline' : 'Not paired'}</strong>
          <p>
            {status.connected
              ? `Chrome extension ${status.extensionVersion ?? 'version unknown'} is responding.`
              : 'Orbit uses its own trusted unpacked extension for typed browser actions.'}
          </p>
        </div>
        <span className={`browser-health ${status.connected ? 'online' : ''}`} aria-hidden="true" />
      </div>

      <ol className="browser-setup-steps">
        <li>Open <code>chrome://extensions</code> in Chrome.</li>
        <li>Enable Developer mode, then choose Load unpacked.</li>
        <li>Select <code>{extensionPath || 'Loading extension path…'}</code>.</li>
        <li>Open Orbit Browser Control and enter the pairing details below.</li>
      </ol>

      {pairing ? (
        <div className="browser-pairing-code" role="status">
          <span>Port <strong>{pairing.port}</strong></span>
          <span>One-time code <strong>{pairing.code}</strong></span>
          <small>Expires in about {secondsRemaining} seconds.</small>
        </div>
      ) : null}

      <div className="browser-panel-actions">
        <button type="button" disabled={busy} onClick={() => void beginPairing()}>
          {busy ? 'Working…' : 'Begin pairing'}
        </button>
        <button type="button" disabled={busy || (!status.paired && !status.connected)} onClick={() => void disconnect()}>
          Disconnect
        </button>
      </div>

      <label className="browser-setting-toggle">
        <input
          type="checkbox"
          checked={browserControlEnabled}
          onChange={(event) => {
            const enabled = event.target.checked
            setBrowserControlEnabled(enabled)
            if (!enabled) setGeneralAutomationEnabled(false)
            void saveBrowserSetting({
              browserControlEnabled: enabled,
              ...(!enabled ? { generalBrowserAutomationEnabled: false } : {})
            })
          }}
        />
        Enable typed browser control
      </label>
      <label className="browser-setting-toggle">
        <input
          type="checkbox"
          checked={generalAutomationEnabled}
          disabled={!browserControlEnabled}
          onChange={(event) => {
            setGeneralAutomationEnabled(event.target.checked)
            void saveBrowserSetting({ generalBrowserAutomationEnabled: event.target.checked })
          }}
        />
        Enable guarded general page automation
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
      {status.lastSeenAt ? <small>Last extension contact: {new Date(status.lastSeenAt).toLocaleTimeString()}</small> : null}
    </fieldset>
  )
}
