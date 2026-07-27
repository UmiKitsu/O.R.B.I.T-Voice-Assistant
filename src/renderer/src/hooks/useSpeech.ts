import { useCallback, useEffect, useRef, useState } from 'react'
import type { KokoroVoice, SpeechEngine, SpeechSynthesisEvent } from '../../../shared/types'

const LARGE_CODE_BLOCK_LENGTH = 240

export type UseSpeechResult = {
  speak: (text: string) => boolean
  stop: () => void
  speaking: boolean
  synthesizing: boolean
  fallbackNotice: string | null
  voices: SpeechSynthesisVoice[]
  selectedVoice: SpeechSynthesisVoice | null
  setSelectedVoice: (voice: SpeechSynthesisVoice | null) => void
  engine: SpeechEngine
  setEngine: (engine: SpeechEngine) => void
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
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoice, setSelectedVoiceState] = useState<SpeechSynthesisVoice | null>(null)
  const [engine, setEngineState] = useState<SpeechEngine>('kokoro')
  const [kokoroVoice, setKokoroVoiceState] = useState<KokoroVoice>('bm_george')
  const [speaking, setSpeaking] = useState(false)
  const [synthesizing, setSynthesizing] = useState(false)
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null)
  const [rate, setRateState] = useState(1)
  const [volume, setVolumeState] = useState(1)
  const activeUtterance = useRef<SpeechSynthesisUtterance | null>(null)
  const activeKokoroRequest = useRef<string | null>(null)
  const pendingKokoroText = useRef<string | null>(null)
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
    activeUtterance.current = null
    activeKokoroRequest.current = null
    pendingKokoroText.current = null
    stopAudioNodes()
    window.speechSynthesis.cancel()
    void window.orbit.cancelSpeech().catch(() => undefined)
    setSpeaking(false)
    setSynthesizing(false)
  }, [stopAudioNodes])

  useEffect(() => {
    const speechSynthesis = window.speechSynthesis

    const refreshVoices = (): void => {
      const installedVoices = speechSynthesis.getVoices()
      setVoices(installedVoices)
      setSelectedVoiceState((current) => {
        if (current) {
          const retainedVoice = installedVoices.find((voice) => voice.voiceURI === current.voiceURI)
          if (retainedVoice) return retainedVoice
        }
        return installedVoices.find((voice) => voice.default) ?? installedVoices[0] ?? null
      })
    }

    refreshVoices()
    speechSynthesis.addEventListener('voiceschanged', refreshVoices)
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', refreshVoices)
      speechSynthesis.cancel()
    }
  }, [])

  const speakWithWindows = useCallback(
    (text: string, expectedGeneration: number): void => {
      if (generation.current !== expectedGeneration) return
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.voice = selectedVoice
      utterance.rate = rate
      utterance.volume = volume
      activeUtterance.current = utterance
      setSynthesizing(false)
      setSpeaking(true)
      const finish = (): void => {
        if (generation.current !== expectedGeneration || activeUtterance.current !== utterance)
          return
        activeUtterance.current = null
        setSpeaking(false)
      }
      utterance.onend = finish
      utterance.onerror = finish
      window.speechSynthesis.speak(utterance)
    },
    [rate, selectedVoice, volume]
  )

  const scheduleKokoroAudio = useCallback(
    (event: Extract<SpeechSynthesisEvent, { type: 'audio' }>): void => {
      const context = audioContext.current ?? new AudioContext()
      audioContext.current = context
      if (context.state === 'suspended') void context.resume()
      const buffer = context.createBuffer(1, event.samples.length, event.sampleRate)
      const channelSamples = new Float32Array(event.samples.length)
      channelSamples.set(event.samples)
      buffer.copyToChannel(channelSamples, 0)
      const source = context.createBufferSource()
      const gain = context.createGain()
      gain.gain.value = volume
      source.buffer = buffer
      source.connect(gain)
      gain.connect(context.destination)
      const startAt = Math.max(context.currentTime + 0.01, nextPlaybackTime.current)
      nextPlaybackTime.current = startAt + buffer.duration
      scheduledSources.current.add(source)
      source.onended = () => {
        scheduledSources.current.delete(source)
        if (event.final && activeKokoroRequest.current === event.requestId) {
          activeKokoroRequest.current = null
          pendingKokoroText.current = null
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
        setSpeaking(false)
        setSynthesizing(false)
        return
      }

      const text = pendingKokoroText.current
      const expectedGeneration = currentGeneration.current
      activeKokoroRequest.current = null
      pendingKokoroText.current = null
      setFallbackNotice(`${event.message} Using Windows speech instead.`)
      if (text) speakWithWindows(text, expectedGeneration)
    })
  }, [scheduleKokoroAudio, speakWithWindows])

  useEffect(
    () => () => {
      generation.current += 1
      stopAudioNodes()
      void window.orbit.cancelSpeech().catch(() => undefined)
      void audioContext.current?.close()
    },
    [stopAudioNodes]
  )

  const setSelectedVoice = useCallback((voice: SpeechSynthesisVoice | null): void => {
    setSelectedVoiceState(voice)
  }, [])
  const setEngine = useCallback((nextEngine: SpeechEngine): void => setEngineState(nextEngine), [])
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
      window.speechSynthesis.cancel()
      void window.orbit.cancelSpeech().catch(() => undefined)
      generation.current += 1
      currentGeneration.current = generation.current
      const expectedGeneration = generation.current
      const normalized = text.trim()
      setFallbackNotice(null)
      setSpeaking(false)

      if (engine === 'windows') {
        speakWithWindows(normalized, expectedGeneration)
        return true
      }

      setSynthesizing(true)
      pendingKokoroText.current = normalized
      void window.orbit
        .synthesizeSpeech(normalized)
        .then((result) => {
          if (generation.current !== expectedGeneration) return
          if (result.ok && result.data) {
            activeKokoroRequest.current = result.data.requestId
            return
          }
          pendingKokoroText.current = null
          setFallbackNotice(`${result.message} Using Windows speech instead.`)
          speakWithWindows(normalized, expectedGeneration)
        })
        .catch(() => {
          if (generation.current !== expectedGeneration) return
          pendingKokoroText.current = null
          setFallbackNotice('Kokoro could not start. Using Windows speech instead.')
          speakWithWindows(normalized, expectedGeneration)
        })
      return true
    },
    [engine, speakWithWindows, stopAudioNodes]
  )

  return {
    speak,
    stop,
    speaking,
    synthesizing,
    fallbackNotice,
    voices,
    selectedVoice,
    setSelectedVoice,
    engine,
    setEngine,
    kokoroVoice,
    setKokoroVoice,
    rate,
    setRate,
    volume,
    setVolume
  }
}
