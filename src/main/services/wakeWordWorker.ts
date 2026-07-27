import { parentPort } from 'node:worker_threads'
import { KeywordSpotter } from 'sherpa-onnx-node'
import type { WakeWordWorkerInput, WakeWordWorkerOutput } from './wakeWordProtocol'

const SAMPLE_RATE = 16_000
const PRE_ROLL_SAMPLES = Math.round(SAMPLE_RATE * 1.6)
const SILENCE_SAMPLES = Math.round(SAMPLE_RATE * 0.9)
const MAX_COMMAND_SAMPLES = SAMPLE_RATE * 12
const COOLDOWN_MS = 2_500
const MAX_RING_CHUNKS = 32

type KeywordStream = {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

type KeywordSpotterInstance = {
  createStream(): KeywordStream
  isReady(stream: KeywordStream): boolean
  decode(stream: KeywordStream): void
  reset(stream: KeywordStream): void
  getResult(stream: KeywordStream): { keyword: string }
}

type WorkerMode = 'starting' | 'armed' | 'capturing' | 'paused'

let spotter: KeywordSpotterInstance | undefined
let stream: KeywordStream | undefined
let mode: WorkerMode = 'starting'
let ring: Float32Array[] = []
let ringSampleCount = 0
let captured: Float32Array[] = []
let samplesAfterDetection = 0
let lastSpeechSample = 0
let noiseFloor = 0.003
let cooldownUntil = 0
let testStartedAt: number | undefined

function post(message: WakeWordWorkerOutput, transfer?: ArrayBuffer[]): void {
  parentPort?.postMessage(message, transfer ?? [])
}

function rms(samples: Float32Array): number {
  let energy = 0
  for (const sample of samples) energy += sample * sample
  return samples.length === 0 ? 0 : Math.sqrt(energy / samples.length)
}

function appendRing(samples: Float32Array): void {
  ring.push(samples)
  ringSampleCount += samples.length
  while (ring.length > MAX_RING_CHUNKS || ringSampleCount > PRE_ROLL_SAMPLES) {
    const removed = ring.shift()
    if (!removed) break
    ringSampleCount -= removed.length
  }
}

function concatenate(parts: Float32Array[]): Float32Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const result = new Float32Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function resetDetector(): void {
  if (spotter && stream) spotter.reset(stream)
  ring = []
  ringSampleCount = 0
  captured = []
  samplesAfterDetection = 0
  lastSpeechSample = 0
}

function finishCapture(): void {
  const command = concatenate(captured)
  captured = []
  samplesAfterDetection = 0
  mode = 'paused'
  cooldownUntil = Date.now() + COOLDOWN_MS
  post({ type: 'state', state: 'paused' })
  post({ type: 'command', samples: command }, [command.buffer as ArrayBuffer])
}

function processCapturingAudio(samples: Float32Array): void {
  captured.push(samples)
  samplesAfterDetection += samples.length

  const level = rms(samples)
  const speechThreshold = Math.max(0.012, noiseFloor * 3.5)
  if (level >= speechThreshold) lastSpeechSample = samplesAfterDetection

  const silentSamples = samplesAfterDetection - lastSpeechSample
  if (
    samplesAfterDetection >= MAX_COMMAND_SAMPLES ||
    (samplesAfterDetection >= SILENCE_SAMPLES && silentSamples >= SILENCE_SAMPLES)
  ) {
    finishCapture()
  }
}

function processArmedAudio(samples: Float32Array): void {
  const level = rms(samples)
  noiseFloor = Math.max(0.001, Math.min(0.02, noiseFloor * 0.98 + Math.min(level, 0.02) * 0.02))
  appendRing(samples)

  if (!spotter || !stream || Date.now() < cooldownUntil) return
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  while (spotter.isReady(stream)) {
    spotter.decode(stream)
    if (spotter.getResult(stream).keyword.trim().length > 0) {
      if (testStartedAt !== undefined) {
        const latencyMs = Math.max(0, Date.now() - testStartedAt)
        testStartedAt = undefined
        mode = 'paused'
        resetDetector()
        post({ type: 'test-detected', latencyMs })
        return
      }
      captured = [...ring]
      samplesAfterDetection = 0
      lastSpeechSample = 0
      mode = 'capturing'
      spotter.reset(stream)
      post({ type: 'state', state: 'detected' })
      post({ type: 'state', state: 'capturing' })
      return
    }
  }
}

function initialize(input: Extract<WakeWordWorkerInput, { type: 'initialize' }>): void {
  try {
    spotter = new KeywordSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: input.resources.encoder,
          decoder: input.resources.decoder,
          joiner: input.resources.joiner
        },
        tokens: input.resources.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0
      },
      maxActivePaths: 4,
      numTrailingBlanks: 1,
      keywordsScore: 1.5,
      keywordsThreshold: 0.3,
      keywordsFile: input.resources.keywords
    }) as KeywordSpotterInstance
    stream = spotter.createStream()
    mode = 'armed'
    post({ type: 'ready' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown native runtime error.'
    post({ type: 'error', message: detail })
  }
}

parentPort?.on('message', (input: WakeWordWorkerInput) => {
  switch (input.type) {
    case 'initialize':
      initialize(input)
      break
    case 'audio':
      if (mode === 'armed') processArmedAudio(input.samples)
      else if (mode === 'capturing') processCapturingAudio(input.samples)
      break
    case 'pause':
      testStartedAt = undefined
      resetDetector()
      mode = 'paused'
      post({ type: 'state', state: 'paused' })
      break
    case 'resume':
      if (!spotter || !stream) break
      testStartedAt = undefined
      resetDetector()
      mode = 'armed'
      post({ type: 'state', state: 'armed' })
      break
    case 'test-start':
      if (!spotter || !stream) break
      resetDetector()
      testStartedAt = Date.now()
      mode = 'armed'
      break
    case 'test-cancel':
      testStartedAt = undefined
      if (!spotter || !stream) break
      resetDetector()
      mode = 'armed'
      break
    case 'shutdown':
      parentPort?.close()
      break
  }
})
