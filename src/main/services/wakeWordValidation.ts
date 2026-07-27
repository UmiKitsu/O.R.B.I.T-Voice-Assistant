const MAX_WAKE_WORD_CHUNK_SAMPLES = 3_200
const MAX_WAKE_WORD_COMMAND_SAMPLES = 16_000 * 14

export function parseWakeWordAudioChunk(value: unknown): Float32Array | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('samples' in value) ||
    Object.keys(value).length !== 1
  ) {
    return null
  }

  const samples = (value as { samples?: unknown }).samples
  if (
    !(samples instanceof Float32Array) ||
    samples.length === 0 ||
    samples.length > MAX_WAKE_WORD_CHUNK_SAMPLES
  ) {
    return null
  }

  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) return null
  }
  return new Float32Array(samples)
}

export function isValidWakeWordCommand(samples: unknown): samples is Float32Array {
  if (!(samples instanceof Float32Array) || samples.length === 0) return false
  if (samples.length > MAX_WAKE_WORD_COMMAND_SAMPLES) return false
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) return false
  }
  return true
}

export type StrippedWakePhrase = {
  text: string
  wakeWord?: {
    from: string
    to: 'Orbit'
  }
}

export type WakePhraseMatch = {
  wakePhrase: string
  commandText: string
}

const WAKE_PHRASE_PREFIX =
  /^(?:hey[\s,.:;!\u2014-]+)?(orbit|or[\s-]+bit|orb[\s-]+it)\b[\s,.:;!\u2014-]*/i

export function matchWakePhraseDetails(transcription: string): WakePhraseMatch | null {
  const trimmed = transcription.trim()
  const match = trimmed.match(WAKE_PHRASE_PREFIX)
  if (!match?.[1]) return null
  return {
    wakePhrase: match[1],
    commandText: trimmed.slice(match[0].length).trim()
  }
}

export function stripWakePhraseDetails(transcription: string): StrippedWakePhrase {
  const trimmed = transcription.trim()
  const match = matchWakePhraseDetails(trimmed)
  if (!match) return { text: trimmed }

  return {
    text: match.commandText,
    wakeWord:
      match.wakePhrase.toLocaleLowerCase() === 'orbit'
        ? undefined
        : { from: match.wakePhrase, to: 'Orbit' }
  }
}

export function stripWakePhrase(transcription: string): string {
  return stripWakePhraseDetails(transcription).text
}
export function encodePcm16Wav(samples: Float32Array, sampleRate = 16_000): Uint8Array {
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
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
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
