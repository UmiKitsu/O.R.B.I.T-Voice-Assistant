import { useState } from 'react'
import type { ConfirmationPrompt } from '../../shared/types'

type ConfirmationDialogProps = {
  confirmation: ConfirmationPrompt
  disabled: boolean
  pinConfigured: boolean
  onRespond: (approved: boolean, pin?: string) => void
}

function sanitizePin(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4)
}

export function ConfirmationDialog({
  confirmation,
  disabled,
  pinConfigured,
  onRespond
}: ConfirmationDialogProps): React.JSX.Element {
  const [pin, setPin] = useState('')

  const requiresPin = confirmation.authorization === 'pin'
  const canAuthorize = !disabled && (!requiresPin || (pinConfigured && pin.length === 4))

  return (
    <section
      className="confirmation-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-summary"
    >
      <h3 id="confirmation-title">
        {requiresPin ? 'Protected action' : 'Confirm action'}
      </h3>
      <p id="confirmation-summary">{confirmation.summary}</p>

      {requiresPin ? (
        pinConfigured ? (
          <label className="authorization-pin-label">
            Four-digit security PIN
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              autoComplete="off"
              value={pin}
              onChange={(event) => setPin(sanitizePin(event.target.value))}
              disabled={disabled}
              autoFocus
              aria-label="Four-digit security PIN"
            />
            <small>You may also say “Orbit” followed by the four digits.</small>
          </label>
        ) : (
          <p className="pin-required-notice" role="status">
            Create a four-digit PIN in the Protected-action security PIN section below, then enter
            it here to authorize this exact action.
          </p>
        )
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => {
            setPin('')
            onRespond(false)
          }}
          disabled={disabled}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            const submittedPin = requiresPin ? pin : undefined
            setPin('')
            onRespond(true, submittedPin)
          }}
          disabled={!canAuthorize}
          autoFocus={!requiresPin}
        >
          {disabled ? 'Executing...' : requiresPin ? 'Authorize' : 'Continue'}
        </button>
      </div>
    </section>
  )
}
