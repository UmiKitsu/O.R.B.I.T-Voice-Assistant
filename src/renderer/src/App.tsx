import { FormEvent, useRef, useState } from 'react'
import type {
  ActionResult,
  ChatMessage,
  ConfirmationPrompt,
  OllamaHealth,
  TitanStatus
} from '../../shared/types'
import { useSpeech } from './hooks/useSpeech'
import { useMicrophone } from './hooks/useMicrophone'
import { ConfirmationDialog } from './ConfirmationDialog'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<TitanStatus>('disabled')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isTranscribedDraft, setIsTranscribedDraft] = useState(false)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [connectionResult, setConnectionResult] = useState<ActionResult<OllamaHealth> | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [speechEnabled, setSpeechEnabled] = useState(true)
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationPrompt | null>(null)
  const isEnabled = useRef(false)
  const requestGeneration = useRef(0)
  const messageInputRef = useRef<HTMLInputElement>(null)
  const { startRecording, stopAndTranscribe, cancelRecording, cancelTranscription } =
    useMicrophone()
  const {
    speak,
    stop: stopSpeaking,
    speaking,
    voices,
    selectedVoice,
    setSelectedVoice,
    rate,
    setRate,
    volume,
    setVolume
  } = useSpeech(speechEnabled)

  const enableTitan = (): void => {
    isEnabled.current = true
    setConversationError(null)
    setStatus('ready')
  }

  const disableTitan = async (): Promise<void> => {
    isEnabled.current = false
    stopSpeaking()
    if (status === 'listening') cancelRecording()
    if (status === 'transcribing') await cancelTranscription()
    requestGeneration.current += 1
    setConversationError(null)
    setPendingConfirmation(null)
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
    setIsTranscribedDraft(false)

    let awaitingConfirmation = false
    try {
      const result = await window.titan.askAssistant(message)
      if (requestGeneration.current !== generation) return

      if (result.ok) {
        const response = result.data?.response
        const effects = result.data?.effects ?? []
        const confirmation = result.data?.confirmation ?? null
        awaitingConfirmation = confirmation !== null
        setPendingConfirmation(confirmation)
        if (confirmation) setStatus('awaiting-confirmation')

        if (response) {
          setMessages((current) => [...current, { role: 'assistant', content: response }])
          if (effects.includes('stop-speaking') || effects.includes('disable')) {
            stopSpeaking()
          } else {
            speak(response)
          }

          if (effects.includes('disable')) {
            isEnabled.current = false
            requestGeneration.current += 1
            setStatus('disabled')
          }
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
      if (!awaitingConfirmation && requestGeneration.current === generation && isEnabled.current)
        setStatus('ready')
    }
  }

  const respondToConfirmation = async (approved: boolean): Promise<void> => {
    const confirmation = pendingConfirmation
    if (!confirmation) return
    setStatus('executing')
    setConversationError(null)
    try {
      const result = await window.titan.confirmAction(confirmation.requestId, approved)
      setPendingConfirmation(null)
      if (result.ok) {
        const response = result.data?.response
        if (response) {
          setMessages((current) => [...current, { role: 'assistant', content: response }])
          speak(response)
        }
      } else {
        setConversationError(result.message)
      }
    } catch {
      setPendingConfirmation(null)
      setConversationError('T.I.T.A.N. could not complete the confirmation request.')
    } finally {
      if (isEnabled.current) setStatus('ready')
    }
  }
  const handleMicrophone = async (): Promise<void> => {
    setConversationError(null)
    stopSpeaking()

    if (status === 'listening') {
      setStatus('transcribing')
      try {
        const result = await stopAndTranscribe()
        if (!isEnabled.current) return
        if (result.ok && result.data?.text) {
          setDraft(result.data.text)
          setIsTranscribedDraft(true)
          requestAnimationFrame(() => messageInputRef.current?.focus())
        } else {
          setConversationError(result.message)
        }
      } catch {
        if (isEnabled.current) setConversationError('I could not understand the recording.')
      } finally {
        if (isEnabled.current) setStatus('ready')
      }
      return
    }

    if (status === 'transcribing') {
      const result = await cancelTranscription()
      setConversationError(result.message)
      if (isEnabled.current) setStatus('ready')
      return
    }

    const result = await startRecording()
    if (result.ok) {
      setIsTranscribedDraft(false)
      setStatus('listening')
    } else {
      setConversationError(result.message)
    }
  }

  const cancelActiveRecording = (): void => {
    const result = cancelRecording()
    setConversationError(result.message)
    if (isEnabled.current) setStatus('ready')
  }

  const cancelResponse = async (): Promise<void> => {
    requestGeneration.current += 1
    const result = await window.titan.cancelAssistant()
    setConversationError(result.message)
    if (isEnabled.current) setStatus('ready')
  }

  const clearConversation = async (): Promise<void> => {
    requestGeneration.current += 1
    setPendingConfirmation(null)
    if (status === 'listening') cancelRecording()
    if (status === 'transcribing') await cancelTranscription()
    const result = await window.titan.clearConversation()
    setMessages([])
    setDraft('')
    setIsTranscribedDraft(false)
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

  const displayedStatus = status === 'ready' && speaking ? 'speaking' : status
  const statusLabel = displayedStatus
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')

  const inputUnavailable =
    status === 'disabled' ||
    status === 'thinking' ||
    status === 'listening' ||
    status === 'transcribing' ||
    status === 'awaiting-confirmation' ||
    status === 'executing'
  const microphoneLabel =
    status === 'listening'
      ? 'Stop and transcribe'
      : status === 'transcribing'
        ? 'Cancel transcription'
        : 'Start recording'
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
          <div className={`status-pill status-${displayedStatus}`} role="status" aria-live="polite">
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
            <button
              type="button"
              onClick={clearConversation}
              disabled={messages.length === 0 && !draft}
            >
              Clear Conversation
            </button>
          </div>

          <div className="message-list" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty-conversation">
                <span aria-hidden="true">T</span>
                <h3>Ready when you are</h3>
                <p>Enable T.I.T.A.N. and type or record a message to begin.</p>
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

          {pendingConfirmation ? (
            <ConfirmationDialog
              confirmation={pendingConfirmation}
              disabled={status === 'executing'}
              onRespond={respondToConfirmation}
            />
          ) : null}
          <form className="message-form" onSubmit={handleSubmit}>
            <label className="sr-only" htmlFor="message-input">
              Message T.I.T.A.N.
            </label>
            <input
              ref={messageInputRef}
              id="message-input"
              type="text"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setIsTranscribedDraft(false)
              }}
              placeholder={status === 'listening' ? 'Listening...' : 'Type a message...'}
              maxLength={4000}
              disabled={inputUnavailable}
            />
            <button type="submit" disabled={inputUnavailable || draft.trim().length === 0}>
              {status === 'thinking' ? 'Thinking...' : 'Send'}
            </button>
          </form>
          {isTranscribedDraft ? (
            <p className="transcription-hint" role="status">
              Review the recognized text, correct it if needed, then press Send.
            </p>
          ) : null}
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
          <button
            className={status === 'listening' ? 'microphone-active' : ''}
            type="button"
            onClick={handleMicrophone}
            disabled={status === 'disabled' || status === 'thinking'}
            aria-pressed={status === 'listening'}
          >
            <span aria-hidden="true">●</span>
            {microphoneLabel}
          </button>
          {status === 'listening' ? (
            <button type="button" onClick={cancelActiveRecording}>
              Cancel Recording
            </button>
          ) : null}
          <button type="button" onClick={stopSpeaking} disabled={!speaking}>
            Stop Speaking
          </button>
          <label className="speech-toggle">
            <input
              type="checkbox"
              checked={speechEnabled}
              onChange={(event) => {
                const nextEnabled = event.target.checked
                if (!nextEnabled) stopSpeaking()
                setSpeechEnabled(nextEnabled)
              }}
            />
            Speak responses
          </label>
        </footer>
        <fieldset className="speech-settings" disabled={!speechEnabled}>
          <legend>Windows speech</legend>
          <label>
            Voice
            <select
              value={selectedVoice?.voiceURI ?? ''}
              onChange={(event) =>
                setSelectedVoice(
                  voices.find((voice) => voice.voiceURI === event.target.value) ?? null
                )
              }
            >
              {voices.length === 0 ? <option value="">No installed voices found</option> : null}
              {voices.map((voice) => (
                <option value={voice.voiceURI} key={voice.voiceURI}>
                  {voice.name} ({voice.lang})
                </option>
              ))}
            </select>
          </label>
          <label>
            Rate: {rate.toFixed(1)}
            <input
              type="range"
              min="0.5"
              max="2"
              step="0.1"
              value={rate}
              onChange={(event) => setRate(event.target.valueAsNumber)}
            />
          </label>
          <label>
            Volume: {Math.round(volume * 100)}%
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={(event) => setVolume(event.target.valueAsNumber)}
            />
          </label>
        </fieldset>
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
