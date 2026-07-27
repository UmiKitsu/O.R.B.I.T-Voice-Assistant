#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Directly executable setup script. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const ARCHIVE = Object.freeze({
  filename: 'kokoro-multi-lang-v1_0.tar.bz2',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2',
  size: 349_418_188,
  sha256: 'c133d26353d776da730870dac7da07dbfc9a5e3bc80cc5e8e83ab6e823be7046'
})
const EXPECTED_FILES = Object.freeze({
  'model.onnx': {
    size: 325_630_829,
    sha256: 'c436dc6a842b62aba06af67e40bafcfb9c60ac3af895358f1974ad9a7f7c026b'
  },
  'voices.bin': {
    size: 27_678_720,
    sha256: '8a77c0d397026208d22211f37670b5b3b11e03f190756b25a1d24041fced82a9'
  },
  'tokens.txt': {
    size: 687,
    sha256: '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425'
  },
  'lexicon-us-en.txt': {
    size: 5_956_885,
    sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14'
  },
  'lexicon-zh.txt': {
    size: 2_364_621,
    sha256: '509a1f55bf9c62e3f7e598e7544b114eadef1e00266f2badff4f281153f9f327'
  },
  'espeak-ng-data/en_dict': {
    size: 166_944,
    sha256: '71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35'
  }
})
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000
const execFileAsync = promisify(execFile)

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const resourceRoot = join(projectRoot, 'resources', 'kokoro')
const modelDirectory = join(resourceRoot, 'kokoro-multi-lang-v1_0')
const archivePath = join(resourceRoot, `${ARCHIVE.filename}.download`)
const extractionRoot = join(resourceRoot, '.kokoro-extract')

async function calculateSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function modelIsValid() {
  const entries = Object.entries(EXPECTED_FILES)
  if (entries.length === 0) return false
  try {
    for (const [relativePath, expected] of entries) {
      const path = join(modelDirectory, relativePath)
      const fileStat = await stat(path)
      if (fileStat.size !== expected.size || (await calculateSha256(path)) !== expected.sha256) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

async function downloadArchive() {
  await mkdir(resourceRoot, { recursive: true })
  await rm(archivePath, { force: true })
  console.log('Downloading the official Kokoro multilingual bm_george model (349 MB)...')
  const response = await fetch(ARCHIVE.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!response.ok || !response.body) {
    throw new Error(`Kokoro model download failed with HTTP ${response.status}.`)
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
    createWriteStream(archivePath, { flags: 'wx' })
  )
  const archiveStat = await stat(archivePath)
  if (archiveStat.size !== ARCHIVE.size || hash.digest('hex') !== ARCHIVE.sha256) {
    throw new Error('The Kokoro archive failed checksum verification.')
  }
}

async function extractArchive() {
  await rm(extractionRoot, { recursive: true, force: true })
  await mkdir(extractionRoot, { recursive: true })
  await execFileAsync('tar.exe', ['-xjf', archivePath, '-C', extractionRoot], {
    windowsHide: true,
    timeout: 10 * 60 * 1_000
  })
  const extractedDirectory = join(extractionRoot, 'kokoro-multi-lang-v1_0')
  await readFile(join(extractedDirectory, 'tokens.txt'), 'utf8')
  await stat(join(extractedDirectory, 'model.onnx'))
  await stat(join(extractedDirectory, 'voices.bin'))
  await rm(modelDirectory, { recursive: true, force: true })
  await rename(extractedDirectory, modelDirectory)
}

try {
  if (await modelIsValid()) {
    console.log('Kokoro multilingual bm_george model is already present and verified.')
  } else {
    await downloadArchive()
    await extractArchive()
    console.log('Kokoro multilingual bm_george model downloaded, verified, and extracted.')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Kokoro model setup failed.')
  process.exitCode = 1
} finally {
  await rm(archivePath, { force: true }).catch(() => undefined)
  await rm(extractionRoot, { recursive: true, force: true }).catch(() => undefined)
}
