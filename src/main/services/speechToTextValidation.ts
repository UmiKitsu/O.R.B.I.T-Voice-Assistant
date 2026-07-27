const RIFF_HEADER = 'RIFF'
const WAVE_HEADER = 'WAVE'

export const MAX_RECORDING_BYTES = 25 * 1024 * 1024

export function isPcmWav(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array)) return false
  if (value.byteLength < 44 || value.byteLength > MAX_RECORDING_BYTES) return false

  const header = Buffer.from(value.buffer, value.byteOffset, Math.min(value.byteLength, 44))
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  return (
    header.toString('ascii', 0, 4) === RIFF_HEADER &&
    header.toString('ascii', 8, 12) === WAVE_HEADER &&
    header.toString('ascii', 12, 16) === 'fmt ' &&
    header.toString('ascii', 36, 40) === 'data' &&
    view.getUint32(4, true) === value.byteLength - 8 &&
    view.getUint32(16, true) === 16 &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 16_000 &&
    view.getUint32(28, true) === 32_000 &&
    view.getUint16(32, true) === 2 &&
    view.getUint16(34, true) === 16 &&
    view.getUint32(40, true) === value.byteLength - 44
  )
}

export function hasAudiblePcm16Samples(audio: Uint8Array): boolean {
  if (!isPcmWav(audio)) return false

  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  let peak = 0
  for (let offset = 44; offset + 1 < audio.byteLength; offset += 2) {
    peak = Math.max(peak, Math.abs(view.getInt16(offset, true)))
    if (peak >= 80) return true
  }

  return false
}

export function normalizeWhisperOutput(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[\d:.]+\s+-->\s+[\d:.]+\]\s*/, '').trim())
    .filter((line) => line.length > 0 && !/^\[(?:blank_audio|silence|no speech)\]$/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
