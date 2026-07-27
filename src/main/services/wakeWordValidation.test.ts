import { describe, expect, it } from 'vitest'
import {
  encodePcm16Wav,
  isValidWakeWordCommand,
  parseWakeWordAudioChunk,
  stripWakePhrase,
  stripWakePhraseDetails
} from './wakeWordValidation'

describe('wake-word validation', () => {
  it('accepts only a bounded strict Float32 audio request', () => {
    const samples = new Float32Array([0, 0.25, -0.25])
    const parsed = parseWakeWordAudioChunk({ samples })
    expect(parsed).toEqual(samples)
    expect(parsed).not.toBe(samples)
    expect(parseWakeWordAudioChunk({ samples, path: 'unexpected' })).toBeNull()
    expect(parseWakeWordAudioChunk({ samples: new Float32Array(3_201) })).toBeNull()
    expect(parseWakeWordAudioChunk({ samples: new Float32Array([Number.NaN]) })).toBeNull()
    expect(parseWakeWordAudioChunk({ samples: new Float32Array([1.1]) })).toBeNull()
  })

  it.each(['Titan', 'TITAN', 'taitan', 'tytan', 'tighten', 'tie tan', 'Hey, taitan'])(
    'accepts %s as a leading wake phrase',
    (wakePhrase) => {
      expect(stripWakePhrase(`${wakePhrase}, open Spotify.`)).toBe('open Spotify.')
    }
  )

  it('reports corrected wake spellings without stripping unrelated uses', () => {
    expect(stripWakePhraseDetails('Taitan, open Spotify.')).toEqual({
      text: 'open Spotify.',
      wakeWord: { from: 'Taitan', to: 'Titan' }
    })
    expect(stripWakePhrase('Explain the word titan')).toBe('Explain the word titan')
    expect(stripWakePhrase('Titan')).toBe('')
  })

  it('bounds complete commands and produces a valid mono PCM WAV', () => {
    const samples = new Float32Array([0, 1, -1])
    expect(isValidWakeWordCommand(samples)).toBe(true)
    expect(isValidWakeWordCommand(new Float32Array(16_000 * 14 + 1))).toBe(false)

    const wav = encodePcm16Wav(samples)
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
  })
})
