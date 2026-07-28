import { useState } from 'react'
import type { ScreenAwarenessStatus } from '../../shared/types'

type ScreenAwarenessPanelProps = {
  status: ScreenAwarenessStatus | null
  onStatusChange: (status: ScreenAwarenessStatus) => void
}

export function ScreenAwarenessPanel({
  status,
  onStatusChange
}: ScreenAwarenessPanelProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.orbit.refreshScreenAwareness()
      if (result.ok && result.data) onStatusChange(result.data)
      else setError(result.message)
    } catch {
      setError('Orbit could not refresh screen-awareness status.')
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (): Promise<void> => {
    const enabled = !(status?.enabled ?? false)
    setBusy(true)
    setError(null)
    try {
      const saved = await window.orbit.updateSettings({ screenAwarenessEnabled: enabled })
      if (!saved.ok) {
        setError(saved.message)
        return
      }
      const result = await window.orbit.refreshScreenAwareness()
      if (result.ok && result.data) onStatusChange(result.data)
      else setError(result.message)
    } catch {
      setError('Orbit could not update screen awareness.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="screen-awareness-settings">
      <legend>Foreground screen awareness</legend>
      <div className="screen-awareness-heading">
        <div>
          <strong>{status?.enabled ? 'Screen awareness is on' : 'Screen awareness is off'}</strong>
          <p>
            Orbit inspects only the active window when your request needs it. Screenshots stay in
            memory and are analyzed locally.
          </p>
        </div>
        <button
          type="button"
          className={status?.enabled ? 'screen-toggle screen-toggle-on' : 'screen-toggle'}
          aria-pressed={status?.enabled ?? false}
          onClick={() => void toggle()}
          disabled={busy}
        >
          {busy ? 'Working…' : status?.enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      {status ? (
        <dl className="screen-awareness-details">
          <div>
            <dt>Windows controls</dt>
            <dd>{status.uiAutomationReady ? 'ready' : 'unavailable'}</dd>
          </div>
          <div>
            <dt>Vision model</dt>
            <dd>{status.visionModel}</dd>
          </div>
          <div>
            <dt>Vision fallback</dt>
            <dd>
              {status.visionReady
                ? status.visionWarm
                  ? 'ready and warm'
                  : 'installed'
                : 'not installed'}
            </dd>
          </div>
          <div>
            <dt>Processor</dt>
            <dd>{status.processor ?? 'unknown'}</dd>
          </div>
        </dl>
      ) : null}
      <p
        className={status?.phase === 'degraded' || error ? 'screen-awareness-warning' : ''}
        role="status"
      >
        {error ?? status?.message ?? 'Checking local screen-awareness support.'}
      </p>
      {status?.enabled ? (
        <button
          type="button"
          className="screen-refresh"
          onClick={() => void refresh()}
          disabled={busy}
        >
          Refresh status
        </button>
      ) : null}
    </fieldset>
  )
}
