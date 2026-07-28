export class MicrophonePipelineTimeoutError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'MicrophonePipelineTimeoutError'
    this.code = code
  }
}

export function isValidAudioChunk(value: unknown): value is Float32Array {
  if (!(value instanceof Float32Array) || value.length === 0) return false
  for (const sample of value) {
    if (!Number.isFinite(sample)) return false
  }
  return true
}

export function calculateInputLevel(samples: Float32Array): number {
  let energy = 0
  for (const sample of samples) energy += sample * sample
  const rms = Math.sqrt(energy / samples.length)
  return Math.min(1, rms * 12)
}

export async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  code: string,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new MicrophonePipelineTimeoutError(code, message)),
          timeoutMs
        )
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
