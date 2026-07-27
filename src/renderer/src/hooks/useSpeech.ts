import { useCallback, useEffect, useRef, useState } from 'react'

const LARGE_CODE_BLOCK_LENGTH = 240

export type UseSpeechResult = {
  speak: (text: string) => boolean
  stop: () => void
  speaking: boolean
  voices: SpeechSynthesisVoice[]
  selectedVoice: SpeechSynthesisVoice | null
  setSelectedVoice: (voice: SpeechSynthesisVoice | null) => void
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
  if (/\b(?:TypeError|ReferenceError|SyntaxError|RangeError):.+\n\s*at\s+/s.test(trimmed))
    return false

  return true
}

export function useSpeech(enabled = true): UseSpeechResult {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [selectedVoice, setSelectedVoiceState] = useState<SpeechSynthesisVoice | null>(null)
  const [speaking, setSpeaking] = useState(false)
  const [rate, setRateState] = useState(1)
  const [volume, setVolumeState] = useState(1)
  const activeUtterance = useRef<SpeechSynthesisUtterance | null>(null)
  const generation = useRef(0)

  const stop = useCallback((): void => {
    generation.current += 1
    activeUtterance.current = null
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [])

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

  const setSelectedVoice = useCallback((voice: SpeechSynthesisVoice | null): void => {
    setSelectedVoiceState(voice)
  }, [])

  const setRate = useCallback((nextRate: number): void => {
    setRateState(Math.min(2, Math.max(0.5, nextRate)))
  }, [])

  const setVolume = useCallback((nextVolume: number): void => {
    setVolumeState(Math.min(1, Math.max(0, nextVolume)))
  }, [])

  const speak = useCallback(
    (text: string): boolean => {
      window.speechSynthesis.cancel()
      generation.current += 1
      activeUtterance.current = null
      setSpeaking(false)

      if (!enabled || !isSafeToSpeak(text)) return false

      const utterance = new SpeechSynthesisUtterance(text.trim())
      const utteranceGeneration = generation.current
      utterance.voice = selectedVoice
      utterance.rate = rate
      utterance.volume = volume

      utterance.onstart = (): void => {
        if (generation.current !== utteranceGeneration) return
        activeUtterance.current = utterance
        setSpeaking(true)
      }

      const finish = (): void => {
        if (generation.current !== utteranceGeneration || activeUtterance.current !== utterance) {
          return
        }

        activeUtterance.current = null
        setSpeaking(false)
      }

      utterance.onend = finish
      utterance.onerror = finish
      window.speechSynthesis.speak(utterance)
      return true
    },
    [enabled, rate, selectedVoice, volume]
  )

  return {
    speak,
    stop,
    speaking,
    voices,
    selectedVoice,
    setSelectedVoice,
    rate,
    setRate,
    volume,
    setVolume
  }
}
