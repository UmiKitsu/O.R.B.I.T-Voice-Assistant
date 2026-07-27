import { parentPort } from 'node:worker_threads'
import { KeywordSpotter } from 'sherpa-onnx-node'
import {
  WAKE_AUDIO_SAMPLE_RATE,
  WakeAudioMetricsAccumulator,
  WakeWordCandidateSegmenter,
  type WakeSpeechCandidate
} from './wakeWordCandidateSegmenter'
import type { WakeWordWorkerInput, WakeWordWorkerOutput } from './wakeWordProtocol'

const SAMPLE_RATE = WAKE_AUDIO_SAMPLE_RATE
const PRE_ROLL_SAMPLES = Math.round(SAMPLE_RATE * 1.6)
const SILENCE_SAMPLES = Math.round(SAMPLE_RATE * 0.9)
const MAX_COMMAND_SAMPLES = SAMPLE_RATE * 12
const MAX_PENDING_FALLBACK_SAMPLES = SAMPLE_RATE * 8
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

type WorkerMode = 'starting' | 'armed' | 'capturing' | 'fallback-pending' | 'paused'

let spotter: KeywordSpotterInstance | undefined
let stream: KeywordStream | undefined
let mode: WorkerMode = 'starting'
let recognitionMode: 'hybrid' | 'keyword-only' = 'hybrid'
let ring: Float32Array[] = []
let ringSampleCount = 0
let captured: Float32Array[] = []
let samplesAfterDetection = 0
let lastSpeechSample = 0
let noiseFloor = 0.003
let cooldownUntil = 0
let candidateSequence = 0
let activeCandidateId: number | undefined
let pendingAfterCandidate: Float32Array[] = []
let pendingAfterCandidateSamples = 0
let testStartedAt: number | undefined
let testWindowEnded = false

const candidateSegmenter = new WakeWordCandidateSegmenter()
const testMetrics = new WakeAudioMetricsAccumulator()

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

function appendPendingAfterCandidate(samples: Float32Array): void {
  if (pendingAfterCandidateSamples >= MAX_PENDING_FALLBACK_SAMPLES) return
  const remaining = MAX_PENDING_FALLBACK_SAMPLES - pendingAfterCandidateSamples
  const accepted = samples.length <= remaining ? samples : samples.subarray(0, remaining)
  pendingAfterCandidate.push(accepted)
  pendingAfterCandidateSamples += accepted.length
}

