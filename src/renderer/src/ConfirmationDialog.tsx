import type { ConfirmationPrompt } from '../../shared/types'

type ConfirmationDialogProps = {
  confirmation: ConfirmationPrompt
  disabled: boolean
  onRespond: (approved: boolean) => void
}

export function ConfirmationDialog({
  confirmation,
  disabled,
  onRespond
}: ConfirmationDialogProps): React.JSX.Element {
  return (
    <section
      className="confirmation-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirmation-title"
      aria-describedby="confirmation-summary"
    >
      <h3 id="confirmation-title">Confirm action</h3>
      <p id="confirmation-summary">{confirmation.summary}</p>
      <div>
        <button type="button" onClick={() => onRespond(false)} disabled={disabled}>
          Cancel
        </button>
        <button type="button" onClick={() => onRespond(true)} disabled={disabled} autoFocus>
          {disabled ? 'Executing...' : 'Continue'}
        </button>
      </div>
    </section>
  )
}
