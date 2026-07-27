#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Directly executable Node.js verification script. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const modelDirectory = join(projectRoot, 'resources', 'wake-word')
const expectedFiles = Object.freeze({
  'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx': {
    size: 4_599_656,
    sha256: '408bbd740838c42d5bf6d1c5b80b3c88b616c7860b92d980328b5b068c76ae48'
  },
  'decoder-epoch-13-avg-2-chunk-16-left-64.onnx': {
    size: 759_829,
    sha256: '63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21'
  },
  'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx': {
    size: 86_629,
    sha256: '190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1'
  },
  'tokens.txt': {
    size: 1_928,
    sha256: '2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0'
  },
  'keywords.txt': {
    size: 33,
    sha256: '9be421abdaabcc540e414fa8504d329468e1bd117e9ff3796898f91c0cdb8919'
  }
})

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

try {
  for (const [filename, expected] of Object.entries(expectedFiles)) {
    const path = join(modelDirectory, filename)
    const fileStat = await stat(path)
    if (fileStat.size !== expected.size || (await sha256(path)) !== expected.sha256) {
      throw new Error(`${filename} failed wake-word resource verification.`)
    }
  }
  console.log('Orbit wake-word model resources are present and checksum verified.')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Wake-word resource verification failed.')
  process.exitCode = 1
}