function concatenate(parts: readonly Float32Array[]): Float32Array {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const result = new Float32Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function clearAudioBuffers(): void {
  ring = []
  ringSampleCount = 0
  captured = []
  samplesAfterDetection = 0
  lastSpeechSample = 0
  pendingAfterCandidate = []
  pendingAfterCandidateSamples = 0
  activeCandidateId = undefined
  candidateSegmenter.reset()
}

function resetDetector(): void {
  if (spotter && stream) spotter.reset(stream)
  clearAudioBuffers()
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
  const speechThreshold = Math.max(0.006, noiseFloor * 2.5)
  if (level >= speechThreshold) lastSpeechSample = samplesAfterDetection

  const silentSamples = samplesAfterDetection - lastSpeechSample
  if (
    samplesAfterDetection >= MAX_COMMAND_SAMPLES ||
    (samplesAfterDetection >= SILENCE_SAMPLES && silentSamples >= SILENCE_SAMPLES)
  ) {
    finishCapture()
  }
}

function beginCaptureFromPendingAudio(): void {
  const pending = pendingAfterCandidate
  pendingAfterCandidate = []
  pendingAfterCandidateSamples = 0
  activeCandidateId = undefined
  captured = pending
  samplesAfterDetection = pending.reduce((total, part) => total + part.length, 0)
  lastSpeechSample = 0
  let inspectedSamples = 0
  const speechThreshold = Math.max(0.006, noiseFloor * 2.5)
  for (const part of pending) {
    inspectedSamples += part.length
    if (rms(part) >= speechThreshold) lastSpeechSample = inspectedSamples
  }
  if (spotter && stream) spotter.reset(stream)
  candidateSegmenter.reset()
  ring = []
  ringSampleCount = 0
  mode = 'capturing'
  post({ type: 'state', state: 'detected' })
  post({ type: 'state', state: 'capturing' })

  const silentSamples = samplesAfterDetection - lastSpeechSample
  if (
    samplesAfterDetection >= MAX_COMMAND_SAMPLES ||
    (samplesAfterDetection >= SILENCE_SAMPLES && silentSamples >= SILENCE_SAMPLES)
  ) {
    finishCapture()
  }
}

function startFallback(candidate: WakeSpeechCandidate): void {
  candidateSequence += 1
  activeCandidateId = candidateSequence
  pendingAfterCandidate = []
  pendingAfterCandidateSamples = 0
  mode = 'fallback-pending'
  const isTest = testStartedAt !== undefined
  const samples = candidate.samples
  post(
    {
      type: 'wake-candidate',
      candidateId: candidateSequence,
      samples,
      metrics: isTest ? testMetrics.snapshot() : candidate.metrics,
      test: isTest,
      latencyMs: isTest ? Math.max(0, Date.now() - (testStartedAt ?? Date.now())) : undefined
    },
    [samples.buffer as ArrayBuffer]
  )
}

function keywordDetected(): boolean {
  if (!spotter || !stream) return false
  while (spotter.isReady(stream)) {
    spotter.decode(stream)
    if (spotter.getResult(stream).keyword.trim().length === 0) continue

    if (testStartedAt !== undefined) {
      const latencyMs = Math.max(0, Date.now() - testStartedAt)
      const metrics = testMetrics.snapshot()
      testStartedAt = undefined
      testWindowEnded = false
      testMetrics.reset()
      mode = 'paused'
      resetDetector()
      post({ type: 'test-detected', latencyMs, metrics })
      return true
    }

    captured = [...ring]
    samplesAfterDetection = 0
    lastSpeechSample = 0
    mode = 'capturing'
    spotter.reset(stream)
    candidateSegmenter.reset()
    post({ type: 'state', state: 'detected' })
    post({ type: 'state', state: 'capturing' })
    return true
  }
  return false
}

function processArmedAudio(samples: Float32Array): void {
  const level = rms(samples)
  noiseFloor = Math.max(0.001, Math.min(0.02, noiseFloor * 0.98 + Math.min(level, 0.02) * 0.02))
  appendRing(samples)

  if (!spotter || !stream || Date.now() < cooldownUntil) return
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
  if (keywordDetected()) return

  if (recognitionMode === 'keyword-only' && testStartedAt === undefined) return
  const candidate = candidateSegmenter.push(samples)
  if (candidate) startFallback(candidate)
}

function processFallbackResult(
  input: Extract<WakeWordWorkerInput, { type: 'fallback-result' }>
): void {
  if (input.candidateId !== activeCandidateId) return
  const isTest = testStartedAt !== undefined

  if (!input.detected) {
    activeCandidateId = undefined
    pendingAfterCandidate = []
    pendingAfterCandidateSamples = 0
    candidateSegmenter.reset()
    if (spotter && stream) spotter.reset(stream)
    mode = testWindowEnded ? 'paused' : 'armed'
    return
  }

  if (isTest) {
    activeCandidateId = undefined
    pendingAfterCandidate = []
    pendingAfterCandidateSamples = 0
    mode = 'paused'
    return
  }

  if (input.hasCommand) {
    mode = 'paused'
    cooldownUntil = Date.now() + COOLDOWN_MS
    resetDetector()
    return
  }

  beginCaptureFromPendingAudio()
}

function endTestWindow(): void {
  if (testStartedAt === undefined || testWindowEnded) return
  testWindowEnded = true
  if (mode === 'armed') {
    const candidate = candidateSegmenter.flush()
    if (candidate) startFallback(candidate)
    else mode = 'paused'
  }
  post({ type: 'test-window-ended', metrics: testMetrics.snapshot() })
}

function initialize(input: Extract<WakeWordWorkerInput, { type: 'initialize' }>): void {
  try {
    recognitionMode = input.recognitionMode
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
      if (testStartedAt !== undefined && !testWindowEnded) testMetrics.add(input.samples)
      if (mode === 'armed') processArmedAudio(input.samples)
      else if (mode === 'capturing') processCapturingAudio(input.samples)
      else if (mode === 'fallback-pending' && !testWindowEnded) {
        appendPendingAfterCandidate(input.samples)
      }
      break
    case 'pause':
      testStartedAt = undefined
      testWindowEnded = false
      testMetrics.reset()
      resetDetector()
      mode = 'paused'
      post({ type: 'state', state: 'paused' })
      break
    case 'resume':
      if (!spotter || !stream) break
      testStartedAt = undefined
      testWindowEnded = false
      testMetrics.reset()
      resetDetector()
      mode = 'armed'
      post({ type: 'state', state: 'armed' })
      break
    case 'test-start':
      if (!spotter || !stream) break
      resetDetector()
      testMetrics.reset()
      testStartedAt = Date.now()
      testWindowEnded = false
      mode = 'armed'
      break
    case 'test-window-end':
      endTestWindow()
      break
    case 'test-cancel':
      testStartedAt = undefined
      testWindowEnded = false
      testMetrics.reset()
      if (!spotter || !stream) break
      resetDetector()
      mode = 'armed'
      break
    case 'fallback-result':
      processFallbackResult(input)
      break
    case 'shutdown':
      parentPort?.close()
      break
  }
})
