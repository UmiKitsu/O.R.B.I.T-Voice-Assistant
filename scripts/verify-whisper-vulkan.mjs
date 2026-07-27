#!/usr/bin/env node

/* eslint-disable @typescript-eslint/explicit-function-return-type -- Directly executable verifier. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_RUNTIME = [
  ['ggml.dll', 67_072, '4fd032f84c307ac297ffb6411665fe349edca25935678293a20b3bd6007b5ad6'],
  ['ggml-base.dll', 640_000, 'dc5896a560e54a3f70f106444a04b6decab1d5cc57e44c75e4df641130ead42e'],
  ['ggml-cpu.dll', 829_440, '97e6ae1f87e40866dbf6334ec6bb856b7fcf50bcef8630def4fef7279f131396'],
  [
    'ggml-vulkan.dll',
    73_818_112,
    '8f63559fb069f7d6650b469a1ba267a5cb279576c5630e25f8b54f84e7d50883'
  ],
  ['whisper.dll', 485_376, '74b8c5a082d9e914ab0ef0ac2f0e08514ec8334f7e4c2f3a98b1b58b57f671d9'],
  ['whisper-cli.exe', 489_984, '41d4c9bf03687a4d53ed3a71dcc2b77d82500114347a900fe9bc440f04ddc634']
]

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const runtimeDirectory = join(projectRoot, 'resources', 'whisper', 'vulkan')

async function calculateSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function verifyRuntimeFile([filename, expectedSize, expectedHash]) {
  const path = join(runtimeDirectory, filename)
  const fileStat = await stat(path)
  if (fileStat.size !== expectedSize) {
    throw new Error(`${filename} has an unexpected size.`)
  }
  if ((await calculateSha256(path)) !== expectedHash) {
    throw new Error(`${filename} failed checksum verification.`)
  }
}

try {
  for (const entry of PINNED_RUNTIME) await verifyRuntimeFile(entry)
  console.log('Pinned whisper.cpp v1.9.1 Vulkan runtime is present and verified.')
} catch (error) {
  console.error(
    error instanceof Error
      ? `Whisper Vulkan verification failed: ${error.message}`
      : 'Whisper Vulkan verification failed.'
  )
  process.exitCode = 1
}
