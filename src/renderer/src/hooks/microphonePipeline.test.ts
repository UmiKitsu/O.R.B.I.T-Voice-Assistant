import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  calculateInputLevel,
  isValidAudioChunk,
  withDeadline
} from './microphonePipeline'

afterEach(() => vi.useRealTimers())

describe('microphone sample validation', () => {
  it('accepts silent audio as a live sample', () => {
    const samples = new Float32Array([0, 0, 0, 0])
    expect(isValidAudioChunk(samples)).toBe(true)
    expect(calculateInputLevel(samples)).toBe(0)
  })

  it('rejects empty and invalid sample arrays', () => {
    expect(isValidAudioChunk(new Float32Array())).toBe(false)
    expect(isValidAudioChunk(new Float32Array([0, Number.NaN]))).toBe(false)
    expect(isValidAudioChunk([0, 0])).toBe(false)
  })

  it('caps the displayed level', () => {
    expect(calculateInputLevel(new Float32Array([1, -1]))).toBe(1)
  })
})

describe('operation deadlines', () => {
  it('returns the configured timeout error', async () => {
    vi.useFakeTimers()
    const pending = new Promise<void>(() => {})
    const result = withDeadline(pending, 100, 'TEST_TIMEOUT', 'Operation timed out.')
    const rejection = expect(result).rejects.toMatchObject({
      code: 'TEST_TIMEOUT',
      message: 'Operation timed out.'
    })
    await vi.advanceTimersByTimeAsync(100)
    await rejection
  })
})
