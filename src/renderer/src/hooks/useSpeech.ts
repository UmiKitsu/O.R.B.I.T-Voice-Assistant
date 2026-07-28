import { useCallback, useEffect, useRef, useState } from 'react'
import type { KokoroVoice, SpeechSynthesisEvent } from '../../../shared/types'

const LARGE_CODE_BLOCK_LENGTH = 240
const ORBIT_SPEECH_OUTPUT_BOOST = 1.8
const RETRYABLE_KOKORO_ERRORS = new Set([
  'KOKORO_RUNTIME_FAILED',
  'KOKORO_PROCESS_MESSAGE_FAILED',
  'KOKORO_PROCESS_EXITED',
  'KOKORO_NOT_READY'
])

export type UseSpeechResult = {
  speak: (text: string) => boolean
  stop: () => void
  speaking: boolean
  synthesizing: boolean
  speechNotice: string | null
  kokoroVoice: KokoroVoice
  setKokoroVoice: (voice: KokoroVoice) => void
  rate: number
  setRate: (rate: number) => void
  volume: number
  setVolume: (volume: number) => void
}

function isActionPlanJson(text: string): boolean {
  const candidate = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')

  if (!candidate.startsWith('{')) return false

  try {
    const parsed: unknown = JSON.parse(candidate)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      ('actions' in parsed || ('kind' in parsed && parsed.kind === 'action_plan'))
    )
  } catch {
    return false
  }
}

export function calculateSpeechOutputGain(volume: number): number {
  return Math.min(1, Math.max(0, volume)) * ORBIT_SPEECH_OUTPUT_BOOST
}

