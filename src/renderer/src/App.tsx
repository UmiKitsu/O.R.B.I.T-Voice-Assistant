import { FormEvent, useRef, useState } from 'react'
import type { ActionResult, ChatMessage, OllamaHealth, TitanStatus } from '../../shared/types'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<TitanStatus>('disabled')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [connectionResult, setConnectionResult] = useState<ActionResult<OllamaHealth> | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const isEnabled = useRef(false)
  const requestGeneration = useRef(0)

  const enableTitan = (): void => {
    isEnabled.current = true
    setConversationError(null)
    setStatus('ready')
  }

  const disableTitan = async (): Promise<void> => {
    isEnabled.current = false
    requestGeneration.current += 1
    setConversationError(null)
    setStatus('disabled')
    await window.titan.cancelAssistant()
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    const message = draft.trim()
    if (!message || !isEnabled.current || status === 'thinking') return

    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    setMessages((current) => [...current, { role: 'user', content: message }])
    setDraft('')
    setConversationError(null)
    setStatus('thinking')

    try {
      const result = await window.titan.askAssistant(message)
      if (requestGeneration.current !== generation) return

      if (result.ok) {
        const response = result.data?.response

        if (response) {
          setMessages((current) => [...current, { role: 'assistant', content: response }])
        } else {
          setConversationError('Ollama returned an invalid response.')
        }
      } else {
        setConversationError(result.message)
      }
    } catch {
      if (requestGeneration.current === generation) {
        setConversationError('T.I.T.A.N. could not send the request to the main process.')
      }
    } finally {
      if (requestGeneration.current === generation && isEnabled.current) setStatus('ready')
    }
  }

  const cancelResponse = async (): Promise<void> => {
    requestGeneration.current += 1
    const result = await window.titan.cancelAssistant()
    setConversationError(result.message)
    if (isEnabled.current) setStatus('ready')
  }

  const clearConversation = async (): Promise<void> => {
    requestGeneration.current += 1
    const result = await window.titan.clearConversation()
    setMessages([])
    setConversationError(result.ok ? null : result.message)
    if (isEnabled.current) setStatus('ready')
  }

  const testConnection = async (): Promise<void> => {
    setIsTestingConnection(true)
    setConnectionResult(null)
    try {
      setConnectionResult(await window.titan.checkOllama())
    } catch {
      setConnectionResult({
        ok: false,
        code: 'IPC_CONNECTION_FAILED',
        message: 'The Ollama connection check failed.',
        recoverable: true
      })
    } finally {
      setIsTestingConnection(false)
    }
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
            <div>
              <h2 id="conversation-title">Conversation</h2>
              <p>Your current session stays on this device.</p>
            </div>
            <button type="button" onClick={clearConversation} disabled={messages.length === 0}>
              Clear Conversation
            </button>
          </div>

          <div className="message-list" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-conversation">
                <span aria-hidden="true">T</span>
                <h3>Ready when you are</h3>
                <p>Enable T.I.T.A.N. and enter a message to begin.</p>
              </div>
            ) : (
              messages.map((message, index) => (
                <article
                  className={`message message-${message.role}`}
                  key={`${message.role}-${index}`}
                >
                  <span>{message.role === 'user' ? 'You' : 'T.I.T.A.N.'}</span>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>

          {conversationError ? (
            <p className="conversation-error" role="alert">
              {conversationError}
            </p>
          ) : null}

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
              maxLength={4000}
              disabled={status === 'disabled' || status === 'thinking'}
            />
            <button
              type="submit"
              disabled={status === 'disabled' || status === 'thinking' || draft.trim().length === 0}
            >
              {status === 'thinking' ? 'Thinking...' : 'Send'}
            </button>
          </form>
        </section>

        <footer className="control-bar">
          <button type="button" onClick={testConnection} disabled={isTestingConnection}>
            {isTestingConnection ? 'Testing Connection...' : 'Test Connection'}
          </button>
          {status === 'thinking' ? (
            <button type="button" onClick={cancelResponse}>
              Cancel Response
            </button>
          ) : null}
          <button type="button" disabled title="Speech-to-text will be added in a later phase">
            <span aria-hidden="true">●</span>
            Microphone — Coming Soon
          </button>
          <button type="button" disabled={status === 'disabled'}>
            Stop Speaking
          </button>
          <button type="button">Settings</button>
        </footer>
        {connectionResult ? (
          <p
            className={`connection-result ${connectionResult.ok ? 'connection-success' : 'connection-error'}`}
            role="status"
          >
            {connectionResult.message}
          </p>
        ) : null}
      </section>
    </main>
  )
}

export default App
