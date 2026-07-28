import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActionResult,
  AssistantProgress,
  ConfirmationPrompt,
  OllamaHealth,
  OrbitStatus,
  SecurityPinStatus,
  VoiceDiagnostics,
  VoiceTranscript,
  WakeWordEvent,
  WakeWordState,
  WakeWordTestResult
} from '../../shared/types'
import { BrowserConnectionPanel } from './BrowserConnectionPanel'
import { ConfirmationDialog } from './ConfirmationDialog'
import { SecurityPinSettings } from './SecurityPinSettings'
import { useMicrophoneTest } from './hooks/useMicrophoneTest'
import { useSpeech } from './hooks/useSpeech'
import { useWakeWord } from './hooks/useWakeWord'
import { decideMicrophoneTransition } from './microphoneTransitionDecision'
import { TRANSCRIPT_READY_HOLD_MS, WAKE_ACKNOWLEDGEMENT_MS } from './voiceCueTiming'
import {
  deriveVoiceStartupStatus,
  type VoiceStartupReadiness
} from './voiceStartupState'

const SPOKEN_PIN_DIGITS: Readonly<Record<string, string>> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  to: '2',
  three: '3',
  four: '4',
  for: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  ate: '8',
  nine: '9'
}

function parseSpokenPin(value: string): string | null {
  const normalized = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const direct = normalized.match(/(?:^|\s)(\d{4})(?:\s|$)/)
  if (direct) return direct[1]

  const digits = normalized
    .split(/\s+/)
    .flatMap((token) => {
      if (/^\d$/.test(token)) return [token]
      const spoken = SPOKEN_PIN_DIGITS[token]
      return spoken ? [spoken] : []
    })
  return digits.length === 4 ? digits.join('') : null
}

type MicrophoneTransitionOwner =
  | 'none'
  | 'assistant-request'
  | 'microphone-test'
  | 'wake-word-test'

