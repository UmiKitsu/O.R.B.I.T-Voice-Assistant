import { useState } from 'react'
import type { ActionResult, SecurityPinStatus } from '../../shared/types'

type SecurityPinSettingsProps = {
  status: SecurityPinStatus | null
  onStatusChange: (status: SecurityPinStatus) => void
}

function pinValue(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4)
}

export function SecurityPinSettings({
  status,
  onStatusChange
}: SecurityPinSettingsProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [currentPin, setCurrentPin] = useState('')
  const [notice, setNotice] = useState<ActionResult<SecurityPinStatus> | null>(null)
  const [saving, setSaving] = useState(false)

  const clearInputs = (): void => {
    setPin('')
    setConfirmation('')
    setCurrentPin('')
  }

  const save = async (): Promise<void> => {
    if (pin.length !== 4 || confirmation.length !== 4) {
      setNotice({
        ok: false,
        code: 'INVALID_PIN',
        message: 'Enter and confirm exactly four digits.',
        recoverable: true
      })
      return
    }

    setSaving(true)
    setNotice(null)
    try {
      const result = status?.hasPin
        ? await window.orbit.changePin(currentPin, pin, confirmation)
        : await window.orbit.createPin(pin, confirmation)
      setNotice(result)
      if (result.ok && result.data) {
        onStatusChange(result.data)
        setEditing(false)
      }
    } catch {
      setNotice({
        ok: false,
        code: 'PIN_REQUEST_FAILED',
        message: 'Orbit could not save the security PIN.',
        recoverable: true
      })
    } finally {
      clearInputs()
      setSaving(false)
    }
  }

  const configured = status?.hasPin === true
  const showForm = !configured || editing

  return (
    <fieldset className="security-pin-settings">
      <legend>Protected-action security PIN</legend>
      <p>
        Dangerous file and installer actions require this four-digit PIN. Orbit never displays,
        repeats, or stores the PIN as plain text.
      </p>

      {configured && !editing ? (
        <div className="pin-configured-row">
          <span>PIN configured</span>
          <button
            type="button"
            onClick={() => {
              setEditing(true)
              setNotice(null)
            }}
          >
            Change PIN
          </button>
        </div>
      ) : null}

      {showForm ? (
        <div className="pin-form">
          {configured ? (
            <label>
              Current PIN
              <input
                type="password"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                autoComplete="off"
                value={currentPin}
                onChange={(event) => setCurrentPin(pinValue(event.target.value))}
                aria-label="Current four-digit PIN"
              />
            </label>
          ) : null}
          <label>
            {configured ? 'New PIN' : 'Create PIN'}
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="off"
              value={pin}
              onChange={(event) => setPin(pinValue(event.target.value))}
              aria-label={configured ? 'New four-digit PIN' : 'Create four-digit PIN'}
            />
          </label>
          <label>
            Confirm PIN
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(pinValue(event.target.value))}
              aria-label="Confirm four-digit PIN"
            />
          </label>
          <div className="pin-actions">
            {configured ? (
              <button
                type="button"
                onClick={() => {
                  setEditing(false)
                  setNotice(null)
                  clearInputs()
                }}
                disabled={saving}
              >
                Cancel
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void save()}
              disabled={
                saving ||
                pin.length !== 4 ||
                confirmation.length !== 4 ||
                (configured && currentPin.length !== 4)
              }
            >
              {saving ? 'Saving...' : configured ? 'Change PIN' : 'Create PIN'}
            </button>
          </div>
        </div>
      ) : null}

      {status?.temporarilyLocked ? (
        <p className="pin-error" role="alert">
          PIN verification is temporarily locked after repeated incorrect attempts.
        </p>
      ) : null}
      {notice ? (
        <p className={notice.ok ? 'pin-success' : 'pin-error'} role="status">
          {notice.message}
        </p>
      ) : null}
    </fieldset>
  )
}
