'use strict'

const MAX_SENTENCE_COUNT = 50
const MAX_SENTENCE_LENGTH = 240
const MAX_AUDIO_SAMPLES = 720_000

let tts
let activeRequestId
let synthesisQueue = Promise.resolve()

function send(message) {
  if (!process.connected || typeof process.send !== 'function') return
  process.send(message, undefined, { swallowErrors: true })
}

function isSafeInitializeMessage(input) {
  return (
    input &&
    input.type === 'initialize' &&
    typeof input.modulePath === 'string' &&
    input.modulePath.length > 0 &&
    input.modulePath.length <= 1_000 &&
    input.resources &&
    typeof input.resources.model === 'string' &&
    typeof input.resources.voices === 'string' &&
    typeof input.resources.tokens === 'string' &&
    typeof input.resources.dataDir === 'string' &&
    typeof input.resources.lexicon === 'string' &&
    Number.isInteger(input.numThreads) &&
    input.numThreads >= 1 &&
    input.numThreads <= 16
  )
}

function isSafeSynthesizeMessage(input) {
  return (
    input &&
    input.type === 'synthesize' &&
    typeof input.requestId === 'string' &&
    input.requestId.length > 0 &&
    input.requestId.length <= 100 &&
    Array.isArray(input.sentences) &&
    input.sentences.length > 0 &&
    input.sentences.length <= MAX_SENTENCE_COUNT &&
    input.sentences.every(
      (sentence) =>
        typeof sentence === 'string' &&
        sentence.length > 0 &&
        sentence.length <= MAX_SENTENCE_LENGTH
    ) &&
    Number.isInteger(input.speakerId) &&
    input.speakerId >= 0 &&
    input.speakerId <= 100 &&
    typeof input.speed === 'number' &&
    Number.isFinite(input.speed) &&
    input.speed >= 0.5 &&
    input.speed <= 2
  )
}

async function initialize(input) {
  if (!isSafeInitializeMessage(input)) {
    send({
      type: 'error',
      requestId: 'initialization',
      code: 'KOKORO_INVALID_INITIALIZATION',
      message: 'The local Kokoro process received invalid initialization data.'
    })
    return
  }

  try {
    const { OfflineTts } = require(input.modulePath)
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
    send({ type: 'ready', sampleRate: tts.sampleRate, numSpeakers: tts.numSpeakers })
  } catch {
    send({
      type: 'error',
      requestId: 'initialization',
      code: 'KOKORO_INITIALIZATION_FAILED',
      message: 'The local Kokoro voice could not be initialized.'
    })
  }
}

async function synthesize(input) {
  if (!isSafeSynthesizeMessage(input)) {
    send({
      type: 'error',
      requestId: typeof input?.requestId === 'string' ? input.requestId : 'invalid',
      code: 'KOKORO_INVALID_REQUEST',
      message: 'The local Kokoro process received an invalid speech request.'
    })
    return
  }
  if (!tts) {
    send({
      type: 'error',
      requestId: input.requestId,
      code: 'KOKORO_NOT_READY',
      message: 'The local Kokoro voice is not ready.'
    })
    return
  }

  send({ type: 'started', requestId: input.requestId, engine: 'kokoro' })
  try {
    for (let index = 0; index < input.sentences.length; index += 1) {
      if (activeRequestId !== input.requestId) return
      const text = input.sentences[index]
      const audio = await tts.generateAsync({
        text,
        sid: input.speakerId,
        speed: input.speed,
        onProgress: () => activeRequestId === input.requestId
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

      // Copy native external memory into a normal V8-owned array before IPC serialization.
      const samples = new Float32Array(audio.samples.length)
      samples.set(audio.samples)
      send({
        type: 'audio',
        requestId: input.requestId,
        chunkIndex: index,
        sampleRate: audio.sampleRate,
        samples,
        final: index === input.sentences.length - 1
      })
    }
  } catch {
    if (activeRequestId === input.requestId) {
      send({
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

process.on('message', (input) => {
  if (!input || typeof input !== 'object' || typeof input.type !== 'string') return
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
        send({ type: 'cancelled', requestId: input.requestId })
      }
      break
    case 'shutdown':
      activeRequestId = undefined
      process.disconnect()
      break
  }
})

process.on('disconnect', () => {
  activeRequestId = undefined
  process.exit(0)
})
