function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel)
    for (let index = 0; index < samples.length; index += 1) {
      mono[index] += samples[index] / buffer.numberOfChannels
    }
  }
  return mono
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return input

  const ratio = sourceRate / targetRate
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, input.length - 1)
    const weight = position - lower
    output[index] = input[lower] * (1 - weight) + input[upper] * weight
  }
  return output
}

function encodePcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const wav = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(wav)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, wav.byteLength - 8, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return new Uint8Array(wav)
}

export async function recordingBlobToWav(blob: Blob): Promise<Uint8Array> {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const mono = mixToMono(decoded)
    return encodePcm16Wav(resampleLinear(mono, decoded.sampleRate, 16_000), 16_000)
  } finally {
    await context.close()
  }
}
