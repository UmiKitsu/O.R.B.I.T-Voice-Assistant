#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- This is a directly executable Node.js setup script, not TypeScript. */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin'
const MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
const MODEL_SIZE = 147_951_465
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const modelDirectory = join(projectRoot, 'resources', 'whisper')
const modelPath = join(modelDirectory, 'ggml-base.bin')
const temporaryPath = `${modelPath}.download`

async function calculateSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function modelIsValid() {
  try {
    const modelStat = await stat(modelPath)
    return modelStat.size === MODEL_SIZE && (await calculateSha256(modelPath)) === MODEL_SHA256
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

async function downloadModel() {
  await mkdir(modelDirectory, { recursive: true })
  await rm(temporaryPath, { force: true })

  console.log('Downloading the official Whisper base model (148 MB)...')

  try {
    // The URL and checksum are fixed so this setup tool cannot download arbitrary content.
    const response = await fetch(MODEL_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    })

    if (!response.ok || !response.body) {
      throw new Error(`Whisper model download failed with HTTP ${response.status}.`)
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
    if (downloadedStat.size !== MODEL_SIZE || downloadedHash !== MODEL_SHA256) {
      throw new Error('The downloaded Whisper model failed checksum verification.')
    }

    await rm(modelPath, { force: true })
    await rename(temporaryPath, modelPath)
    console.log('Whisper base model downloaded and verified.')
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

try {
  if (await modelIsValid()) {
    console.log('Whisper base model is already present and verified.')
  } else {
    await downloadModel()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Whisper model setup failed.')
  process.exitCode = 1
}
