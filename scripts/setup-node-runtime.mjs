#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Directly executable setup script. */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'

const NODE_RUNTIME = Object.freeze({
  version: 'v22.16.0',
  url: 'https://nodejs.org/dist/v22.16.0/win-x64/node.exe',
  size: 85_119_640,
  sha256: 'c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19'
})
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const runtimePath = join(projectRoot, 'resources', 'node-runtime', 'node.exe')
const downloadPath = `${runtimePath}.download`

async function calculateSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function runtimeIsValid(path) {
  try {
    const fileStat = await stat(path)
    return fileStat.size === NODE_RUNTIME.size && (await calculateSha256(path)) === NODE_RUNTIME.sha256
  } catch {
    return false
  }
}

async function copyCurrentNodeWhenPinned() {
  if (process.platform !== 'win32' || process.arch !== 'x64') return false
  if (!(await runtimeIsValid(process.execPath))) return false

  await mkdir(dirname(runtimePath), { recursive: true })
  await rm(downloadPath, { force: true })
  await copyFile(process.execPath, downloadPath)
  await rename(downloadPath, runtimePath)
  return true
}

async function downloadPinnedNode() {
  await mkdir(dirname(runtimePath), { recursive: true })
  await rm(downloadPath, { force: true })

  console.log(`Downloading pinned Node.js ${NODE_RUNTIME.version} runtime for local Kokoro...`)
  const response = await fetch(NODE_RUNTIME.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!response.ok || !response.body) {
    throw new Error(`Node runtime download failed with HTTP ${response.status}.`)
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
    createWriteStream(downloadPath, { flags: 'wx' })
  )

  const fileStat = await stat(downloadPath)
  if (fileStat.size !== NODE_RUNTIME.size || hash.digest('hex') !== NODE_RUNTIME.sha256) {
    throw new Error('The downloaded Node runtime failed checksum verification.')
  }
  await rename(downloadPath, runtimePath)
}

try {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The bundled Kokoro Node runtime currently supports Windows x64 only.')
  }

  if (await runtimeIsValid(runtimePath)) {
    console.log(`Pinned Node.js ${NODE_RUNTIME.version} Kokoro runtime is already present and verified.`)
  } else if (await copyCurrentNodeWhenPinned()) {
    console.log(`Copied and verified the installed Node.js ${NODE_RUNTIME.version} runtime for Kokoro.`)
  } else {
    await downloadPinnedNode()
    console.log(`Downloaded and verified Node.js ${NODE_RUNTIME.version} runtime for Kokoro.`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Node runtime setup failed.')
  process.exitCode = 1
} finally {
  await rm(downloadPath, { force: true }).catch(() => undefined)
}