export function isSafeToSpeak(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  const fencedBlocks = trimmed.match(/```[\s\S]*?```/g) ?? []
  if (fencedBlocks.some((block) => block.length >= LARGE_CODE_BLOCK_LENGTH)) return false

  if (isActionPlanJson(trimmed)) return false
  if (/"kind"\s*:\s*"action_plan"|"capability"\s*:|"actions"\s*:\s*\[/i.test(trimmed)) {
    return false
  }
  if (/^\s*(?:\[?(?:debug|trace)\]?[:\s]|debug log\b)/im.test(trimmed)) return false
  if (/^\s*(?:at\s+\S+\s+\(.+:\d+:\d+\)|caused by:|stack trace:)/im.test(trimmed)) return false
  if (/^\s*(?:internal error|error details|diagnostic details)\s*:/im.test(trimmed)) return false
  if (/\b(?:TypeError|ReferenceError|SyntaxError|RangeError):.+\n\s*at\s+/s.test(trimmed)) {
    return false
  }

  return true
}

export function useSpeech(): UseSpeechResult {
  const [kokoroVoice, setKokoroVoiceState] = useState<KokoroVoice>('bm_george')
  const [speaking, setSpeaking] = useState(false)
  const [synthesizing, setSynthesizing] = useState(false)
  const [speechNotice, setSpeechNotice] = useState<string | null>(null)
  const [rate, setRateState] = useState(1)
  const [volume, setVolumeState] = useState(1)
  const activeKokoroRequest = useRef<string | null>(null)
  const pendingKokoroText = useRef<string | null>(null)
  const kokoroRetryAttempt = useRef(0)
  const audioContext = useRef<AudioContext | null>(null)
  const scheduledSources = useRef(new Set<AudioBufferSourceNode>())
  const nextPlaybackTime = useRef(0)
  const generation = useRef(0)
  const currentGeneration = useRef(0)

  const stopAudioNodes = useCallback((): void => {
    for (const source of scheduledSources.current) {
      try {
        source.stop()
      } catch {
        // An already-ended Web Audio source cannot be stopped twice.
      }
    }
    scheduledSources.current.clear()
    nextPlaybackTime.current = 0
  }, [])

  const stop = useCallback((): void => {
    generation.current += 1
    currentGeneration.current = generation.current
    activeKokoroRequest.current = null
    pendingKokoroText.current = null
    kokoroRetryAttempt.current = 0
    stopAudioNodes()
    void window.orbit.cancelSpeech().catch(() => undefined)
    setSpeaking(false)
    setSynthesizing(false)
  }, [stopAudioNodes])

  const scheduleKokoroAudio = useCallback(
    (event: Extract<SpeechSynthesisEvent, { type: 'audio' }>): void => {
      const context = audioContext.current ?? new AudioContext()
      audioContext.current = context
      if (context.state === 'suspended') {
        void context.resume().catch(() => {
          setSpeechNotice('Kokoro generated speech, but audio playback could not start.')
        })
      }

      const buffer = context.createBuffer(1, event.samples.length, event.sampleRate)
      const channelSamples = new Float32Array(event.samples.length)
      channelSamples.set(event.samples)
      buffer.copyToChannel(channelSamples, 0)

      const source = context.createBufferSource()
      const gain = context.createGain()
      const limiter = context.createDynamicsCompressor()
      gain.gain.value = calculateSpeechOutputGain(volume)
      limiter.threshold.value = -3
      limiter.knee.value = 6
      limiter.ratio.value = 12
      limiter.attack.value = 0.003
      limiter.release.value = 0.15
      source.buffer = buffer
      source.connect(gain)
      gain.connect(limiter)
      limiter.connect(context.destination)

      const startAt = Math.max(context.currentTime + 0.01, nextPlaybackTime.current)
      nextPlaybackTime.current = startAt + buffer.duration
      scheduledSources.current.add(source)
      source.onended = () => {
        scheduledSources.current.delete(source)
        if (event.final && activeKokoroRequest.current === event.requestId) {
          activeKokoroRequest.current = null
          pendingKokoroText.current = null
          kokoroRetryAttempt.current = 0
          nextPlaybackTime.current = 0
          setSpeaking(false)
        }
      }
      source.start(startAt)
      setSynthesizing(false)
      setSpeaking(true)
    },
    [volume]
  )

  const beginKokoroSynthesis = useCallback(
    (text: string, expectedGeneration: number, retryAttempt: number): void => {
      if (generation.current !== expectedGeneration) return

      pendingKokoroText.current = text
      kokoroRetryAttempt.current = retryAttempt
      setSynthesizing(true)
      setSpeaking(false)

      void window.orbit
        .synthesizeSpeech(text)
        .then((result) => {
          if (generation.current !== expectedGeneration) return
          if (result.ok && result.data) {
            activeKokoroRequest.current = result.data.requestId
            return
          }

          activeKokoroRequest.current = null
          pendingKokoroText.current = null
          setSynthesizing(false)
          setSpeaking(false)
          setSpeechNotice(result.message)
        })
        .catch(() => {
          if (generation.current !== expectedGeneration) return
          activeKokoroRequest.current = null
          pendingKokoroText.current = null
          setSynthesizing(false)
          setSpeaking(false)
          setSpeechNotice('Kokoro could not start. Please try speaking again.')
        })
    },
    []
  )

  useEffect(() => {
    return window.orbit.onSpeechSynthesisEvent((event) => {
      if (
        event.type === 'started' &&
        activeKokoroRequest.current === null &&
        pendingKokoroText.current
      ) {
        activeKokoroRequest.current = event.requestId
      }
      if (event.requestId !== activeKokoroRequest.current) return

      if (event.type === 'started') {
        setSynthesizing(true)
        return
      }
      if (event.type === 'audio') {
        scheduleKokoroAudio(event)
        return
      }
      if (event.type === 'cancelled') {
        activeKokoroRequest.current = null
        pendingKokoroText.current = null
        kokoroRetryAttempt.current = 0
        setSpeaking(false)
        setSynthesizing(false)
        return
      }

      const text = pendingKokoroText.current
      const expectedGeneration = currentGeneration.current
      const canRetry =
        text !== null && kokoroRetryAttempt.current < 1 && RETRYABLE_KOKORO_ERRORS.has(event.code)

      activeKokoroRequest.current = null
      stopAudioNodes()
      setSpeaking(false)
      setSynthesizing(false)

      if (canRetry && text) {
        setSpeechNotice('Kokoro restarted after a local voice interruption.')
        beginKokoroSynthesis(text, expectedGeneration, kokoroRetryAttempt.current + 1)
        return
      }

      pendingKokoroText.current = null
      kokoroRetryAttempt.current = 0
      setSpeechNotice(event.message)
    })
  }, [beginKokoroSynthesis, scheduleKokoroAudio, stopAudioNodes])

  useEffect(
    () => () => {
      generation.current += 1
      stopAudioNodes()
      void window.orbit.cancelSpeech().catch(() => undefined)
      void audioContext.current?.close()
    },
    [stopAudioNodes]
  )

  const setKokoroVoice = useCallback((voice: KokoroVoice): void => setKokoroVoiceState(voice), [])
  const setRate = useCallback((nextRate: number): void => {
    setRateState(Math.min(2, Math.max(0.5, nextRate)))
  }, [])
  const setVolume = useCallback((nextVolume: number): void => {
    setVolumeState(Math.min(1, Math.max(0, nextVolume)))
  }, [])

  const speak = useCallback(
    (text: string): boolean => {
      if (!isSafeToSpeak(text)) return false

      stopAudioNodes()
      void window.orbit.cancelSpeech().catch(() => undefined)
      generation.current += 1
      currentGeneration.current = generation.current
      const expectedGeneration = generation.current
      const normalized = text.trim()

      activeKokoroRequest.current = null
      pendingKokoroText.current = normalized
      kokoroRetryAttempt.current = 0
      setSpeechNotice(null)
      beginKokoroSynthesis(normalized, expectedGeneration, 0)
      return true
    },
    [beginKokoroSynthesis, stopAudioNodes]
  )

  return {
    speak,
    stop,
    speaking,
    synthesizing,
    speechNotice,
    kokoroVoice,
    setKokoroVoice,
    rate,
    setRate,
    volume,
    setVolume
  }
}
