import { parentPort } from 'node:worker_threads'
import { OfflineTts } from 'sherpa-onnx-node'
import type {
  SpeechSynthesisWorkerInput,
  SpeechSynthesisWorkerOutput
} from './speechSynthesisProtocol'

const MAX_AUDIO_SAMPLES = 720_000

let tts: OfflineTts | undefined
let activeRequestId: string | undefined
let synthesisQueue = Promise.resolve()

function post(message: SpeechSynthesisWorkerOutput, transfer?: ArrayBuffer[]): void {
  parentPort?.postMessage(message, transfer ?? [])
}

async function initialize(
  input: Extract<SpeechSynthesisWorkerInput, { type: 'initialize' }>
): Promise<void> {
  try {
    tts = await OfflineTts.createAsync({
      model: {
        kokoro: {
          model: input.resources.model,
          voices: input.resources.voices,
          tokens: input.resources.tokens,
          dataDir: input.resources.dataDir,
          lexicon: input.resources.lexicon
        },
        debug: false,
        numThreads: input.numThreads,
        provider: 'cpu'
      },
      maxNumSentences: 1
    })
    post({ type: 'ready', sampleRate: tts.sampleRate, numSpeakers: tts.numSpeakers })
  } catch {
    post({
      type: 'error',
      requestId: 'initialization',
      code: 'KOKORO_INITIALIZATION_FAILED',
      message: 'The local Kokoro voice could not be initialized.'
    })
  }
}

async function synthesize(
  input: Extract<SpeechSynthesisWorkerInput, { type: 'synthesize' }>
): Promise<void> {
  if (!tts) {
    post({
      type: 'error',
      requestId: input.requestId,
      code: 'KOKORO_NOT_READY',
      message: 'The local Kokoro voice is not ready.'
    })
    return
  }

  post({ type: 'started', requestId: input.requestId, engine: 'kokoro' })
  try {
    for (let index = 0; index < input.sentences.length; index += 1) {
      if (activeRequestId !== input.requestId) return
      const text = input.sentences[index]
      if (!text) continue
      // The sherpa async generator returns a native external buffer that Electron workers reject
      // with "External buffers are not allowed". Synchronous generation is safe here because this
      // code already runs in a dedicated worker and therefore never blocks the Electron UI.
      const audio = tts.generate({
        text,
        sid: input.speakerId,
        speed: input.speed
      })
      if (activeRequestId !== input.requestId) return
      if (
        !(audio.samples instanceof Float32Array) ||
        audio.samples.length === 0 ||
        audio.samples.length > MAX_AUDIO_SAMPLES ||
        !Number.isInteger(audio.sampleRate) ||
        audio.sampleRate < 8_000 ||
        audio.sampleRate > 48_000
      ) {
        throw new Error('Kokoro returned invalid audio.')
      }

      const samples = Float32Array.from(audio.samples, (sample) => {
        if (!Number.isFinite(sample)) return 0
        return Math.max(-1, Math.min(1, sample))
      })
      post(
        {
          type: 'audio',
          requestId: input.requestId,
          chunkIndex: index,
          sampleRate: audio.sampleRate,
          samples,
          final: index === input.sentences.length - 1
        },
        [samples.buffer]
      )
    }
  } catch {
    if (activeRequestId === input.requestId) {
      post({
        type: 'error',
        requestId: input.requestId,
        code: 'KOKORO_SYNTHESIS_FAILED',
        message: 'The local Kokoro voice could not synthesize this response.'
      })
    }
  } finally {
    if (activeRequestId === input.requestId) activeRequestId = undefined
  }
}

parentPort?.on('message', (input: SpeechSynthesisWorkerInput) => {
  switch (input.type) {
    case 'initialize':
      synthesisQueue = synthesisQueue.then(() => initialize(input))
      break
    case 'synthesize':
      activeRequestId = input.requestId
      synthesisQueue = synthesisQueue.then(() => synthesize(input))
      break
    case 'cancel':
      if (activeRequestId === input.requestId) {
        activeRequestId = undefined
        post({ type: 'cancelled', requestId: input.requestId })
      }
      break
    case 'shutdown':
      activeRequestId = undefined
      parentPort?.close()
      break
  }
})
