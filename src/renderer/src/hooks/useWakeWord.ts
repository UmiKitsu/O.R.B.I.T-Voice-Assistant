import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ActionResult,
  MicrophonePipelineState
} from '../../../shared/types'
import { decideMicrophoneTransition } from '../microphoneTransitionDecision'
import {
  calculateInputLevel,
  isValidAudioChunk,
  MicrophonePipelineTimeoutError,
  withDeadline
} from './microphonePipeline'

const WAKE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

const MEDIA_ACCESS_TIMEOUT_MS = 12_000
const WORKLET_SETUP_TIMEOUT_MS = 8_000
const AUDIO_STATE_TIMEOUT_MS = 5_000
const FIRST_CHUNK_TIMEOUT_MS = 4_000
const IPC_TIMEOUT_MS = 10_000
const AUDIO_STALL_TIMEOUT_MS = 3_500
const WATCHDOG_INTERVAL_MS = 1_000

export type WakeWordController = {
  microphoneName: string
  inputLevel: number
  pipelineState: MicrophonePipelineState
  pipelineError: string | null
  prepare: () => Promise<ActionResult>
  stop: () => Promise<ActionResult>
  pause: () => Promise<ActionResult>
  resume: () => Promise<ActionResult>
}

type ChunkWaiter = {
  pipelineId: number
  afterSequence: number
  resolve: (received: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

class PipelineCancelledError extends Error {
  constructor() {
    super('The microphone operation was superseded.')
    this.name = 'PipelineCancelledError'
  }
}

class PipelineActionError extends Error {
  readonly result: ActionResult

  constructor(result: ActionResult) {
    super(result.message)
    this.name = 'PipelineActionError'
    this.result = result
  }
}

function microphoneFailure(error: unknown): ActionResult {
  if (error instanceof PipelineActionError) return error.result
  if (error instanceof MicrophonePipelineTimeoutError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      recoverable: true
    }
  }

  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      ok: false,
      code: 'MICROPHONE_PERMISSION_DENIED',
      message: 'Microphone permission was denied.',
      recoverable: true
    }
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      ok: false,
      code: 'NO_MICROPHONE',
      message: 'No microphone was detected.',
      recoverable: true
    }
  }
  return {
    ok: false,
    code: 'WAKE_WORD_MICROPHONE_FAILED',
    message: error instanceof Error ? error.message : 'Voice listening could not access the microphone.',
    recoverable: true
  }
}

function success(message: string): ActionResult {
  return { ok: true, message }
}

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop())
}

