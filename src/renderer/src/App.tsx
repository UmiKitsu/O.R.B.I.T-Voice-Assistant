import { FormEvent, useState } from 'react'
import type { ChatMessage, TitanStatus } from '../../shared/types'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<TitanStatus>('disabled')
  const [messages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')

  const enableTitan = (): void => {
    setStatus('ready')
  }

  const disableTitan = (): void => {
    // Future recording, speech, Ollama, and confirmation services will be
    // cancelled here before the assistant returns to its inactive state.
    setStatus('disabled')
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
  }

  const statusLabel = status
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')

  return (
    <main className="app-shell">
      <section className="assistant-card" aria-labelledby="app-title">
        <header className="app-header">
          <div className="brand-mark" aria-hidden="true">
            T
          </div>
          <div>
            <h1 id="app-title">T.I.T.A.N.</h1>
            <p>Local Voice Assistant</p>
          </div>
          <div className={`status-pill status-${status}`} role="status" aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            Status: {statusLabel}
          </div>
        </header>

        <button
          className={`enable-button ${status === 'disabled' ? '' : 'disable-button'}`}
          type="button"
          onClick={status === 'disabled' ? enableTitan : disableTitan}
        >
          {status === 'disabled' ? 'Enable T.I.T.A.N.' : 'Disable T.I.T.A.N.'}
        </button>

        <section className="conversation" aria-labelledby="conversation-title">
          <div className="section-heading">
            <h2 id="conversation-title">Conversation</h2>
            <p>Your current session stays on this device.</p>
          </div>

          <div className="message-list" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-conversation">
                <span aria-hidden="true">◎</span>
                <h3>Ready when you are</h3>
                <p>Enable T.I.T.A.N. and enter a message to begin.</p>
              </div>
            ) : null}
          </div>

          <form className="message-form" onSubmit={handleSubmit}>
            <label className="sr-only" htmlFor="message-input">
              Message T.I.T.A.N.
            </label>
            <input
              id="message-input"
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type a message..."
              disabled={status === 'disabled'}
            />
            <button type="submit" disabled={status === 'disabled' || draft.trim().length === 0}>
              Send
            </button>
          </form>
        </section>

        <footer className="control-bar">
          <button type="button" disabled title="Speech-to-text will be added in a later phase">
            <span aria-hidden="true">●</span>
            Microphone — Coming Soon
          </button>
          <button type="button" disabled={status === 'disabled'}>
            Stop Speaking
          </button>
          <button type="button">Settings</button>
        </footer>
      </section>
    </main>
  )
}

export default App
