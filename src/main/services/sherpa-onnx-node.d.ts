declare module 'sherpa-onnx-node' {
  export class KeywordSpotter {
    constructor(config: unknown)
  }

  export type GeneratedAudio = {
    samples: Float32Array
    sampleRate: number
  }

  export type OfflineTtsRequest = {
    text: string
    sid: number
    speed: number
    onProgress?: (info: { samples: Float32Array; progress: number }) => boolean | number | void
  }

  export class OfflineTts {
    constructor(config: unknown)
    static createAsync(config: unknown): Promise<OfflineTts>
    readonly numSpeakers: number
    readonly sampleRate: number
    generate(request: Omit<OfflineTtsRequest, 'onProgress'>): GeneratedAudio
    generateAsync(request: OfflineTtsRequest): Promise<GeneratedAudio>
  }
}
