import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActionResult,
  ConfirmationPrompt,
  OllamaHealth,
  TitanStatus,
  VoiceTranscript,
  WakeWordEvent,
  WakeWordState
} from '../../shared/types'
import { ConfirmationDialog } from './ConfirmationDialog'
import { useSpeech } from './hooks/useSpeech'
import { useWakeWord } from './hooks/useWakeWord'
import { TRANSCRIPT_READY_HOLD_MS, WAKE_ACKNOWLEDGEMENT_MS } from './voiceCueTiming'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<TitanStatus>('disabled')
  const [assistantError, setAssistantError] = useState<string | null>(null)
  const [connectionResult, setConnectionResult] = useState<ActionResult<OllamaHealth> | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [wakeWordState, setWakeWordState] = useState<WakeWordState>('off')
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationPrompt | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState<VoiceTranscript | null>(null)
  const [wakeAcknowledged, setWakeAcknowledged] = useState(false)
  const isEnabled = useRef(false)
  const requestGeneration = useRef(0)
  const requestInFlight = useRef(false)
  const wakeCommandHandler = useRef<((message: string) => Promise<void>) | null>(null)
  const wakeAcknowledgementTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { stop: stopWakeWord, pause: pauseWakeWord, resume: resumeWakeWord } = useWakeWord()
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
  } = useSpeech()

  const clearWakeAcknowledgement = useCallback((): void => {
    if (wakeAcknowledgementTimer.current) clearTimeout(wakeAcknowledgementTimer.current)
    wakeAcknowledgementTimer.current = null
    setWakeAcknowledged(false)
  }, [])

  const acknowledgeWakeWord = useCallback((): void => {
    if (wakeAcknowledgementTimer.current) clearTimeout(wakeAcknowledgementTimer.current)
    setWakeAcknowledged(true)
    wakeAcknowledgementTimer.current = setTimeout(() => {
      wakeAcknowledgementTimer.current = null
      setWakeAcknowledged(false)
    }, WAKE_ACKNOWLEDGEMENT_MS)
  }, [])

  const clearVoiceTranscript = useCallback((): void => {
    if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current)
    transcriptClearTimer.current = null
    setVoiceTranscript(null)
  }, [])

  useEffect(
    () => () => {
      if (wakeAcknowledgementTimer.current) clearTimeout(wakeAcknowledgementTimer.current)
      if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current)
    },
    []
  )
  useEffect(() => {
    let active = true
    void window.titan
      .getSettings()
      .then((result) => {
        if (!active || !result.ok || !result.data) return
        setRate(result.data.speechRate)
        setVolume(result.data.speechVolume)
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [setRate, setVolume])

  const saveSettings = (patch: Parameters<typeof window.titan.updateSettings>[0]): void => {
    void window.titan.updateSettings(patch).catch(() => undefined)
  }

  const enableTitan = async (): Promise<void> => {
    isEnabled.current = true
    setAssistantError(null)
    setWakeWordState('starting')
    setStatus('ready')

    const result = await resumeWakeWord()
    if (!result.ok && isEnabled.current) {
      setWakeWordState('error')
      setAssistantError(result.message)
      setStatus('error')
    }
  }

  const disableTitan = async (): Promise<void> => {
    isEnabled.current = false
    requestGeneration.current += 1
    stopSpeaking()
    setAssistantError(null)
    setPendingConfirmation(null)
    clearWakeAcknowledgement()
    clearVoiceTranscript()
    setWakeWordState('off')
    setStatus('disabled')
    await Promise.all([stopWakeWord(), window.titan.cancelAssistant()])
  }

  const submitMessage = async (message: string): Promise<void> => {
    const normalizedMessage = message.trim()
    if (
      !normalizedMessage ||
      !isEnabled.current ||
      status === 'thinking' ||
      requestInFlight.current
    ) {
      return
    }

    requestInFlight.current = true
    try {
      const pauseResult = await pauseWakeWord()
      if (!pauseResult.ok) {
        setAssistantError('T.I.T.A.N. could not pause voice listening.')
        return
      }
      if (!isEnabled.current) return

      const generation = requestGeneration.current + 1
      requestGeneration.current = generation
      setAssistantError(null)
      setStatus('thinking')

      let awaitingConfirmation = false
      try {
        const result = await window.titan.askAssistant(normalizedMessage)
        if (requestGeneration.current !== generation) return

        if (result.ok) {
          const response = result.data?.response
          const effects = result.data?.effects ?? []
          const confirmation = result.data?.confirmation ?? null
          awaitingConfirmation = confirmation !== null
          setPendingConfirmation(confirmation)
          if (confirmation) setStatus('awaiting-confirmation')

          if (response) {
            if (effects.includes('stop-speaking') || effects.includes('disable')) {
              stopSpeaking()
            } else {
              speak(response)
            }

            if (effects.includes('disable')) {
              isEnabled.current = false
              requestGeneration.current += 1
              clearWakeAcknowledgement()
              clearVoiceTranscript()
              setWakeWordState('off')
              await stopWakeWord()
              setStatus('disabled')
            }
          } else {
            setAssistantError('Ollama returned an invalid response.')
          }
        } else {
          setAssistantError(result.message)
        }
      } catch {
        if (requestGeneration.current === generation) {
          setAssistantError('T.I.T.A.N. could not send the request to the main process.')
        }
      } finally {
        if (
          !awaitingConfirmation &&
          requestGeneration.current === generation &&
          isEnabled.current
        ) {
          setStatus('ready')
        }
      }
    } finally {
      requestInFlight.current = false
    }
  }

  useEffect(() => {
    wakeCommandHandler.current = submitMessage
  })

  const respondToConfirmation = async (approved: boolean): Promise<void> => {
    const confirmation = pendingConfirmation
    if (!confirmation) return
    setStatus('executing')
    setAssistantError(null)
    try {
      const result = await window.titan.confirmAction(confirmation.requestId, approved)
      setPendingConfirmation(null)
      if (result.ok) {
        const response = result.data?.response
        if (response) speak(response)
      } else {
        setAssistantError(result.message)
      }
    } catch {
      setPendingConfirmation(null)
      setAssistantError('T.I.T.A.N. could not complete the confirmation request.')
    } finally {
      if (isEnabled.current) setStatus('ready')
    }
  }

  const cancelResponse = async (): Promise<void> => {
    requestGeneration.current += 1
    clearWakeAcknowledgement()
    clearVoiceTranscript()
    const result = await window.titan.cancelAssistant()
    setAssistantError(result.message)
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

  useEffect(() => {
    return window.titan.onWakeWordEvent((event: WakeWordEvent) => {
      if (event.type === 'state') {
        setWakeWordState(event.state)
        if (event.state === 'detected') {
          clearVoiceTranscript()
          acknowledgeWakeWord()
          stopSpeaking()
          setAssistantError(null)
          setStatus('listening')
        } else if (event.state === 'capturing') {
          stopSpeaking()
          setAssistantError(null)
          setStatus('listening')
        } else if (event.state === 'transcribing') {
          setStatus('transcribing')
        }
        return
      }

      if (event.type === 'error') {
        clearWakeAcknowledgement()
        clearVoiceTranscript()
        setWakeWordState(event.fatal ? 'error' : 'paused')
        setAssistantError(event.message)
        if (isEnabled.current) setStatus(event.fatal ? 'error' : 'ready')
        return
      }

      setVoiceTranscript(event.transcript)
      setWakeWordState('paused')
      void wakeCommandHandler.current?.(event.transcript.normalizedText)
    })
  }, [acknowledgeWakeWord, clearVoiceTranscript, clearWakeAcknowledgement, stopSpeaking])

  useEffect(() => {
    if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current)
    transcriptClearTimer.current = null
    if (!voiceTranscript || status !== 'ready' || speaking) return

    transcriptClearTimer.current = setTimeout(() => {
      transcriptClearTimer.current = null
      setVoiceTranscript(null)
    }, TRANSCRIPT_READY_HOLD_MS)

    return () => {
      if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current)
      transcriptClearTimer.current = null
    }
  }, [speaking, status, voiceTranscript])

  useEffect(() => {
    let active = true
    if (!isEnabled.current || wakeWordState === 'error') {
      return () => {
        active = false
      }
    }

    const wakeWordOwnsAudio =
      wakeWordState === 'detected' ||
      wakeWordState === 'capturing' ||
      wakeWordState === 'transcribing'
    if (!wakeWordOwnsAudio) {
      if (status === 'ready' && !speaking) {
        void resumeWakeWord().then((result) => {
          if (active && !result.ok && isEnabled.current) {
            setWakeWordState('error')
            setAssistantError(result.message)
            setStatus('error')
          }
        })
      } else {
        void pauseWakeWord()
      }
    }

    return () => {
      active = false
    }
  }, [pauseWakeWord, resumeWakeWord, speaking, status, wakeWordState])

  const displayedStatus = status === 'ready' && speaking ? 'speaking' : status
  const statusLabel = displayedStatus
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
  const statusMessage: Record<TitanStatus, string> = {
    disabled: 'Enable T.I.T.A.N. to begin local voice listening.',
    ready: 'Say “TITAN” followed by your command.',
    listening: 'Listening for your command…',
    transcribing: 'Transcribing your command locally…',
    thinking: 'Preparing a response…',
    'awaiting-confirmation': 'Your confirmation is required.',
    executing: 'Executing the confirmed action…',
    speaking: 'Speaking the response…',
    error: 'Voice listening needs your attention.'
  }
  const primaryStatusLabel = wakeAcknowledged ? 'T.I.T.A.N. heard you' : statusLabel
  const primaryStatusMessage = wakeAcknowledged
    ? 'Listening for your command…'
    : statusMessage[displayedStatus]
  const commandWasCorrected =
    voiceTranscript !== null &&
    voiceTranscript.rawText.toLocaleLowerCase() !==
      voiceTranscript.normalizedText.toLocaleLowerCase()

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
          <div className="header-statuses">
            <div
              className={`status-pill status-${displayedStatus}`}
              role="status"
              aria-live="polite"
            >
              <span className="status-dot" aria-hidden="true" />
              Status: {statusLabel}
            </div>
            <div
              className={`wake-word-pill wake-word-${wakeWordState}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true" />
              Voice: {wakeWordState}
            </div>
          </div>
        </header>

        <button
          className={`enable-button ${status === 'disabled' ? '' : 'disable-button'}`}
          type="button"
          onClick={() => void (status === 'disabled' ? enableTitan() : disableTitan())}
        >
          {status === 'disabled' ? 'Enable T.I.T.A.N.' : 'Disable T.I.T.A.N.'}
        </button>

        <section
          className={`voice-status voice-status-${displayedStatus}${wakeAcknowledged ? ' wake-acknowledged' : ''}`}
          aria-live="polite"
        >
          <div className="voice-orb" aria-hidden="true">
            <span>T</span>
          </div>
          {displayedStatus === 'listening' ? (
            <div className="voice-waveform" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : null}
          <h2>{primaryStatusLabel}</h2>
          <p>{primaryStatusMessage}</p>

          {voiceTranscript ? (
            <div className="voice-transcript" role="status">
              <p>
                <span>Heard</span> “{voiceTranscript.rawText}”
              </p>
              {commandWasCorrected ? (
                <p className="voice-understood">
                  <span>Understood</span> “{voiceTranscript.normalizedText}”
                </p>
              ) : null}
            </div>
          ) : null}

          {assistantError ? (
            <p className="assistant-error" role="alert">
              {assistantError}
            </p>
          ) : null}

          {pendingConfirmation ? (
            <ConfirmationDialog
              confirmation={pendingConfirmation}
              disabled={status === 'executing'}
              onRespond={respondToConfirmation}
            />
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
          <button type="button" onClick={stopSpeaking} disabled={!speaking}>
            Stop Speaking
          </button>
        </footer>

        <fieldset className="speech-settings">
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
              onChange={(event) => {
                setRate(event.target.valueAsNumber)
                saveSettings({ speechRate: event.target.valueAsNumber })
              }}
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
              onChange={(event) => {
                setVolume(event.target.valueAsNumber)
                saveSettings({ speechVolume: event.target.valueAsNumber })
              }}
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