function App(): React.JSX.Element {
  const [status, setStatus] = useState<OrbitStatus>('disabled')
  const [assistantError, setAssistantError] = useState<string | null>(null)
  const [connectionResult, setConnectionResult] = useState<ActionResult<OllamaHealth> | null>(null)
  const [isTestingConnection, setIsTestingConnection] = useState(false)
  const [assistantProgress, setAssistantProgress] = useState<AssistantProgress | null>(null)
  const [wakeWordState, setWakeWordState] = useState<WakeWordState>('off')
  const [pendingConfirmation, setPendingConfirmation] = useState<ConfirmationPrompt | null>(null)
  const [pinStatus, setPinStatus] = useState<SecurityPinStatus | null>(null)
  const [voiceTranscript, setVoiceTranscript] = useState<VoiceTranscript | null>(null)
  const [wakeAcknowledged, setWakeAcknowledged] = useState(false)
  const [voiceDiagnostics, setVoiceDiagnostics] = useState<VoiceDiagnostics | null>(null)
  const [voiceTranscriptIsTest, setVoiceTranscriptIsTest] = useState(false)
  const [recognitionLanguage, setRecognitionLanguage] = useState<'auto' | 'en'>('auto')
  const [wakeRecognitionMode, setWakeRecognitionMode] = useState<'hybrid' | 'keyword-only'>(
    'hybrid'
  )
  const [wakeDetectionCount, setWakeDetectionCount] = useState(0)
  const [falseTriggerCount, setFalseTriggerCount] = useState(0)
  const [wakeWordTestPhase, setWakeWordTestPhase] = useState<'idle' | 'listening'>('idle')
  const [wakeWordTestResult, setWakeWordTestResult] = useState<WakeWordTestResult | null>(null)
  const [microphoneTransitionOwner, setMicrophoneTransitionOwner] =
    useState<MicrophoneTransitionOwner>('none')
  const isEnabled = useRef(false)
  const requestGeneration = useRef(0)
  const requestInFlight = useRef(false)
  const wakeCommandHandler = useRef<((message: string) => Promise<void>) | null>(null)
  const authorizationResponseHandler = useRef<
    ((approved: boolean, pin?: string) => Promise<void>) | null
  >(null)
  const pendingConfirmationRef = useRef<ConfirmationPrompt | null>(null)
  const wakeAcknowledgementTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const transcriptClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSpokenError = useRef<{ message: string; at: number } | null>(null)
  const wakeWordTestWasEnabled = useRef(false)
  const startupGeneration = useRef(0)
  const startupActive = useRef(false)
  const startupReadiness = useRef<VoiceStartupReadiness>({
    microphone: 'idle',
    ollama: 'idle'
  })
  const {
    microphoneName: wakeMicrophoneName,
    inputLevel: wakeInputLevel,
    pipelineState: microphonePipelineState,
    pipelineError: microphonePipelineError,
    prepare: prepareWakeWord,
    stop: stopWakeWord,
    pause: pauseWakeWord,
    resume: resumeWakeWord
  } = useWakeWord()

  const updateStartupReadiness = useCallback(
    (
      generation: number,
      patch: Partial<VoiceStartupReadiness>
    ): VoiceStartupReadiness | null => {
      if (
        generation !== startupGeneration.current ||
        !startupActive.current ||
        !isEnabled.current
      ) {
        return null
      }

      const next = { ...startupReadiness.current, ...patch }
      startupReadiness.current = next
      setStatus(deriveVoiceStartupStatus(next))
      return next
    },
    []
  )

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
      setStatus(
        !isEnabled.current
          ? 'disabled'
          : startupActive.current
            ? deriveVoiceStartupStatus(startupReadiness.current)
            : 'ready'
      )
    },
    []
  )
  const microphoneTest = useMicrophoneTest(handleMicrophoneTestResult)
  const {
    speak,
    stop: stopSpeaking,
    speaking,
    synthesizing,
    speechNotice,
    kokoroVoice,
    setKokoroVoice,
    rate,
    setRate,
    volume,
    setVolume
  } = useSpeech()

  useEffect(() => {
    if (!assistantError || !isEnabled.current) return
    const now = Date.now()
    const previous = lastSpokenError.current
    if (previous && previous.message === assistantError && now - previous.at < 4_000) return
    lastSpokenError.current = { message: assistantError, at: now }
    speak(assistantError)
  }, [assistantError, speak])

  useEffect(() => {
    if (!isEnabled.current || microphonePipelineState !== 'error') return
    startupActive.current = false
    startupGeneration.current += 1
    setWakeWordState('error')
    setAssistantError(
      microphonePipelineError ?? 'The microphone pipeline stopped responding. Disable and enable Orbit to retry.'
    )
    setStatus('error')
  }, [microphonePipelineError, microphonePipelineState])

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
    pendingConfirmationRef.current = pendingConfirmation
  }, [pendingConfirmation])

  useEffect(() => {
    let active = true
    void window.orbit
      .getSettings()
      .then((result) => {
        if (!active || !result.ok || !result.data) return
        setRate(result.data.speechRate)
        setVolume(result.data.speechVolume)
        setKokoroVoice(result.data.kokoroVoice)
        setRecognitionLanguage(result.data.recognitionLanguage)
        setWakeRecognitionMode(result.data.wakeRecognitionMode)
      })
      .catch(() => undefined)
    void window.orbit
      .getPinStatus()
      .then((result) => {
        if (active && result.ok && result.data) setPinStatus(result.data)
      })
      .catch(() => undefined)

    return () => {
      active = false
    }
  }, [setKokoroVoice, setRate, setVolume])

  useEffect(() => {
    return window.orbit.onAssistantProgress((progress) => {
      setAssistantProgress(progress)
      if (!isEnabled.current) return
      if (startupActive.current) {
        setStatus(deriveVoiceStartupStatus(startupReadiness.current))
        return
      }
      setStatus(
        progress.phase === 'checking' || progress.phase === 'loading' ? 'preparing-ai' : 'thinking'
      )
    })
  }, [])
  const saveSettings = (patch: Parameters<typeof window.orbit.updateSettings>[0]): void => {
    void window.orbit.updateSettings(patch).catch(() => undefined)
  }

  const enableOrbit = async (): Promise<void> => {
    const generation = startupGeneration.current + 1
    startupGeneration.current = generation
    startupActive.current = true
    startupReadiness.current = { microphone: 'pending', ollama: 'pending' }
    isEnabled.current = true
    setMicrophoneTransitionOwner('none')
    setAssistantError(null)
    setAssistantProgress(null)
    setConnectionResult(null)
    setWakeWordState('starting')
    setStatus(deriveVoiceStartupStatus(startupReadiness.current))

    const microphonePreparation = prepareWakeWord().then((result) => {
      updateStartupReadiness(generation, {
        microphone: result.ok ? 'prepared' : 'error'
      })
      return result
    })
    const ollamaPreparation: Promise<ActionResult<OllamaHealth>> = window.orbit
      .checkOllama()
      .catch(() => ({
        ok: false,
        code: 'IPC_CONNECTION_FAILED',
        message: 'Orbit could not warm the local AI service.',
        recoverable: true
      }))
      .then((result) => {
        if (generation === startupGeneration.current && isEnabled.current) {
          setConnectionResult(result)
        }
        updateStartupReadiness(generation, { ollama: result.ok ? 'ready' : 'error' })
        return result
      })

    const [microphoneResult, ollamaResult] = await Promise.all([
      microphonePreparation,
      ollamaPreparation
    ])
    if (
      generation !== startupGeneration.current ||
      !startupActive.current ||
      !isEnabled.current
    ) {
      return
    }

    if (!microphoneResult.ok || !ollamaResult.ok) {
      startupActive.current = false
      setWakeWordState(microphoneResult.ok ? 'paused' : 'error')
      setAssistantError(!microphoneResult.ok ? microphoneResult.message : ollamaResult.message)
      setStatus('error')
      if (decideMicrophoneTransition(false, microphonePipelineState) === 'pause') {
        await pauseWakeWord()
      }
      return
    }

    updateStartupReadiness(generation, { microphone: 'pending' })
    const resumeResult = await resumeWakeWord()
    if (
      generation !== startupGeneration.current ||
      !startupActive.current ||
      !isEnabled.current
    ) {
      return
    }
    if (!resumeResult.ok) {
      updateStartupReadiness(generation, { microphone: 'error' })
      startupActive.current = false
      setWakeWordState('error')
      setAssistantError(resumeResult.message)
      setStatus('error')
      return
    }

    updateStartupReadiness(generation, { microphone: 'ready' })
    startupActive.current = false
    setAssistantProgress(null)
    setStatus('ready')
  }

  const disableOrbit = async (): Promise<void> => {
    isEnabled.current = false
    startupActive.current = false
    startupGeneration.current += 1
    startupReadiness.current = { microphone: 'idle', ollama: 'idle' }
    requestGeneration.current += 1
    setMicrophoneTransitionOwner('none')
    stopSpeaking()
    setAssistantError(null)
    setAssistantProgress(null)
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
      startupActive.current ||
      status === 'thinking' ||
      requestInFlight.current
    ) {
      return
    }

    requestInFlight.current = true
    setMicrophoneTransitionOwner('assistant-request')
    try {
      if (decideMicrophoneTransition(false, microphonePipelineState) === 'pause') {
        const pauseResult = await pauseWakeWord()
        if (!pauseResult.ok) {
          setAssistantError('Orbit could not pause voice listening.')
          setMicrophoneTransitionOwner('none')
          return
        }
      }
      if (!isEnabled.current) return

      const generation = requestGeneration.current + 1
      requestGeneration.current = generation
      setAssistantError(null)
      setAssistantProgress(null)
      setStatus('thinking')
      setMicrophoneTransitionOwner('none')

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
          setAssistantProgress(null)
          setStatus('ready')
        }
      }
    } finally {
      setMicrophoneTransitionOwner('none')
      requestInFlight.current = false
    }
  }

  useEffect(() => {
    wakeCommandHandler.current = submitMessage
  })

  const respondToConfirmation = async (approved: boolean, pin?: string): Promise<void> => {
    const confirmation = pendingConfirmationRef.current
    if (!confirmation) return
    setStatus('executing')
    setAssistantError(null)
    let keepPending = false
    try {
      const result = await window.orbit.confirmAction(confirmation.requestId, approved, pin)
      keepPending =
        !result.ok &&
        confirmation.authorization === 'pin' &&
        ['PIN_INVALID', 'PIN_LOCKED', 'PIN_NOT_CONFIGURED'].includes(result.code)

      if (!keepPending) setPendingConfirmation(null)
      if (result.ok) {
        const response = result.data?.response
        if (response) speak(response)
      } else {
        setAssistantError(result.message)
        const latestPinStatus = await window.orbit.getPinStatus().catch(() => null)
        if (latestPinStatus?.ok && latestPinStatus.data) setPinStatus(latestPinStatus.data)
      }
    } catch {
      setPendingConfirmation(null)
      setAssistantError('Orbit could not complete the authorization request.')
    } finally {
      if (isEnabled.current) setStatus(keepPending ? 'awaiting-confirmation' : 'ready')
    }
  }

  useEffect(() => {
    authorizationResponseHandler.current = respondToConfirmation
  })

  const cancelResponse = async (): Promise<void> => {
    requestGeneration.current += 1
    clearWakeAcknowledgement()
    clearVoiceTranscript()
    const result = await window.orbit.cancelAssistant()
    setAssistantError(result.message)
    if (isEnabled.current) setStatus('ready')
  }

  const testConnection = async (): Promise<void> => {
    if (startupActive.current) return
    setIsTestingConnection(true)
    setConnectionResult(null)
    setAssistantProgress(null)
    if (isEnabled.current) setStatus('preparing-ai')
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
      setAssistantProgress(null)
      if (isEnabled.current && !requestInFlight.current) setStatus('ready')
    }
  }

  const startMicrophoneTest = async (): Promise<void> => {
    if (startupActive.current) return
    setMicrophoneTransitionOwner('microphone-test')
    try {
      stopSpeaking()
      clearVoiceTranscript()
      microphoneTest.clearResult()
      setAssistantError(null)
      if (
        isEnabled.current &&
        decideMicrophoneTransition(false, microphonePipelineState) === 'pause'
      ) {
        const pauseResult = await pauseWakeWord()
        if (!pauseResult.ok) {
          setAssistantError('Orbit could not pause voice listening for the microphone test.')
          setStatus('ready')
          return
        }
      }

      const result = await microphoneTest.start()
      if (!result.ok) {
        setAssistantError(result.message)
        if (isEnabled.current) setStatus('ready')
        return
      }
      if (isEnabled.current) setStatus('listening')
    } finally {
      setMicrophoneTransitionOwner('none')
    }
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
      return
    }

    await stopWakeWord()
    setWakeWordState('off')
    setStatus('disabled')
  }, [stopWakeWord])

  const startWakeWordTest = async (): Promise<void> => {
    if (
      startupActive.current ||
      wakeWordTestPhase !== 'idle' ||
      microphoneTest.phase !== 'idle'
    ) {
      return
    }
    setMicrophoneTransitionOwner('wake-word-test')
    setWakeWordTestPhase('listening')
    setStatus('listening')
    try {
      stopSpeaking()
      setAssistantError(null)
      setWakeWordTestResult(null)
      wakeWordTestWasEnabled.current = isEnabled.current

      if (microphonePipelineState === 'error') {
        setWakeWordTestPhase('idle')
        setAssistantError(
          microphonePipelineError ?? 'Voice listening cannot start while the microphone is in an error state.'
        )
        await restoreAfterWakeWordTest()
        return
      }

      if (decideMicrophoneTransition(true, microphonePipelineState) === 'resume') {
        const runtime = await resumeWakeWord()
        if (!runtime.ok) {
          setWakeWordTestPhase('idle')
          setAssistantError(runtime.message)
          await restoreAfterWakeWordTest()
          return
        }
      }

      const result = await window.orbit.startWakeWordTest()
      if (!result.ok) {
        setWakeWordTestPhase('idle')
        setAssistantError(result.message)
        await restoreAfterWakeWordTest()
      }
    } finally {
      setMicrophoneTransitionOwner('none')
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
        if (startupActive.current) return
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
        if (startupActive.current) {
          startupActive.current = false
          startupGeneration.current += 1
          startupReadiness.current = { ...startupReadiness.current, microphone: 'error' }
        }
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

      if (startupActive.current) return

      const pendingAuthorization = pendingConfirmationRef.current
      if (pendingAuthorization?.authorization === 'pin') {
        clearWakeAcknowledgement()
        clearVoiceTranscript()
        setWakeWordState('paused')
        const spokenPin = parseSpokenPin(event.transcript.normalizedText)
        if (!spokenPin) {
          setAssistantError('Say exactly four digits, or enter the PIN in the protected-action box.')
          setStatus('awaiting-confirmation')
          return
        }
        void authorizationResponseHandler.current?.(true, spokenPin)
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
    if (
      !isEnabled.current ||
      wakeWordState === 'error' ||
      startupActive.current ||
      microphoneTransitionOwner !== 'none' ||
      wakeWordTestPhase === 'listening'
    ) {
      return () => {
        active = false
      }
    }

    const wakeWordOwnsAudio =
      status === 'listening' ||
      status === 'transcribing' ||
      wakeWordState === 'detected' ||
      wakeWordState === 'capturing' ||
      wakeWordState === 'transcribing'
    if (wakeWordOwnsAudio) {
      return () => {
        active = false
      }
    }

    const awaitingSpokenPin =
      status === 'awaiting-confirmation' &&
      pendingConfirmation?.authorization === 'pin' &&
      pinStatus?.hasPin === true
    const audioShouldRun =
      microphoneTest.phase === 'idle' &&
      (status === 'ready' || awaitingSpokenPin) &&
      !speaking &&
      !synthesizing
    const transition = decideMicrophoneTransition(audioShouldRun, microphonePipelineState)

    if (transition === 'resume') {
      void resumeWakeWord().then((result) => {
        if (active && !result.ok && isEnabled.current) {
          setWakeWordState('error')
          setAssistantError(result.message)
          setStatus('error')
        }
      })
    } else if (transition === 'pause') {
      void pauseWakeWord()
    }

    return () => {
      active = false
    }
  }, [
    microphonePipelineState,
    microphoneTest.phase,
    microphoneTransitionOwner,
    pauseWakeWord,
    resumeWakeWord,
    pendingConfirmation,
    pinStatus?.hasPin,
    speaking,
    status,
    synthesizing,
    wakeWordState,
    wakeWordTestPhase
  ])

  const displayedStatus =
    status === 'ready' && synthesizing
      ? 'synthesizing'
      : status === 'ready' && speaking
        ? 'speaking'
        : status === 'ready' && microphonePipelineState !== 'active'
          ? 'preparing-voice'
          : status
  const statusLabel = displayedStatus
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
  const statusMessage: Record<OrbitStatus, string> = {
    disabled: 'Enable Orbit to begin local voice listening.',
    ready: 'Say “ORBIT” followed by your command.',
    listening: 'Listening for your command…',
    'preparing-voice': 'Preparing the microphone and waiting for live audio samples…',
    'preparing-ai': 'Loading the local AI model...',
    transcribing: 'Transcribing your command locally…',
    thinking: 'Preparing a response…',
    synthesizing: 'Generating the Kokoro voice locally...',
    'awaiting-confirmation':
      pendingConfirmation?.authorization === 'pin'
        ? pinStatus?.hasPin
          ? 'Enter the hidden PIN below, or say “ORBIT” followed by the four digits.'
          : 'Create a four-digit security PIN below to continue.'
        : 'Your confirmation is required.',
    executing: 'Executing the authorized action…',
    speaking: 'Speaking the response…',
    error: 'Voice listening needs your attention.'
  }
  const primaryStatusLabel = wakeAcknowledged ? 'Orbit heard you' : statusLabel
  const primaryStatusMessage = wakeAcknowledged
    ? 'Listening for your command…'
    : (displayedStatus === 'preparing-ai' || displayedStatus === 'thinking') && assistantProgress
      ? assistantProgress.message
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
    microphonePipelineState === 'active'
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
              className={`wake-word-pill microphone-pipeline-${microphonePipelineState}`}
              role="status"
              aria-live="polite"
            >
              <span aria-hidden="true" />
              Voice:{' '}
              {microphonePipelineState === 'active' && wakeWordState === 'armed'
                ? 'active (waiting for ORBIT)'
                : microphonePipelineState}
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
                    <dt>Recognition</dt>
                    <dd>
                      {(voiceDiagnostics.transcriptionLatencyMs / 1000).toFixed(2)} s /{' '}
                      {voiceDiagnostics.transcriptionBackend === 'vulkan-small'
                        ? 'Vulkan Small (fast)'
                        : voiceDiagnostics.transcriptionBackend === 'vulkan-turbo'
                          ? 'Vulkan Turbo'
                          : voiceDiagnostics.transcriptionBackend === 'cpu-turbo'
                            ? 'CPU Turbo'
                            : 'CPU Small'}
                    </dd>
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
            <div
              className={wakeWordTestResult.detected ? 'connection-success' : 'assistant-error'}
              role="status"
            >
              <p>
                {wakeWordTestResult.detected
                  ? `Orbit detected in ${wakeWordTestResult.latencyMs ?? 0} ms.`
                  : 'Orbit was not detected during the eight-second listening window.'}
              </p>
              <dl className="voice-metrics">
                <div>
                  <dt>Method</dt>
                  <dd>
                    {wakeWordTestResult.method === 'whisper-fallback'
                      ? 'Whisper fallback'
                      : wakeWordTestResult.method === 'keyword'
                        ? 'Keyword detector'
                        : 'No match'}
                  </dd>
                </div>
                <div>
                  <dt>Heard</dt>
                  <dd>{wakeWordTestResult.heardText ?? 'No recognizable wake phrase'}</dd>
                </div>
                <div>
                  <dt>Signal</dt>
                  <dd>{wakeWordTestResult.signalQuality}</dd>
                </div>
                <div>
                  <dt>Audio</dt>
                  <dd>{(wakeWordTestResult.captureDurationMs / 1000).toFixed(1)} s</dd>
                </div>
                <div>
                  <dt>Peak</dt>
                  <dd>{Math.round(wakeWordTestResult.peakLevel * 100)}%</dd>
                </div>
              </dl>
            </div>
          ) : null}

          {speechNotice ? (
            <p className="connection-result" role="status">
              {speechNotice}
            </p>
          ) : null}

          {assistantError ? (
            <p className="assistant-error" role="alert">
              {assistantError}
            </p>
          ) : null}

          {pendingConfirmation ? (
            <ConfirmationDialog
              key={pendingConfirmation.requestId}
              confirmation={pendingConfirmation}
              disabled={status === 'executing'}
              pinConfigured={pinStatus?.hasPin ?? pendingConfirmation.pinConfigured}
              onRespond={(approved, pin) => void respondToConfirmation(approved, pin)}
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
          {status === 'thinking' || status === 'preparing-ai' ? (
            <button type="button" onClick={cancelResponse}>
              Cancel Response
            </button>
          ) : null}
          <button type="button" onClick={stopSpeaking} disabled={!speaking && !synthesizing}>
            Stop Speaking
          </button>
        </footer>

        <fieldset className="speech-settings">
          <legend>Kokoro speech output</legend>
          <label>
            Voice
            <select
              value={kokoroVoice}
              onChange={(event) => {
                const voice = event.target.value as typeof kokoroVoice
                setKokoroVoice(voice)
                saveSettings({ kokoroVoice: voice, speechEngine: 'kokoro' })
              }}
            >
              <option value="bm_george">George (British male)</option>
              <option value="bm_lewis">Lewis (British male)</option>
              <option value="bm_daniel">Daniel (British male)</option>
              <option value="am_adam">Adam (American male)</option>
              <option value="am_michael">Michael (American male)</option>
              <option value="bf_emma">Emma (British female)</option>
              <option value="af_heart">Heart (American female)</option>
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
            Wake recognition
            <select
              value={wakeRecognitionMode}
              disabled={status !== 'disabled'}
              onChange={(event) => {
                const mode = event.target.value === 'keyword-only' ? 'keyword-only' : 'hybrid'
                setWakeRecognitionMode(mode)
                saveSettings({ wakeRecognitionMode: mode })
              }}
            >
              <option value="hybrid">Hybrid local (recommended)</option>
              <option value="keyword-only">Keyword only (lower CPU)</option>
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

        <BrowserConnectionPanel />

        <SecurityPinSettings
          status={pinStatus}
          onStatusChange={(nextStatus) => {
            setPinStatus(nextStatus)
            setPendingConfirmation((current) =>
              current ? { ...current, pinConfigured: nextStatus.hasPin } : current
            )
          }}
        />

        {connectionResult ? (
          <div
            className={`connection-result ${connectionResult.ok ? 'connection-success' : 'connection-error'}`}
            role="status"
          >
            <p>{connectionResult.message}</p>
            {connectionResult.ok && connectionResult.data ? (
              <dl className="voice-metrics">
                <div>
                  <dt>Model</dt>
                  <dd>
                    {connectionResult.data.activeModel ?? connectionResult.data.configuredModel}
                  </dd>
                </div>
                <div>
                  <dt>Processor</dt>
                  <dd>{connectionResult.data.processor ?? 'unknown'}</dd>
                </div>
                <div>
                  <dt>Warm</dt>
                  <dd>{connectionResult.data.warm ? 'yes' : 'no'}</dd>
                </div>
                <div>
                  <dt>Fallback</dt>
                  <dd>{connectionResult.data.fallbackActive ? 'active' : 'no'}</dd>
                </div>
                {connectionResult.data.timing ? (
                  <div>
                    <dt>Last load</dt>
                    <dd>{(connectionResult.data.timing.totalMs / 1000).toFixed(2)} s</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  )
}

export default App
