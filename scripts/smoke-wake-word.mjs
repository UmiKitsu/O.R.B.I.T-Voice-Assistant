/* eslint-disable @typescript-eslint/explicit-function-return-type -- executable ESM smoke script */
import { join } from 'node:path'
import sherpaOnnx from 'sherpa-onnx-node'

const { KeywordSpotter, readWave } = sherpaOnnx

const root = process.cwd()
const resourceRoot = join(root, 'resources', 'wake-word')
const fixtureRoot = join(root, 'test', 'fixtures', 'wake-word')

const config = {
  featConfig: { sampleRate: 16_000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: join(resourceRoot, 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
      decoder: join(resourceRoot, 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
      joiner: join(resourceRoot, 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx')
    },
    tokens: join(resourceRoot, 'tokens.txt'),
    numThreads: 1,
    provider: 'cpu',
    debug: 0
  },
  maxActivePaths: 4,
  numTrailingBlanks: 1,
  keywordsScore: 1.5,
  keywordsThreshold: 0.3,
  keywordsFile: join(resourceRoot, 'keywords.txt')
}

function detectFixture(filename) {
  const spotter = new KeywordSpotter(config)
  const stream = spotter.createStream()
  const wave = readWave(join(fixtureRoot, filename))
  const detections = []

  const feed = (samples) => {
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples })
    while (spotter.isReady(stream)) {
      spotter.decode(stream)
      const keyword = spotter.getResult(stream).keyword.trim()
      if (keyword && detections.at(-1) !== keyword) detections.push(keyword)
    }
  }

  for (let offset = 0; offset < wave.samples.length; offset += 1_600) {
    feed(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + 1_600)))
  }
  feed(new Float32Array(16_000))
  return detections
}

const fixtures = ['orbit-standard.wav', 'orbit-or-bit.wav']
let failed = false
for (const fixture of fixtures) {
  const detections = detectFixture(fixture)
  const detected = detections.some((keyword) => keyword === 'ORBIT' || keyword === 'OR_BIT')
  console.log(`${fixture}: ${detected ? detections.join(', ') : 'not detected'}`)
  if (!detected) failed = true
}

if (failed) process.exitCode = 1
