import { describe, expect, it } from 'vitest'
import { hasAudiblePcm16Samples, isPcmWav, normalizeWhisperOutput } from './speechToTextValidation'

function pcmWav(sample: number): Uint8Array {
  const bytes = new Uint8Array(46)
  const view = new DataView(bytes.buffer)
  ;['R', 'I', 'F', 'F'].forEach((value, index) => view.setUint8(index, value.charCodeAt(0)))
  ;['W', 'A', 'V', 'E'].forEach((value, index) => view.setUint8(index + 8, value.charCodeAt(0)))
  ;['f', 'm', 't', ' '].forEach((value, index) => view.setUint8(index + 12, value.charCodeAt(0)))
  ;['d', 'a', 't', 'a'].forEach((value, index) => view.setUint8(index + 36, value.charCodeAt(0)))
  view.setUint32(4, 38, true)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(40, 2, true)
  view.setInt16(44, sample, true)
  return bytes
}

describe('speech-to-text validation', () => {
  it('accepts PCM WAV data and rejects arbitrary bytes', () => {
    expect(isPcmWav(pcmWav(100))).toBe(true)
    expect(isPcmWav(new Uint8Array(46))).toBe(false)
  })

  it('distinguishes silence from audible PCM samples', () => {
    expect(hasAudiblePcm16Samples(pcmWav(0))).toBe(false)
    expect(hasAudiblePcm16Samples(pcmWav(100))).toBe(true)
  })

  it('normalizes timestamped whisper output and ignores silence markers', () => {
    expect(
      normalizeWhisperOutput('  [00:00:00.000 --> 00:00:01.000]  Open YouTube.\n[silence]\n')
    ).toBe('Open YouTube.')
  })
})
