import { useCallback, useRef, useState } from 'react'
import type { ActionResult } from '../../../shared/types'

const WAKE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

export type WakeWordController = {
  microphoneName: string
  inputLevel: number
  stop: () => Promise<ActionResult>
  pause: () => Promise<ActionResult>
  resume: () => Promise<ActionResult>
}

function microphoneFailure(error: unknown): ActionResult {
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
    message: 'Wake-word listening could not access the microphone.',
    recoverable: true
  }
}

function supersededTransition(message: string): ActionResult {
  return { ok: true, message }
}

export function useWakeWord(): WakeWordController {
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const startPromiseRef = useRef<Promise<ActionResult> | null>(null)
  const transitionTailRef = useRef<Promise<void>>(Promise.resolve())
  const desiredListeningRef = useRef(false)
  const lifecycleGenerationRef = useRef(0)
  const [microphoneName, setMicrophoneName] = useState('Default microphone')
  const [inputLevel, setInputLevel] = useState(0)

  const enqueueTransition = useCallback(
    (operation: () => Promise<ActionResult>): Promise<ActionResult> => {
      const result = transitionTailRef.current.then(operation, operation)
      transitionTailRef.current = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
    []
  )

  const releaseAudio = useCallback(async (): Promise<void> => {
    setInputLevel(0)
    workletRef.current?.disconnect()
    workletRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') await context.close().catch(() => undefined)
  }, [])

  const suspendAudio = useCallback(async (): Promise<void> => {
    const context = contextRef.current
    if (context?.state === 'running') await context.suspend().catch(() => undefined)
    setInputLevel(0)
  }, [])

  const start = useCallback(async (): Promise<ActionResult> => {
    if (streamRef.current && contextRef.current) {
      await contextRef.current.resume().catch(() => undefined)
      return window.orbit.resumeWakeWord()
    }
    if (startPromiseRef.current) return startPromiseRef.current

    const generation = lifecycleGenerationRef.current
    const operation = (async (): Promise<ActionResult> => {
      const runtime = await window.orbit.startWakeWord()
      if (!runtime.ok) return runtime
      if (generation !== lifecycleGenerationRef.current) {
        await window.orbit.stopWakeWord()
        return { ok: true, message: 'Voice listening was stopped.' }
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: WAKE_AUDIO_CONSTRAINTS })
        setMicrophoneName(stream.getAudioTracks()[0]?.label || 'Default microphone')
        const context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
        if (generation !== lifecycleGenerationRef.current) {
          stream.getTracks().forEach((track) => track.stop())
          await context.close()
          await window.orbit.stopWakeWord()
          return { ok: true, message: 'Voice listening was stopped.' }
        }
        if (context.sampleRate !== 16_000) {
          stream.getTracks().forEach((track) => track.stop())
          await context.close()
          await window.orbit.stopWakeWord()
          return {
            ok: false,
            code: 'WAKE_WORD_SAMPLE_RATE_UNAVAILABLE',
            message: 'The microphone could not provide the required local wake-word audio format.',
            recoverable: true
          }
        }

        await context.audioWorklet.addModule(
          new URL('wake-word-processor.js', document.baseURI).toString()
        )
        const source = context.createMediaStreamSource(stream)
        const worklet = new AudioWorkletNode(context, 'orbit-wake-word-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        })
        const silentOutput = context.createGain()
        silentOutput.gain.value = 0
        worklet.port.onmessage = (event: MessageEvent<unknown>) => {
          if (!(event.data instanceof Float32Array) || !desiredListeningRef.current) return
          let energy = 0
          for (const sample of event.data) energy += sample * sample
          const rms = Math.sqrt(energy / event.data.length)
          setInputLevel(Math.min(1, rms * 12))
          window.orbit.sendWakeWordAudio(event.data)
        }
        source.connect(worklet)
        worklet.connect(silentOutput)
        silentOutput.connect(context.destination)

        if (generation !== lifecycleGenerationRef.current) {
          worklet.disconnect()
          stream.getTracks().forEach((track) => track.stop())
          await context.close()
          await window.orbit.stopWakeWord()
          return { ok: true, message: 'Voice listening was stopped.' }
        }

        streamRef.current = stream
        contextRef.current = context
        workletRef.current = worklet
        await context.resume()
        return runtime
      } catch (error) {
        await releaseAudio()
        await window.orbit.stopWakeWord()
        return microphoneFailure(error)
      }
    })()

    startPromiseRef.current = operation
    try {
      return await operation
    } finally {
      startPromiseRef.current = null
    }
  }, [releaseAudio])

  const stop = useCallback(async (): Promise<ActionResult> => {
    desiredListeningRef.current = false
    lifecycleGenerationRef.current += 1
    return enqueueTransition(async () => {
      await releaseAudio()
      return window.orbit.stopWakeWord()
    })
  }, [enqueueTransition, releaseAudio])

  const pause = useCallback(async (): Promise<ActionResult> => {
    desiredListeningRef.current = false
    return enqueueTransition(async () => {
      if (desiredListeningRef.current) {
        return supersededTransition('Voice listening remains active.')
      }

      const result = await window.orbit.pauseWakeWord()
      if (!desiredListeningRef.current) await suspendAudio()
      return result
    })
  }, [enqueueTransition, suspendAudio])

  const resume = useCallback(async (): Promise<ActionResult> => {
    desiredListeningRef.current = true
    return enqueueTransition(async () => {
      if (!desiredListeningRef.current) {
        return supersededTransition('Voice listening remains paused.')
      }

      const context = contextRef.current
      const stream = streamRef.current
      const hasLiveTrack =
        stream?.getAudioTracks().some((track) => track.readyState === 'live') === true
      let result: ActionResult

      if (!context || !stream || !hasLiveTrack || context.state === 'closed') {
        if (context || stream) await releaseAudio()
        result = await start()
      } else {
        result = await window.orbit.resumeWakeWord()
        if (result.ok && desiredListeningRef.current && context.state === 'suspended') {
          try {
            await context.resume()
          } catch {
            await releaseAudio()
            result = await start()
          }
        }
      }

      if (!desiredListeningRef.current) {
        await window.orbit.pauseWakeWord()
        await suspendAudio()
      }
      return result
    })
  }, [enqueueTransition, releaseAudio, start, suspendAudio])

  return { microphoneName, inputLevel, stop, pause, resume }
}
