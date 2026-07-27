import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActionResult, MicrophoneTestResult } from '../../../shared/types'

const TEST_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}
const MAX_TEST_DURATION_MS = 12_000

type MicrophoneTestPhase = 'idle' | 'recording' | 'transcribing'

export type MicrophoneTestController = {
  phase: MicrophoneTestPhase
  microphoneName: string
  inputLevel: number
  durationMs: number
  result: ActionResult<MicrophoneTestResult> | null
  start: () => Promise<ActionResult>
  stop: () => Promise<void>
  cancel: () => Promise<void>
  clearResult: () => void
}

function encodePcm16Wav(samples: Float32Array): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Uint8Array(buffer)
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
    code: 'MICROPHONE_TEST_FAILED',
    message: 'The microphone test could not start.',
    recoverable: true
  }
}

export function useMicrophoneTest(
  onResult: (result: ActionResult<MicrophoneTestResult>) => void
): MicrophoneTestController {
  const [phase, setPhase] = useState<MicrophoneTestPhase>('idle')
  const [microphoneName, setMicrophoneName] = useState('Default microphone')
  const [inputLevel, setInputLevel] = useState(0)
  const [durationMs, setDurationMs] = useState(0)
  const [result, setResult] = useState<ActionResult<MicrophoneTestResult> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const sampleCountRef = useRef(0)
  const startedAtRef = useRef(0)
  const recordingRef = useRef(false)
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const durationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopPromiseRef = useRef<Promise<void> | null>(null)
  const generationRef = useRef(0)

  const releaseCapture = useCallback(async (): Promise<void> => {
    if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current)
    if (durationTimerRef.current) clearInterval(durationTimerRef.current)
    autoStopTimerRef.current = null
    durationTimerRef.current = null
    workletRef.current?.disconnect()
    workletRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') await context.close().catch(() => undefined)
    setInputLevel(0)
  }, [])

  const stop = useCallback(async (): Promise<void> => {
    if (stopPromiseRef.current) return stopPromiseRef.current
    if (!recordingRef.current) return

    const generation = generationRef.current
    const operation = (async (): Promise<void> => {
      recordingRef.current = false
      await releaseCapture()
      const samples = new Float32Array(sampleCountRef.current)
      let offset = 0
      for (const chunk of chunksRef.current) {
        samples.set(chunk, offset)
        offset += chunk.length
      }
      chunksRef.current = []
      sampleCountRef.current = 0
      setDurationMs(Math.round(performance.now() - startedAtRef.current))
      setPhase('transcribing')
      try {
        const nextResult = await window.orbit.transcribeMicrophoneTest(encodePcm16Wav(samples))
        if (generation !== generationRef.current) return
        setResult(nextResult)
        onResult(nextResult)
      } catch {
        const failure: ActionResult<MicrophoneTestResult> = {
          ok: false,
          code: 'MICROPHONE_TEST_IPC_FAILED',
          message: 'The microphone test could not reach the local transcription service.',
          recoverable: true
        }
        if (generation !== generationRef.current) return
        setResult(failure)
        onResult(failure)
      } finally {
        if (generation === generationRef.current) setPhase('idle')
      }
    })()
    stopPromiseRef.current = operation
    try {
      await operation
    } finally {
      stopPromiseRef.current = null
    }
  }, [onResult, releaseCapture])

  const start = useCallback(async (): Promise<ActionResult> => {
    if (recordingRef.current) return { ok: true, message: 'Microphone test is recording.' }
    generationRef.current += 1
    await window.orbit.cancelMicrophoneTest().catch(() => undefined)
    setResult(null)
    setDurationMs(0)
    chunksRef.current = []
    sampleCountRef.current = 0

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: TEST_AUDIO_CONSTRAINTS })
      const context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
      if (context.sampleRate !== 16_000) {
        stream.getTracks().forEach((track) => track.stop())
        await context.close()
        return {
          ok: false,
          code: 'MICROPHONE_SAMPLE_RATE_UNAVAILABLE',
          message: 'The microphone could not provide 16 kHz audio for local transcription.',
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
        if (!(event.data instanceof Float32Array) || !recordingRef.current) return
        chunksRef.current.push(event.data)
        sampleCountRef.current += event.data.length
        let energy = 0
        for (const sample of event.data) energy += sample * sample
        setInputLevel(Math.min(1, Math.sqrt(energy / event.data.length) * 12))
      }
      source.connect(worklet)
      worklet.connect(silentOutput)
      silentOutput.connect(context.destination)

      streamRef.current = stream
      contextRef.current = context
      workletRef.current = worklet
      recordingRef.current = true
      startedAtRef.current = performance.now()
      setMicrophoneName(stream.getAudioTracks()[0]?.label || 'Default microphone')
      setPhase('recording')
      durationTimerRef.current = setInterval(() => {
        setDurationMs(Math.round(performance.now() - startedAtRef.current))
      }, 100)
      autoStopTimerRef.current = setTimeout(() => void stop(), MAX_TEST_DURATION_MS)
      await context.resume()
      return { ok: true, message: 'Microphone test recording started.' }
    } catch (error) {
      recordingRef.current = false
      await releaseCapture()
      return microphoneFailure(error)
    }
  }, [releaseCapture, stop])

  const cancel = useCallback(async (): Promise<void> => {
    generationRef.current += 1
    recordingRef.current = false
    chunksRef.current = []
    sampleCountRef.current = 0
    await releaseCapture()
    await window.orbit.cancelMicrophoneTest().catch(() => undefined)
    setPhase('idle')
  }, [releaseCapture])

  useEffect(() => () => void cancel(), [cancel])

  return {
    phase,
    microphoneName,
    inputLevel,
    durationMs,
    result,
    start,
    stop,
    cancel,
    clearResult: () => setResult(null)
  }
}
