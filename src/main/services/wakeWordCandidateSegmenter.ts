import type { WakeSignalQuality } from '../../shared/types'

export const WAKE_AUDIO_SAMPLE_RATE = 16_000
export const WAKE_AUDIO_CHUNK_SAMPLES = 1_600
export const WAKE_CANDIDATE_PRE_ROLL_SAMPLES = Math.round(WAKE_AUDIO_SAMPLE_RATE * 0.3)
export const WAKE_CANDIDATE_SILENCE_SAMPLES = Math.round(WAKE_AUDIO_SAMPLE_RATE * 0.7)
export const WAKE_CANDIDATE_MAX_SAMPLES = WAKE_AUDIO_SAMPLE_RATE * 8

const MIN_SPEECH_SAMPLES = Math.round(WAKE_AUDIO_SAMPLE_RATE * 0.2)
const MIN_SPEECH_RMS = 0.006
const SPEECH_TO_NOISE_RATIO = 2.5

export type WakeAudioMetrics = {
  captureDurationMs: number
  audioChunkCount: number
  peakLevel: number
  rmsLevel: number
  signalQuality: WakeSignalQuality
}

export type WakeSpeechCandidate = {
  samples: Float32Array
  metrics: WakeAudioMetrics
}

function concatenate(parts: readonly Float32Array[]): Float32Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const result = new Float32Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export function classifyWakeSignal(peakLevel: number, rmsLevel: number): WakeSignalQuality {
  if (peakLevel < 0.005 || rmsLevel < 0.001) return 'none'
  if (peakLevel < 0.02 || rmsLevel < MIN_SPEECH_RMS) return 'low'
  return 'good'
}

export class WakeAudioMetricsAccumulator {
  private sampleCount = 0
  private chunkCount = 0
  private peak = 0
  private sumSquares = 0

  add(samples: Float32Array): void {
    this.chunkCount += 1
    this.sampleCount += samples.length
    for (const sample of samples) {
      const absolute = Math.abs(sample)
      if (absolute > this.peak) this.peak = absolute
      this.sumSquares += sample * sample
    }
  }

  snapshot(): WakeAudioMetrics {
    const rmsLevel =
      this.sampleCount === 0 ? 0 : Math.sqrt(this.sumSquares / Math.max(1, this.sampleCount))
    return {
      captureDurationMs: Math.round((this.sampleCount / WAKE_AUDIO_SAMPLE_RATE) * 1_000),
      audioChunkCount: this.chunkCount,
      peakLevel: this.peak,
      rmsLevel,
      signalQuality: classifyWakeSignal(this.peak, rmsLevel)
    }
  }

  reset(): void {
    this.sampleCount = 0
    this.chunkCount = 0
    this.peak = 0
    this.sumSquares = 0
  }
}

export function summarizeWakeAudio(samples: Float32Array): WakeAudioMetrics {
  const accumulator = new WakeAudioMetricsAccumulator()
  for (let offset = 0; offset < samples.length; offset += WAKE_AUDIO_CHUNK_SAMPLES) {
    accumulator.add(
      samples.subarray(offset, Math.min(samples.length, offset + WAKE_AUDIO_CHUNK_SAMPLES))
    )
  }
  return accumulator.snapshot()
}

export class WakeWordCandidateSegmenter {
  private noiseFloor = 0.003
  private preRoll: Float32Array[] = []
  private preRollSampleCount = 0
  private captured: Float32Array[] = []
  private capturedSampleCount = 0
  private lastSpeechSample = 0
  private speechSampleCount = 0
  private consecutiveSpeechChunks = 0

  private level(samples: Float32Array): number {
    let energy = 0
    for (const sample of samples) energy += sample * sample
    return samples.length === 0 ? 0 : Math.sqrt(energy / samples.length)
  }

  private speechThreshold(): number {
    return Math.max(MIN_SPEECH_RMS, this.noiseFloor * SPEECH_TO_NOISE_RATIO)
  }

  private appendPreRoll(samples: Float32Array): void {
    this.preRoll.push(samples)
    this.preRollSampleCount += samples.length
    while (this.preRollSampleCount > WAKE_CANDIDATE_PRE_ROLL_SAMPLES) {
      const removed = this.preRoll.shift()
      if (!removed) break
      this.preRollSampleCount -= removed.length
    }
  }

  private finishCandidate(): WakeSpeechCandidate | null {
    if (this.speechSampleCount < MIN_SPEECH_SAMPLES) {
      this.resetCapture()
      return null
    }
    const samples = concatenate(this.captured)
    const candidate = { samples, metrics: summarizeWakeAudio(samples) }
    this.resetCapture()
    return candidate
  }

  private resetCapture(): void {
    this.preRoll = []
    this.preRollSampleCount = 0
    this.captured = []
    this.capturedSampleCount = 0
    this.lastSpeechSample = 0
    this.speechSampleCount = 0
    this.consecutiveSpeechChunks = 0
  }

  push(samples: Float32Array): WakeSpeechCandidate | null {
    const level = this.level(samples)
    const threshold = this.speechThreshold()
    const isSpeech = level >= threshold

    if (this.captured.length === 0) {
      this.noiseFloor = Math.max(
        0.001,
        Math.min(0.02, this.noiseFloor * 0.98 + Math.min(level, 0.02) * 0.02)
      )
      this.appendPreRoll(samples)
      this.consecutiveSpeechChunks = isSpeech ? this.consecutiveSpeechChunks + 1 : 0
      if (this.consecutiveSpeechChunks < 2) return null

      this.captured = [...this.preRoll]
      this.capturedSampleCount = this.preRollSampleCount
      this.speechSampleCount = Math.min(
        this.capturedSampleCount,
        this.consecutiveSpeechChunks * samples.length
      )
      this.lastSpeechSample = this.capturedSampleCount
      this.preRoll = []
      this.preRollSampleCount = 0
      return null
    }

    this.captured.push(samples)
    this.capturedSampleCount += samples.length
    if (isSpeech) {
      this.lastSpeechSample = this.capturedSampleCount
      this.speechSampleCount += samples.length
    }

    const trailingSilence = this.capturedSampleCount - this.lastSpeechSample
    if (
      this.capturedSampleCount >= WAKE_CANDIDATE_MAX_SAMPLES ||
      trailingSilence >= WAKE_CANDIDATE_SILENCE_SAMPLES
    ) {
      return this.finishCandidate()
    }
    return null
  }

  flush(): WakeSpeechCandidate | null {
    if (this.captured.length === 0) return null
    return this.finishCandidate()
  }

  reset(): void {
    this.resetCapture()
  }
}
