#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Directly executable setup script. */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const MODELS = [
  {
    filename: 'ggml-small.bin',
    label: 'Whisper Small multilingual wake fallback',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    size: 487_601_967
  },
  {
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'Whisper Large-v3 Turbo Q5 multilingual command model',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    size: 574_041_195
  }
]
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const modelDirectory = join(projectRoot, 'resources', 'whisper')

async function calculateSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function modelIsValid(model, modelPath) {
  try {
    const modelStat = await stat(modelPath)
    return modelStat.size === model.size && (await calculateSha256(modelPath)) === model.sha256
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function downloadModel(model) {
  const modelPath = join(modelDirectory, model.filename)
  const temporaryPath = `${modelPath}.download`
  await mkdir(modelDirectory, { recursive: true })
  await rm(temporaryPath, { force: true })

  console.log(`Downloading ${model.label} (${Math.round(model.size / 1_000_000)} MB)...`)
  try {
    const response = await fetch(model.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })
    if (!response.ok || !response.body) {
      throw new Error(`${model.label} download failed with HTTP ${response.status}.`)
    }

    const hash = createHash('sha256')
    const hashingStream = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body),
      hashingStream,
      createWriteStream(temporaryPath, { flags: 'wx' })
    )

    const downloadedStat = await stat(temporaryPath)
    const downloadedHash = hash.digest('hex')
    if (downloadedStat.size !== model.size || downloadedHash !== model.sha256) {
      throw new Error(`${model.label} failed checksum verification.`)
    }

    await rm(modelPath, { force: true })
    await rename(temporaryPath, modelPath)
    console.log(`${model.label} downloaded and verified.`)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

try {
  for (const model of MODELS) {
    const modelPath = join(modelDirectory, model.filename)
    if (await modelIsValid(model, modelPath)) {
      console.log(`${model.label} is already present and verified.`)
    } else {
      await downloadModel(model)
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Whisper model setup failed.')
  process.exitCode = 1
}
