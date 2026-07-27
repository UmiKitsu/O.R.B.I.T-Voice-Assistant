import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActionResult,
  ConfirmationPrompt,
  OllamaHealth,
  OrbitStatus,
  VoiceDiagnostics,
  VoiceTranscript,
  WakeWordEvent,
  WakeWordState,
  WakeWordTestResult
} from '../../shared/types'
import { ConfirmationDialog } from './ConfirmationDialog'
import { useMicrophoneTest } from './hooks/useMicrophoneTest'
import { useSpeech } from './hooks/useSpeech'
import { useWakeWord } from './hooks/useWakeWord'
import { TRANSCRIPT_READY_HOLD_MS, WAKE_ACKNOWLEDGEMENT_MS } from './voiceCueTiming'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<OrbitStatus>('disabled')
  const [assistantError, setAssistantError] = useState<string | null>(null)
  const [connectionResult, setConnectionResult] = useState<ActionResult<OllamaHealth> | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [wakeWordState, setWakeWordState] = useState<WakeWordState>('off')
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationPrompt | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState<VoiceTranscript | null>(null)
  const [wakeAcknowledged, setWakeAcknowledged] = useState(false)
  const [voiceDiagnostics, setVoiceDiagnostics] = useState<VoiceDiagnostics | null>(null)
  const [voiceTranscriptIsTest, setVoiceTranscriptIsTest] = useState(false)
  const [recognitionLanguage, setRecognitionLanguage] = useState<'auto' | 'en'>('auto')
  const [wakeDetectionCount, setWakeDetectionCount] = useState(0)
  const [falseTriggerCount, setFalseTriggerCount] = useState(0)
  const [wakeWordTestPhase, setWakeWordTestPhase] = useState<'idle' | 'listening'>('idle')
  const [wakeWordTestResult, setWakeWordTestResult] = useState<WakeWordTestResult | null>(null)
  const isEnabled = useRef(false)
  const requestGeneration = useRef(0)
  const requestInFlight = useRef(false)
  const wakeCommandHandler = useRef<((message: string) => Promise<void>) | null>(null)
  const wakeAcknowledgementTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wakeWordTestWasEnabled = useRef(false)
  const {
    microphoneName: wakeMicrophoneName,
    inputLevel: wakeInputLevel,
    stop: stopWakeWord,
    pause: pauseWakeWord,
    resume: resumeWakeWord
  } = useWakeWord()
  const handleMicrophoneTestResult = useCallback(
    (result: ActionResult<import('../../shared/types').MicrophoneTestResult>): void => {
      if (result.ok && result.data) {
        setVoiceTranscript(result.data.transcript)
        setVoiceDiagnostics(result.data.diagnostics)
        setVoiceTranscriptIsTest(true)
        setAssistantError(null)
      } else {
        setAssistantError(result.message)
      }
      setStatus(isEnabled.current ? 'ready' : 'disabled')
    },
    []
  )
  const microphoneTest = useMicrophoneTest(handleMicrophoneTestResult)
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
    setVoiceDiagnostics(null)
    setVoiceTranscriptIsTest(false)
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
    void window.orbit
      .getSettings()
      .then((result) => {
        if (!active || !result.ok || !result.data) return
        setRate(result.data.speechRate)
        setVolume(result.data.speechVolume)
        setRecognitionLanguage(result.data.recognitionLanguage)
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [setRate, setVolume])

  const saveSettings = (patch: Parameters<typeof window.orbit.updateSettings>[0]): void => {
    void window.orbit.updateSettings(patch).catch(() => undefined)
  }

  const enableOrbit = async (): Promise<void> => {
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

  const disableOrbit = async (): Promise<void> => {
    isEnabled.current = false
    requestGeneration.current += 1
    stopSpeaking()
    setAssistantError(null)
    setPendingConfirmation(null)
    clearWakeAcknowledgement()
    clearVoiceTranscript()
    setWakeWordState('off')
    setStatus('disabled')
    setWakeWordTestPhase('idle')
    await Promise.all([
      stopWakeWord(),
      window.orbit.cancelWakeWordTest(),
      window.orbit.cancelAssistant(),
      microphoneTest.cancel()
    ])
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
        setAssistantError('Orbit could not pause voice listening.')
        return
      }
      if (!isEnabled.current) return

      const generation = requestGeneration.current + 1
      requestGeneration.current = generation
      setAssistantError(null)
      setStatus('thinking')

      let awaitingConfirmation = false
      try {
        const result = await window.orbit.askAssistant(normalizedMessage)
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
          setAssistantError('Orbit could not send the request to the main process.')
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
      const result = await window.orbit.confirmAction(confirmation.requestId, approved)
      setPendingConfirmation(null)
      if (result.ok) {
        const response = result.data?.response
        if (response) speak(response)
      } else {
        setAssistantError(result.message)
      }
    } catch {
      setPendingConfirmation(null)
      setAssistantError('Orbit could not complete the confirmation request.')
    } finally {
      if (isEnabled.current) setStatus('ready')
    }
  }

  const cancelResponse = async (): Promise<void> => {
    requestGeneration.current += 1
    clearWakeAcknowledgement()
    clearVoiceTranscript()
    const result = await window.orbit.cancelAssistant()
    setAssistantError(result.message)
    if (isEnabled.current) setStatus('ready')
  }

  const testConnection = async (): Promise<void> => {
    setIsTestingConnection(true)
    setConnectionResult(null)
    try {
      setConnectionResult(await window.orbit.checkOllama())
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

  const startMicrophoneTest = async (): Promise<void> => {
    stopSpeaking()
    clearVoiceTranscript()
    microphoneTest.clearResult()
    setAssistantError(null)
    if (isEnabled.current) await pauseWakeWord()
    const result = await microphoneTest.start()
    if (!result.ok) {
      setAssistantError(result.message)
      if (isEnabled.current) setStatus('ready')
      return
    }
    if (isEnabled.current) setStatus('listening')
  }

  const stopMicrophoneTest = async (): Promise<void> => {
    if (isEnabled.current) setStatus('transcribing')
    await microphoneTest.stop()
  }

  const cancelMicrophoneTest = async (): Promise<void> => {
    await microphoneTest.cancel()
    if (isEnabled.current) setStatus('ready')
  }

  const restoreAfterWakeWordTest = useCallback(async (): Promise<void> => {
    if (wakeWordTestWasEnabled.current) {
      setWakeWordState('armed')
      setStatus('ready')
      await resumeWakeWord()
    } else {
      await stopWakeWord()
      setWakeWordState('off')
      setStatus('disabled')
    }
  }, [resumeWakeWord, stopWakeWord])

  const startWakeWordTest = async (): Promise<void> => {
    if (wakeWordTestPhase !== 'idle' || microphoneTest.phase !== 'idle') return
    stopSpeaking()
    setAssistantError(null)
    setWakeWordTestResult(null)
    wakeWordTestWasEnabled.current = isEnabled.current

    const runtime = await resumeWakeWord()
    if (!runtime.ok) {
      setAssistantError(runtime.message)
      await restoreAfterWakeWordTest()
      return
    }

    setWakeWordTestPhase('listening')
    setStatus('listening')
    const result = await window.orbit.startWakeWordTest()
    if (!result.ok) {
      setWakeWordTestPhase('idle')
      setAssistantError(result.message)
      await restoreAfterWakeWordTest()
    }
  }

  const cancelWakeWordTest = async (): Promise<void> => {
    await window.orbit.cancelWakeWordTest()
    setWakeWordTestPhase('idle')
    setWakeWordTestResult(null)
    await restoreAfterWakeWordTest()
  }

  useEffect(() => {
    return window.orbit.onWakeWordEvent((event: WakeWordEvent) => {
      if (event.type === 'state') {
        setWakeWordState(event.state)
        if (event.state === 'detected') {
          clearVoiceTranscript()
          setWakeDetectionCount((count) => count + 1)
          setVoiceTranscriptIsTest(false)
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

      if (event.type === 'test-result') {
        setWakeWordTestPhase('idle')
        setWakeWordTestResult(event.result)
        void restoreAfterWakeWordTest()
        return
      }

      if (event.type === 'error') {
        if (wakeWordTestPhase === 'listening') {
          setWakeWordTestPhase('idle')
          setWakeWordTestResult(null)
          void restoreAfterWakeWordTest()
        }
        clearWakeAcknowledgement()
        clearVoiceTranscript()
        setWakeWordState(event.fatal ? 'error' : 'paused')
        setAssistantError(event.message)
        if (isEnabled.current) setStatus(event.fatal ? 'error' : 'ready')
        return
      }

      setVoiceTranscript(event.transcript)
      setVoiceDiagnostics(event.diagnostics)
      setVoiceTranscriptIsTest(false)
      setWakeWordState('paused')
      void wakeCommandHandler.current?.(event.transcript.normalizedText)
    })
  }, [
    acknowledgeWakeWord,
    clearVoiceTranscript,
    clearWakeAcknowledgement,
    restoreAfterWakeWordTest,
    stopSpeaking,
    wakeWordTestPhase
  ])

  useEffect(() => {
    if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current)
    transcriptClearTimer.current = null
    if (!voiceTranscript || voiceTranscriptIsTest || status !== 'ready' || speaking) return

    transcriptClearTimer.current = setTimeout(() => {
      transcriptClearTimer.current = null
      setVoiceTranscript(null)
    }, TRANSCRIPT_READY_HOLD_MS)

    return () => {
      if (transcriptClearTimer.current) clearTimeout(transcriptClearTimer.current)
      transcriptClearTimer.current = null
    }
  }, [speaking, status, voiceTranscript, voiceTranscriptIsTest])

  useEffect(() => {
    let active = true
    if (!isEnabled.current || wakeWordState === 'error') {
      return () => {
        active = false
      }
    }

    if (wakeWordTestPhase === 'listening') {
      return () => {
        active = false
      }
    }

    if (microphoneTest.phase !== 'idle') {
      void pauseWakeWord()
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
  }, [
    microphoneTest.phase,
    pauseWakeWord,
    resumeWakeWord,
    speaking,
    status,
    wakeWordState,
    wakeWordTestPhase
  ])

  const displayedStatus = status === 'ready' && speaking ? 'speaking' : status
  const statusLabel = displayedStatus
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
  const statusMessage: Record<OrbitStatus, string> = {
    disabled: 'Enable Orbit to begin local voice listening.',
    ready: 'Say “ORBIT” followed by your command.',
    listening: 'Listening for your command…',
    transcribing: 'Transcribing your command locally…',
    thinking: 'Preparing a response…',
    'awaiting-confirmation': 'Your confirmation is required.',
    executing: 'Executing the confirmed action…',
    speaking: 'Speaking the response…',
    error: 'Voice listening needs your attention.'
  }
  const primaryStatusLabel = wakeAcknowledged ? 'Orbit heard you' : statusLabel
  const primaryStatusMessage = wakeAcknowledged
    ? 'Listening for your command…'
    : statusMessage[displayedStatus]
  const commandWasCorrected =
    voiceTranscript !== null &&
    voiceTranscript.rawText.toLocaleLowerCase() !==
      voiceTranscript.normalizedText.toLocaleLowerCase()
  const activeMicrophoneName =
    microphoneTest.phase === 'idle' ? wakeMicrophoneName : microphoneTest.microphoneName
  const activeInputLevel =
    microphoneTest.phase === 'idle' ? wakeInputLevel : microphoneTest.inputLevel
  const microphoneActive =
    microphoneTest.phase !== 'idle' ||
    wakeWordTestPhase === 'listening' ||
    (status !== 'disabled' && wakeWordState !== 'off')
  const wakeDetected = wakeDetectionCount > 0 || wakeWordTestResult?.detected === true
  const wakeStageComplete = wakeDetected || microphoneTest.phase !== 'idle' || voiceTranscriptIsTest
  const commandCaptured = voiceDiagnostics !== null || wakeWordState === 'transcribing'
  const routeDescription = voiceDiagnostics
    ? voiceDiagnostics.route.kind === 'deterministic'
      ? `${voiceDiagnostics.route.capability} ${JSON.stringify(voiceDiagnostics.route.parameters)}`
      : voiceDiagnostics.route.summary
    : null
  return (
    <main className="app-shell">
      <section className="assistant-card" aria-labelledby="app-title">
        <header className="app-header">
          <div className="brand-mark" aria-hidden="true">
            O
          </div>
          <div>
            <h1 id="app-title">Orbit</h1>
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
              Voice: {wakeWordState === 'armed' ? 'armed (waiting for ORBIT)' : wakeWordState}
            </div>
          </div>
        </header>

        <button
          className={`enable-button ${status === 'disabled' ? '' : 'disable-button'}`}
          type="button"
          onClick={() => void (status === 'disabled' ? enableOrbit() : disableOrbit())}
        >
          {status === 'disabled' ? 'Enable Orbit' : 'Disable Orbit'}
        </button>

        <section
          className={`voice-status voice-status-${displayedStatus}${wakeAcknowledged ? ' wake-acknowledged' : ''}`}
          aria-live="polite"
        >
          <div className="voice-orb" aria-hidden="true">
            <span>O</span>
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

          <div className="microphone-monitor" aria-label="Microphone input monitor">
            <div className="microphone-monitor-heading">
              <span>{microphoneActive ? 'Microphone active' : 'Microphone inactive'}</span>
              <small>{activeMicrophoneName}</small>
            </div>
            <div
              className="input-meter"
              aria-label={`Input level ${Math.round(activeInputLevel * 100)} percent`}
            >
              <span style={{ width: `${Math.round(activeInputLevel * 100)}%` }} />
            </div>
            <small>{Math.round(activeInputLevel * 100)}% input level</small>
          </div>

          <ol className="voice-pipeline" aria-label="Voice processing pipeline">
            <li className={microphoneActive ? 'pipeline-complete' : ''}>Microphone active</li>
            <li className={wakeStageComplete ? 'pipeline-complete' : ''}>
              {microphoneTest.phase !== 'idle' || voiceTranscriptIsTest
                ? 'Wake word skipped for test'
                : 'ORBIT detected'}
            </li>
            <li className={commandCaptured ? 'pipeline-complete' : ''}>Command captured</li>
            <li className={voiceTranscript ? 'pipeline-complete' : ''}>Text transcribed</li>
            <li className={routeDescription ? 'pipeline-complete' : ''}>Route previewed</li>
          </ol>

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
              {voiceDiagnostics ? (
                <dl className="voice-metrics">
                  <div>
                    <dt>Audio</dt>
                    <dd>{(voiceDiagnostics.durationMs / 1000).toFixed(1)} s</dd>
                  </div>
                  <div>
                    <dt>Whisper</dt>
                    <dd>{(voiceDiagnostics.transcriptionLatencyMs / 1000).toFixed(2)} s</dd>
                  </div>
                  <div>
                    <dt>Peak</dt>
                    <dd>{Math.round(voiceDiagnostics.peakLevel * 100)}%</dd>
                  </div>
                  <div>
                    <dt>Language</dt>
                    <dd>{voiceDiagnostics.detectedLanguage ?? recognitionLanguage}</dd>
                  </div>
                  <div className="route-metric">
                    <dt>Route</dt>
                    <dd>{routeDescription}</dd>
                  </div>
                </dl>
              ) : null}
            </div>
          ) : null}

          {wakeWordTestResult ? (
            <p
              className={wakeWordTestResult.detected ? 'connection-success' : 'assistant-error'}
              role="status"
            >
              {wakeWordTestResult.detected
                ? `Orbit detected in ${wakeWordTestResult.latencyMs ?? 0} ms.`
                : 'Orbit was not detected within eight seconds. Speak clearly at a normal volume and try again.'}
            </p>
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
            {isTestingConnection ? 'Testing Ollama...' : 'Test Ollama'}
          </button>
          {microphoneTest.phase === 'idle' ? (
            <button
              type="button"
              onClick={() => void startMicrophoneTest()}
              disabled={wakeWordTestPhase === 'listening'}
            >
              Test Microphone
            </button>
          ) : microphoneTest.phase === 'recording' ? (
            <button type="button" onClick={() => void stopMicrophoneTest()}>
              Stop & Transcribe ({(microphoneTest.durationMs / 1000).toFixed(1)} s)
            </button>
          ) : (
            <button type="button" onClick={() => void cancelMicrophoneTest()}>
              Cancel Transcription
            </button>
          )}
          {wakeWordTestPhase === 'idle' ? (
            <button
              type="button"
              onClick={() => void startWakeWordTest()}
              disabled={microphoneTest.phase !== 'idle'}
            >
              Test Wake Word
            </button>
          ) : (
            <button type="button" onClick={() => void cancelWakeWordTest()}>
              Cancel Wake Test
            </button>
          )}
          <button
            type="button"
            disabled={wakeDetectionCount <= falseTriggerCount}
            onClick={() => setFalseTriggerCount((count) => count + 1)}
          >
            Mark False Trigger
          </button>
          <span className="trigger-counts">
            Wake detections: {wakeDetectionCount} · marked false: {falseTriggerCount}
          </span>
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
            Recognition
            <select
              value={recognitionLanguage}
              onChange={(event) => {
                const language = event.target.value === 'en' ? 'en' : 'auto'
                setRecognitionLanguage(language)
                saveSettings({ recognitionLanguage: language })
              }}
            >
              <option value="auto">English + Taglish (Auto)</option>
              <option value="en">English only</option>
            </select>
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