export function useWakeWord(): WakeWordController {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const silentOutputRef = useRef<GainNode | null>(null)
  const desiredListeningRef = useRef(false)
  const deliveryEnabledRef = useRef(false)
  const transitionGenerationRef = useRef(0)
  const pipelineIdRef = useRef(0)
  const chunkSequenceRef = useRef(0)
  const lastChunkAtRef = useRef(0)
  const chunkWaitersRef = useRef(new Set<ChunkWaiter>())
  const recoveryInFlightRef = useRef(false)
  const incidentHandlerRef = useRef<((reason: string) => void) | null>(null)
  const mountedRef = useRef(true)
  const pipelineStateRef = useRef<MicrophonePipelineState>('off')
  const [microphoneName, setMicrophoneName] = useState('Default microphone')
  const [inputLevel, setInputLevel] = useState(0)
  const [pipelineState, setPipelineStateValue] = useState<MicrophonePipelineState>('off')
  const [pipelineError, setPipelineError] = useState<string | null>(null)

  const setPipelineState = useCallback((next: MicrophonePipelineState): void => {
    pipelineStateRef.current = next
    if (mountedRef.current) setPipelineStateValue(next)
  }, [])

  const ensureCurrentTransition = useCallback((generation: number): void => {
    if (generation !== transitionGenerationRef.current) throw new PipelineCancelledError()
  }, [])

  const cancelChunkWaiters = useCallback((): void => {
    for (const waiter of chunkWaitersRef.current) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    chunkWaitersRef.current.clear()
  }, [])

  const waitForFreshChunk = useCallback(
    (pipelineId: number, afterSequence: number): Promise<boolean> => {
      if (pipelineId === pipelineIdRef.current && chunkSequenceRef.current > afterSequence) {
        return Promise.resolve(true)
      }

      return new Promise((resolve) => {
        const waiter: ChunkWaiter = {
          pipelineId,
          afterSequence,
          resolve,
          timer: setTimeout(() => {
            chunkWaitersRef.current.delete(waiter)
            resolve(false)
          }, FIRST_CHUNK_TIMEOUT_MS)
        }
        chunkWaitersRef.current.add(waiter)
      })
    },
    []
  )

  const releaseAudio = useCallback(async (): Promise<void> => {
    pipelineIdRef.current += 1
    cancelChunkWaiters()
    deliveryEnabledRef.current = false
    lastChunkAtRef.current = 0
    if (mountedRef.current) setInputLevel(0)

    const stream = streamRef.current
    const context = contextRef.current
    const source = sourceRef.current
    const worklet = workletRef.current
    const silentOutput = silentOutputRef.current

    streamRef.current = null
    contextRef.current = null
    sourceRef.current = null
    workletRef.current = null
    silentOutputRef.current = null

    for (const track of stream?.getAudioTracks() ?? []) {
      track.onended = null
      track.onmute = null
    }
    try {
      source?.disconnect()
    } catch {
      // The node may already be disconnected during a browser audio failure.
    }
    try {
      worklet?.disconnect()
    } catch {
      // The node may already be disconnected during a browser audio failure.
    }
    try {
      silentOutput?.disconnect()
    } catch {
      // The node may already be disconnected during a browser audio failure.
    }
    stopTracks(stream)

    if (context && context.state !== 'closed') {
      await withDeadline(
        context.close(),
        AUDIO_STATE_TIMEOUT_MS,
        'MICROPHONE_CLOSE_TIMEOUT',
        'The microphone audio context did not close in time.'
      ).catch(() => undefined)
    }
  }, [cancelChunkWaiters])

  const runWakeWordAction = useCallback(
    async (operation: Promise<ActionResult>, timeoutMessage: string): Promise<ActionResult> => {
      return withDeadline(operation, IPC_TIMEOUT_MS, 'WAKE_WORD_RUNTIME_TIMEOUT', timeoutMessage)
    },
    []
  )

  const resumeContextAndWaitForChunk = useCallback(
    async (generation: number): Promise<void> => {
      ensureCurrentTransition(generation)
      const context = contextRef.current
      const pipelineId = pipelineIdRef.current
      if (!context || context.state === 'closed') {
        throw new Error('The microphone audio context is unavailable.')
      }

      const afterSequence = chunkSequenceRef.current
      if (context.state !== 'running') {
        await withDeadline(
          context.resume(),
          AUDIO_STATE_TIMEOUT_MS,
          'MICROPHONE_RESUME_TIMEOUT',
          'The microphone audio context did not resume in time.'
        )
      }
      ensureCurrentTransition(generation)
      if (context.state !== 'running') {
        throw new Error('The microphone audio context did not enter the running state.')
      }

      const received = await waitForFreshChunk(pipelineId, afterSequence)
      ensureCurrentTransition(generation)
      if (!received) {
        throw new MicrophonePipelineTimeoutError(
          'MICROPHONE_AUDIO_STALLED',
          'The microphone opened, but no audio samples arrived.'
        )
      }
    },
    [ensureCurrentTransition, waitForFreshChunk]
  )

  const buildAudioPipeline = useCallback(
    async (generation: number): Promise<void> => {
      ensureCurrentTransition(generation)
      setPipelineState('starting')
      if (mountedRef.current) setPipelineError(null)

      const runtime = await runWakeWordAction(
        window.orbit.startWakeWord(),
        'The wake-word runtime did not start in time.'
      )
      if (!runtime.ok) throw new PipelineActionError(runtime)
      ensureCurrentTransition(generation)

      const paused = await runWakeWordAction(
        window.orbit.pauseWakeWord(),
        'The wake-word runtime did not pause during microphone preparation.'
      )
      if (!paused.ok) throw new PipelineActionError(paused)
      ensureCurrentTransition(generation)

      let permissionRequestExpired = false
      const mediaRequest = navigator.mediaDevices.getUserMedia({ audio: WAKE_AUDIO_CONSTRAINTS })
      void mediaRequest
        .then((lateStream) => {
          if (permissionRequestExpired || generation !== transitionGenerationRef.current) {
            stopTracks(lateStream)
          }
        })
        .catch(() => undefined)

      let stream: MediaStream | null = null
      let context: AudioContext | null = null
      let source: MediaStreamAudioSourceNode | null = null
      let worklet: AudioWorkletNode | null = null
      let silentOutput: GainNode | null = null
      let assignedPipelineId: number | null = null

      try {
        stream = await withDeadline(
          mediaRequest,
          MEDIA_ACCESS_TIMEOUT_MS,
          'MICROPHONE_ACCESS_TIMEOUT',
          'Microphone permission or device access took too long.'
        )
        ensureCurrentTransition(generation)
        if (mountedRef.current) {
          setMicrophoneName(stream.getAudioTracks()[0]?.label || 'Default microphone')
        }

        context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
        if (context.sampleRate !== 16_000) {
          throw new Error('The microphone could not provide the required 16 kHz audio format.')
        }

        await withDeadline(
          context.audioWorklet.addModule(
            new URL('wake-word-processor.js', document.baseURI).toString()
          ),
          WORKLET_SETUP_TIMEOUT_MS,
          'MICROPHONE_WORKLET_TIMEOUT',
          'The microphone audio processor did not load in time.'
        )
        ensureCurrentTransition(generation)

        source = context.createMediaStreamSource(stream)
        worklet = new AudioWorkletNode(context, 'orbit-wake-word-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        })
        silentOutput = context.createGain()
        silentOutput.gain.value = 0

        const pipelineId = pipelineIdRef.current + 1
        pipelineIdRef.current = pipelineId
        assignedPipelineId = pipelineId
        chunkSequenceRef.current = 0
        lastChunkAtRef.current = performance.now()

        worklet.port.onmessage = (event: MessageEvent<unknown>) => {
          if (pipelineId !== pipelineIdRef.current || !isValidAudioChunk(event.data)) return
          chunkSequenceRef.current += 1
          lastChunkAtRef.current = performance.now()
          if (mountedRef.current) setInputLevel(calculateInputLevel(event.data))

          for (const waiter of [...chunkWaitersRef.current]) {
            if (
              waiter.pipelineId === pipelineId &&
              chunkSequenceRef.current > waiter.afterSequence
            ) {
              clearTimeout(waiter.timer)
              chunkWaitersRef.current.delete(waiter)
              waiter.resolve(true)
            }
          }

          if (
            desiredListeningRef.current &&
            deliveryEnabledRef.current &&
            pipelineStateRef.current === 'active'
          ) {
            window.orbit.sendWakeWordAudio(event.data)
          }
        }

        for (const track of stream.getAudioTracks()) {
          track.onended = () => incidentHandlerRef.current?.('The microphone was disconnected.')
          track.onmute = () => incidentHandlerRef.current?.('The microphone stopped providing audio.')
        }

        source.connect(worklet)
        worklet.connect(silentOutput)
        silentOutput.connect(context.destination)

        streamRef.current = stream
        contextRef.current = context
        sourceRef.current = source
        workletRef.current = worklet
        silentOutputRef.current = silentOutput
        stream = null
        context = null
        source = null
        worklet = null
        silentOutput = null

        await resumeContextAndWaitForChunk(generation)
      } catch (error) {
        permissionRequestExpired = true
        try {
          source?.disconnect()
        } catch {
          // Ignore cleanup errors for a partially-created pipeline.
        }
        try {
          worklet?.disconnect()
        } catch {
          // Ignore cleanup errors for a partially-created pipeline.
        }
        try {
          silentOutput?.disconnect()
        } catch {
          // Ignore cleanup errors for a partially-created pipeline.
        }
        stopTracks(stream)
        if (context && context.state !== 'closed') {
          await withDeadline(
            context.close(),
            AUDIO_STATE_TIMEOUT_MS,
            'MICROPHONE_CLOSE_TIMEOUT',
            'The microphone audio context did not close in time.'
          ).catch(() => undefined)
        }
        if (assignedPipelineId !== null && assignedPipelineId === pipelineIdRef.current) {
          await releaseAudio()
        }
        throw error
      }
    }, [
      ensureCurrentTransition,
      releaseAudio,
      resumeContextAndWaitForChunk,
      runWakeWordAction,
      setPipelineState
    ]
  )

  const hasUsablePipeline = useCallback((): boolean => {
    const context = contextRef.current
    const stream = streamRef.current
    return (
      context !== null &&
      context.state !== 'closed' &&
      workletRef.current !== null &&
      stream?.getAudioTracks().some(
        (track) => track.readyState === 'live' && !track.muted
      ) === true
    )
  }, [])

  const prepareAttempt = useCallback(
    async (generation: number): Promise<void> => {
      deliveryEnabledRef.current = false
      if (!hasUsablePipeline()) {
        await releaseAudio()
        ensureCurrentTransition(generation)
        await buildAudioPipeline(generation)
      } else {
        const paused = await runWakeWordAction(
          window.orbit.pauseWakeWord(),
          'The wake-word runtime did not pause in time.'
        )
        if (!paused.ok) throw new PipelineActionError(paused)
        await resumeContextAndWaitForChunk(generation)
      }

      ensureCurrentTransition(generation)
      const context = contextRef.current
      if (context?.state === 'running') {
        await withDeadline(
          context.suspend(),
          AUDIO_STATE_TIMEOUT_MS,
          'MICROPHONE_PAUSE_TIMEOUT',
          'The microphone audio context did not pause in time.'
        )
      }
      ensureCurrentTransition(generation)
      setPipelineState('paused')
      if (mountedRef.current) setInputLevel(0)
    }, [
      buildAudioPipeline,
      ensureCurrentTransition,
      hasUsablePipeline,
      releaseAudio,
      resumeContextAndWaitForChunk,
      runWakeWordAction,
      setPipelineState
    ]
  )

  const activateAttempt = useCallback(
    async (generation: number, forceRebuild: boolean): Promise<void> => {
      deliveryEnabledRef.current = false
      const paused = await runWakeWordAction(
        window.orbit.pauseWakeWord(),
        'The wake-word runtime did not pause before microphone activation.'
      )
      if (!paused.ok) throw new PipelineActionError(paused)
      ensureCurrentTransition(generation)

      if (forceRebuild || !hasUsablePipeline()) {
        await releaseAudio()
        ensureCurrentTransition(generation)
        await buildAudioPipeline(generation)
      } else {
        await resumeContextAndWaitForChunk(generation)
      }

      ensureCurrentTransition(generation)
      if (!desiredListeningRef.current) throw new PipelineCancelledError()
      const resumed = await runWakeWordAction(
        window.orbit.resumeWakeWord(),
        'The wake-word runtime did not resume in time.'
      )
      if (!resumed.ok) throw new PipelineActionError(resumed)
      ensureCurrentTransition(generation)
      if (!desiredListeningRef.current) throw new PipelineCancelledError()

      deliveryEnabledRef.current = true
      lastChunkAtRef.current = performance.now()
      setPipelineState('active')
      if (mountedRef.current) setPipelineError(null)
    }, [
      buildAudioPipeline,
      ensureCurrentTransition,
      hasUsablePipeline,
      releaseAudio,
      resumeContextAndWaitForChunk,
      runWakeWordAction,
      setPipelineState
    ]
  )

  const failPipeline = useCallback(
    async (generation: number, error: unknown): Promise<ActionResult> => {
      if (error instanceof PipelineCancelledError || generation !== transitionGenerationRef.current) {
        return success('The microphone transition was superseded.')
      }

      const result = microphoneFailure(error)
      desiredListeningRef.current = false
      deliveryEnabledRef.current = false
      if (mountedRef.current) setPipelineError(result.message)
      setPipelineState('error')
      await runWakeWordAction(
        window.orbit.pauseWakeWord(),
        'The wake-word runtime did not pause after a microphone failure.'
      ).catch(() => undefined)
      return result
    },
    [runWakeWordAction, setPipelineState]
  )

  const prepare = useCallback(async (): Promise<ActionResult> => {
    desiredListeningRef.current = false
    deliveryEnabledRef.current = false
    const generation = transitionGenerationRef.current + 1
    transitionGenerationRef.current = generation
    try {
      await prepareAttempt(generation)
      return success('The microphone pipeline is prepared and paused.')
    } catch (error) {
      return failPipeline(generation, error)
    }
  }, [failPipeline, prepareAttempt])

  const pause = useCallback(async (): Promise<ActionResult> => {
    desiredListeningRef.current = false
    deliveryEnabledRef.current = false
    const currentState = pipelineStateRef.current
    if (decideMicrophoneTransition(false, currentState) !== 'pause') {
      if (mountedRef.current) setInputLevel(0)
      return success('Voice listening is already paused.')
    }

    transitionGenerationRef.current += 1
    cancelChunkWaiters()
    setPipelineState('paused')
    if (mountedRef.current) setInputLevel(0)

    const context = contextRef.current
    const [runtimeResult] = await Promise.all([
      runWakeWordAction(
        window.orbit.pauseWakeWord(),
        'The wake-word runtime did not pause in time.'
      ).catch(() => success('The wake-word runtime pause was interrupted.')),
      context?.state === 'running'
        ? withDeadline(
            context.suspend(),
            AUDIO_STATE_TIMEOUT_MS,
            'MICROPHONE_PAUSE_TIMEOUT',
            'The microphone audio context did not pause in time.'
          ).catch(() => undefined)
        : Promise.resolve()
    ])
    return runtimeResult
  }, [cancelChunkWaiters, runWakeWordAction, setPipelineState])

  const resume = useCallback(async (): Promise<ActionResult> => {
    desiredListeningRef.current = true
    const currentState = pipelineStateRef.current
    if (currentState === 'error') {
      return {
        ok: false,
        code: 'WAKE_WORD_MICROPHONE_FAILED',
        message: pipelineError ?? 'Voice listening cannot resume from an error state.',
        recoverable: true
      }
    }
    if (decideMicrophoneTransition(true, currentState) !== 'resume') {
      return success('Voice listening is already active or transitioning.')
    }

    deliveryEnabledRef.current = false
    const generation = transitionGenerationRef.current + 1
    transitionGenerationRef.current = generation
    if (pipelineStateRef.current !== 'recovering') setPipelineState('starting')

    try {
      await activateAttempt(generation, false)
      return success('Voice listening is active.')
    } catch (firstError) {
      if (
        firstError instanceof PipelineCancelledError ||
        generation !== transitionGenerationRef.current ||
        !desiredListeningRef.current
      ) {
        return success('The microphone transition was superseded.')
      }

      setPipelineState('recovering')
      await releaseAudio()
      try {
        ensureCurrentTransition(generation)
        await activateAttempt(generation, true)
        return success('Voice listening recovered and is active.')
      } catch (recoveryError) {
        return failPipeline(generation, recoveryError)
      }
    }
  }, [
    activateAttempt,
    ensureCurrentTransition,
    failPipeline,
    pipelineError,
    releaseAudio,
    setPipelineState
  ])

  const stop = useCallback(async (): Promise<ActionResult> => {
    desiredListeningRef.current = false
    deliveryEnabledRef.current = false
    const generation = transitionGenerationRef.current + 1
    transitionGenerationRef.current = generation
    recoveryInFlightRef.current = false
    setPipelineState('off')
    if (mountedRef.current) {
      setPipelineError(null)
      setInputLevel(0)
    }

    await releaseAudio()
    if (generation !== transitionGenerationRef.current || desiredListeningRef.current) {
      return success('The stop request was superseded by a newer microphone transition.')
    }
    return runWakeWordAction(
      window.orbit.stopWakeWord(),
      'The wake-word runtime did not stop in time.'
    ).catch(() => success('Voice listening was stopped locally.'))
  }, [releaseAudio, runWakeWordAction, setPipelineState])

  const recoverFromIncident = useCallback(
    async (reason: string): Promise<void> => {
      if (
        recoveryInFlightRef.current ||
        !desiredListeningRef.current ||
        pipelineStateRef.current !== 'active'
      ) {
        return
      }

      recoveryInFlightRef.current = true
      deliveryEnabledRef.current = false
      setPipelineState('recovering')
      const generation = transitionGenerationRef.current + 1
      transitionGenerationRef.current = generation

      await runWakeWordAction(
        window.orbit.pauseWakeWord(),
        'The wake-word runtime did not pause during microphone recovery.'
      ).catch(() => undefined)
      await releaseAudio()

      try {
        ensureCurrentTransition(generation)
        if (!desiredListeningRef.current) throw new PipelineCancelledError()
        await activateAttempt(generation, true)
      } catch (error) {
        const result = await failPipeline(generation, error)
        if (mountedRef.current && !result.ok) {
          setPipelineError(`${reason} ${result.message}`)
        }
      } finally {
        recoveryInFlightRef.current = false
      }
    }, [
      activateAttempt,
      ensureCurrentTransition,
      failPipeline,
      releaseAudio,
      runWakeWordAction,
      setPipelineState
    ]
  )

  useEffect(() => {
    const handler = (reason: string): void => {
      void recoverFromIncident(reason)
    }
    incidentHandlerRef.current = handler
    return () => {
      if (incidentHandlerRef.current === handler) incidentHandlerRef.current = null
    }
  }, [recoverFromIncident])

  useEffect(() => {
    const timer = setInterval(() => {
      if (
        pipelineStateRef.current !== 'active' ||
        !desiredListeningRef.current ||
        recoveryInFlightRef.current
      ) {
        return
      }

      const context = contextRef.current
      const tracks = streamRef.current?.getAudioTracks() ?? []
      if (!context || context.state !== 'running') {
        incidentHandlerRef.current?.('The microphone audio context stopped running.')
        return
      }
      if (tracks.length === 0 || tracks.some((track) => track.readyState !== 'live' || track.muted)) {
        incidentHandlerRef.current?.('The microphone track stopped providing audio.')
        return
      }
      if (performance.now() - lastChunkAtRef.current > AUDIO_STALL_TIMEOUT_MS) {
        incidentHandlerRef.current?.('The microphone stopped producing audio samples.')
      }
    }, WATCHDOG_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    setPipelineStateValue(pipelineStateRef.current)

    return () => {
      mountedRef.current = false
      desiredListeningRef.current = false
      deliveryEnabledRef.current = false
      transitionGenerationRef.current += 1
      setPipelineState('off')
      void releaseAudio()
      void window.orbit.stopWakeWord().catch(() => undefined)
    }
  }, [releaseAudio, setPipelineState])

  return {
    microphoneName,
    inputLevel,
    pipelineState,
    pipelineError,
    prepare,
    stop,
    pause,
    resume
  }
}
