import { describe, expect, it } from 'vitest'
import {
  WAKE_AUDIO_CHUNK_SAMPLES,
  WAKE_CANDIDATE_MAX_SAMPLES,
  WakeAudioMetricsAccumulator,
  WakeWordCandidateSegmenter,
  classifyWakeSignal,
  type WakeSpeechCandidate
} from './wakeWordCandidateSegmenter'

function chunk(level: number): Float32Array {
  return new Float32Array(WAKE_AUDIO_CHUNK_SAMPLES).fill(level)
}

describe('wake-word candidate segmentation', () => {
  it('classifies bounded input statistics without retaining audio', () => {
    const metrics = new WakeAudioMetricsAccumulator()
    metrics.add(chunk(0.03))
    metrics.add(chunk(0))

    const snapshot = metrics.snapshot()
    expect(snapshot).toMatchObject({
      captureDurationMs: 200,
      audioChunkCount: 2,
      signalQuality: 'good'
    })
    expect(snapshot.peakLevel).toBeCloseTo(0.03)
    expect(classifyWakeSignal(0, 0)).toBe('none')
    expect(classifyWakeSignal(0.01, 0.003)).toBe('low')

    metrics.reset()
    expect(metrics.snapshot()).toMatchObject({
      captureDurationMs: 0,
      audioChunkCount: 0,
      signalQuality: 'none'
    })
  })

  it('keeps pre-roll and closes a speech candidate after 700 ms of silence', () => {
    const segmenter = new WakeWordCandidateSegmenter()
    expect(segmenter.push(chunk(0))).toBeNull()
    expect(segmenter.push(chunk(0.03))).toBeNull()
    expect(segmenter.push(chunk(0.03))).toBeNull()

    let candidate: WakeSpeechCandidate | null = null
    for (let index = 0; index < 7; index += 1) {
      candidate = segmenter.push(chunk(0))
    }

    expect(candidate).not.toBeNull()
    expect(candidate?.samples.length).toBe(10 * WAKE_AUDIO_CHUNK_SAMPLES)
    expect(candidate?.metrics).toMatchObject({
      captureDurationMs: 1_000,
      audioChunkCount: 10,
      signalQuality: 'good'
    })
  })

  it('discards silence, flushes speech, resets, and caps candidates at eight seconds', () => {
    const silenceOnly = new WakeWordCandidateSegmenter()
    for (let index = 0; index < 20; index += 1) {
      expect(silenceOnly.push(chunk(0))).toBeNull()
    }
    expect(silenceOnly.flush()).toBeNull()

    const segmenter = new WakeWordCandidateSegmenter()
    segmenter.push(chunk(0.03))
    segmenter.push(chunk(0.03))
    expect(segmenter.flush()?.samples.length).toBe(2 * WAKE_AUDIO_CHUNK_SAMPLES)

    segmenter.push(chunk(0.03))
    segmenter.push(chunk(0.03))
    segmenter.reset()
    expect(segmenter.flush()).toBeNull()

    const bounded = new WakeWordCandidateSegmenter()
    let candidate: WakeSpeechCandidate | null = null
    for (let index = 0; index < 100 && !candidate; index += 1) {
      candidate = bounded.push(chunk(0.03))
    }
    expect(candidate?.samples.length).toBe(WAKE_CANDIDATE_MAX_SAMPLES)
  })
})
