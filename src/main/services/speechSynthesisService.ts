import { app, type WebContents } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { dirname, join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, KokoroVoice, SpeechSynthesisEvent } from '../../shared/types'
import type {
  SpeechSynthesisWorkerInput,
  SpeechSynthesisWorkerOutput,
  SpeechSynthesisWorkerResources
} from './speechSynthesisProtocol'
import { logOperationalEvent } from './loggerService'
import { getSettings } from './settingsService'

const MAX_SPEECH_TEXT_LENGTH = 4_000
const MAX_SENTENCE_LENGTH = 240
const MAX_SENTENCE_COUNT = 50
const MAX_AUDIO_SAMPLES = 720_000
const PROCESS_START_TIMEOUT_MS = 20_000
const KOKORO_THREADS = Math.max(1, Math.min(4, availableParallelism()))
const KOKORO_RUNTIME_CACHE_VERSION = 'kokoro-multi-lang-v1_0-c436dc6a'
const KOKORO_RUNTIME_CACHE_MARKER = '.orbit-kokoro-cache-version'
const KOKORO_CRITICAL_FILE_SIZES: Readonly<Record<string, number>> = Object.freeze({
  'model.onnx': 325_630_829,
  'voices.bin': 27_678_720,
  'tokens.txt': 687,
  'lexicon-us-en.txt': 5_956_885,
  'lexicon-zh.txt': 2_364_621,
  'espeak-ng-data/en_dict': 166_944
})

export const KOKORO_SPEAKER_IDS: Readonly<Record<KokoroVoice, number>> = Object.freeze({
  bm_george: 26,
  bm_lewis: 27,
  bm_daniel: 24,
  am_adam: 11,
  am_michael: 16,
  bf_emma: 21,
  af_heart: 3
})

type SpeechSession = {
  requestId: string
  sender: WebContents
}

type SpeechProcess = ChildProcess

let speechProcess: SpeechProcess | undefined
let processReady = false
let processStartup: Promise<boolean> | undefined
let runtimeRootPromise: Promise<string> | undefined
let lastProcessFailure:
  | {
      code: string
      message: string
    }
  | undefined
const sessions = new Map<number, SpeechSession>()
const cleanupSenders = new Set<number>()
const expectedProcessExits = new WeakSet<SpeechProcess>()

function resourceRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

function kokoroRoot(): string {
  return join(resourceRoot(), 'kokoro', 'kokoro-multi-lang-v1_0')
}

function nodeRuntimePath(): string {
  return join(resourceRoot(), 'node-runtime', 'node.exe')
}

function childScriptPath(): string {
  return join(resourceRoot(), 'kokoro', 'kokoro-child.cjs')
}

function sherpaModulePath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sherpa-onnx-node')
    : join(app.getAppPath(), 'node_modules', 'sherpa-onnx-node')
}

function isAsciiPath(path: string): boolean {
  return !/[^\x20-\x7e]/.test(path)
}

async function criticalFilesAreValid(root: string): Promise<boolean> {
  try {
    for (const [relativePath, expectedSize] of Object.entries(KOKORO_CRITICAL_FILE_SIZES)) {
      if ((await stat(join(root, relativePath))).size !== expectedSize) return false
    }
    return true
  } catch {
    return false
  }
}

async function runtimeCacheIsReady(root: string): Promise<boolean> {
  try {
    const marker = (await readFile(join(root, KOKORO_RUNTIME_CACHE_MARKER), 'utf8')).trim()
    return marker === KOKORO_RUNTIME_CACHE_VERSION && (await criticalFilesAreValid(root))
  } catch {
    return false
  }
}

async function prepareAsciiRuntimeCache(sourceRoot: string): Promise<string> {
  const cacheBase = [app.getPath('userData'), app.getPath('temp')].find(isAsciiPath)
  if (!cacheBase) {
    throw new Error('Kokoro requires an ASCII-only application cache path on Windows.')
  }
  if (!(await criticalFilesAreValid(sourceRoot))) {
    throw new Error('The bundled Kokoro resources failed runtime validation.')
  }

  const cacheRoot = join(cacheBase, 'kokoro-runtime', KOKORO_RUNTIME_CACHE_VERSION)
  if (await runtimeCacheIsReady(cacheRoot)) return cacheRoot

  const stagingRoot = `${cacheRoot}.staging-${process.pid}-${randomUUID()}`
  await mkdir(dirname(cacheRoot), { recursive: true })
  await rm(stagingRoot, { recursive: true, force: true })
  try {
    await cp(sourceRoot, stagingRoot, { recursive: true, force: true })
    if (!(await criticalFilesAreValid(stagingRoot))) {
      throw new Error('The Kokoro runtime cache failed validation after copying.')
    }
    await writeFile(
      join(stagingRoot, KOKORO_RUNTIME_CACHE_MARKER),
      KOKORO_RUNTIME_CACHE_VERSION,
      'utf8'
    )
    await rm(cacheRoot, { recursive: true, force: true })
    await rename(stagingRoot, cacheRoot)
    return cacheRoot
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function kokoroNativeRoot(): Promise<string> {
  if (runtimeRootPromise) return runtimeRootPromise

  runtimeRootPromise = (async () => {
    const root = kokoroRoot()
    return isAsciiPath(root) ? root : prepareAsciiRuntimeCache(root)
  })()

  try {
    return await runtimeRootPromise
  } catch (error) {
    runtimeRootPromise = undefined
    throw error
  }
}

async function resources(): Promise<SpeechSynthesisWorkerResources> {
  const root = await kokoroNativeRoot()
  return {
    model: join(root, 'model.onnx'),
    voices: join(root, 'voices.bin'),
    tokens: join(root, 'tokens.txt'),
    dataDir: join(root, 'espeak-ng-data'),
    lexicon: `${join(root, 'lexicon-us-en.txt')},${join(root, 'lexicon-zh.txt')}`
  }
}

async function resourcesExist(value: SpeechSynthesisWorkerResources): Promise<boolean> {
  const lexicons = value.lexicon.split(',')
  try {
    await Promise.all([
      access(value.model),
      access(value.voices),
      access(value.tokens),
      access(value.dataDir),
      ...lexicons.map((path) => access(path))
    ])
    return true
  } catch {
    return false
  }
}

async function childRuntimeExists(): Promise<boolean> {
  try {
    await Promise.all([
      access(nodeRuntimePath()),
      access(childScriptPath()),
      access(join(sherpaModulePath(), 'package.json'))
    ])
    return true
  } catch {
    return false
  }
}

function emit(session: SpeechSession, event: SpeechSynthesisEvent): void {
  if (!session.sender.isDestroyed()) session.sender.send(IPC_CHANNELS.speechEvent, event)
}

function sessionForRequest(requestId: string): [number, SpeechSession] | undefined {
  for (const entry of sessions) if (entry[1].requestId === requestId) return entry
  return undefined
}

function parseProcessOutput(value: unknown): SpeechSynthesisWorkerOutput | null {
  if (typeof value !== 'object' || value === null || !('type' in value)) return null
  const message = value as Record<string, unknown>
  if (message.type === 'ready') {
    return Number.isInteger(message.sampleRate) &&
      Number.isInteger(message.numSpeakers) &&
      (message.sampleRate as number) >= 8_000 &&
      (message.sampleRate as number) <= 48_000 &&
      (message.numSpeakers as number) > 0 &&
      (message.numSpeakers as number) <= 1_000
      ? (value as SpeechSynthesisWorkerOutput)
      : null
  }

  if (typeof message.requestId !== 'string' || message.requestId.length > 100) return null
  if (message.type === 'started') {
    return message.engine === 'kokoro' ? (value as SpeechSynthesisWorkerOutput) : null
  }
  if (message.type === 'cancelled') return value as SpeechSynthesisWorkerOutput
  if (message.type === 'error') {
    return typeof message.code === 'string' &&
      message.code.length <= 100 &&
      typeof message.message === 'string' &&
      message.message.length <= 500
      ? (value as SpeechSynthesisWorkerOutput)
      : null
  }
  if (message.type === 'audio') {
    return Number.isInteger(message.chunkIndex) &&
      (message.chunkIndex as number) >= 0 &&
      (message.chunkIndex as number) < MAX_SENTENCE_COUNT &&
      Number.isInteger(message.sampleRate) &&
      (message.sampleRate as number) >= 8_000 &&
      (message.sampleRate as number) <= 48_000 &&
      message.samples instanceof Float32Array &&
      message.samples.length > 0 &&
      message.samples.length <= MAX_AUDIO_SAMPLES &&
      typeof message.final === 'boolean'
      ? (value as SpeechSynthesisWorkerOutput)
      : null
  }
  return null
}

function handleProcessOutput(message: SpeechSynthesisWorkerOutput): void {
  if (message.type === 'ready') return
  if (message.requestId === 'initialization') return
  const entry = sessionForRequest(message.requestId)
  if (!entry) return
  const [senderId, session] = entry
  emit(session, message)
  if (
    message.type === 'error' ||
    message.type === 'cancelled' ||
    (message.type === 'audio' && message.final)
  ) {
    sessions.delete(senderId)
  }
}

function failAllSessions(code: string, message: string): void {
  for (const session of sessions.values()) {
    emit(session, { type: 'error', requestId: session.requestId, code, message })
  }
  sessions.clear()
}

function sendToProcess(input: SpeechSynthesisWorkerInput): boolean {
  const activeProcess = speechProcess
  if (!activeProcess?.connected || typeof activeProcess.send !== 'function') return false
  try {
    activeProcess.send(input)
    return true
  } catch {
    return false
  }
}

function resetProcess(): void {
  const activeProcess = speechProcess
  speechProcess = undefined
  processReady = false
  processStartup = undefined
  if (activeProcess) {
    expectedProcessExits.add(activeProcess)
    try {
      if (activeProcess.connected) activeProcess.disconnect()
    } catch {
      // The child may already be disconnected.
    }
    try {
      activeProcess.kill()
    } catch {
      // The child may already have exited.
    }
  }
}

function recordProcessFailure(
  reason: 'initialization' | 'runtime-error' | 'message-error' | 'unexpected-exit',
  code: string,
  message: string
): void {
  lastProcessFailure = { code, message }
  logOperationalEvent({ event: 'speech.worker-failed', reason })
}

async function ensureProcess(): Promise<boolean> {
  if (speechProcess?.connected && processReady) return true
  if (processStartup) return processStartup

  processStartup = (async () => {
    let modelResources: SpeechSynthesisWorkerResources
    try {
      modelResources = await resources()
    } catch {
      recordProcessFailure(
        'initialization',
        'KOKORO_RUNTIME_CACHE_FAILED',
        'Kokoro could not prepare its local runtime resources.'
      )
      return false
    }
    if (!(await resourcesExist(modelResources))) {
      recordProcessFailure(
        'initialization',
        'KOKORO_RESOURCES_MISSING',
        'Kokoro resources are missing or failed verification.'
      )
      return false
    }
    if (!(await childRuntimeExists())) {
      recordProcessFailure(
        'initialization',
        'KOKORO_NODE_RUNTIME_MISSING',
        'The verified local Kokoro runtime is missing. Run npm run setup:node-runtime.'
      )
      return false
    }

    let nextProcess: SpeechProcess
    try {
      const childEnvironment = { ...process.env }
      delete childEnvironment.ELECTRON_RUN_AS_NODE
      nextProcess = fork(childScriptPath(), [], {
        execPath: nodeRuntimePath(),
        env: childEnvironment,
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'ignore', 'ipc']
      })
    } catch {
      recordProcessFailure(
        'initialization',
        'KOKORO_PROCESS_START_FAILED',
        'The local Kokoro process could not start.'
      )
      return false
    }

    speechProcess = nextProcess
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ready: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        processReady = ready
        if (!ready) resetProcess()
        resolve(ready)
      }
      const timeout = setTimeout(() => {
        recordProcessFailure(
          'initialization',
          'KOKORO_START_TIMEOUT',
          'Kokoro took too long to initialize. Please try again.'
        )
        finish(false)
      }, PROCESS_START_TIMEOUT_MS)

      nextProcess.on('message', (value: unknown) => {
        if (speechProcess !== nextProcess) return
        const message = parseProcessOutput(value)
        if (!message) {
          const code = 'KOKORO_PROCESS_MESSAGE_FAILED'
          const text = 'The local Kokoro process returned invalid audio data.'
          recordProcessFailure('message-error', code, text)
          failAllSessions(code, text)
          if (settled) resetProcess()
          else finish(false)
          return
        }
        if (message.type === 'ready') {
          lastProcessFailure = undefined
          finish(true)
          return
        }
        if (message.type === 'error' && message.requestId === 'initialization') {
          recordProcessFailure('initialization', message.code, message.message)
          finish(false)
          return
        }
        handleProcessOutput(message)
      })
      nextProcess.once('error', () => {
        if (speechProcess !== nextProcess) return
        const code = 'KOKORO_RUNTIME_FAILED'
        const message = 'The local Kokoro voice process stopped unexpectedly.'
        recordProcessFailure('runtime-error', code, message)
        failAllSessions(code, message)
        if (settled) resetProcess()
        else finish(false)
      })
      nextProcess.once('exit', () => {
        const expected = expectedProcessExits.has(nextProcess)
        expectedProcessExits.delete(nextProcess)
        if (speechProcess !== nextProcess) return

        speechProcess = undefined
        processReady = false
        processStartup = undefined
        if (!expected) {
          const code = 'KOKORO_WORKER_EXITED'
          const message = 'The local Kokoro voice process exited and will restart automatically.'
          recordProcessFailure('unexpected-exit', code, message)
          failAllSessions(code, message)
        }
      })

      const initialized = sendToProcess({
        type: 'initialize',
        modulePath: sherpaModulePath(),
        resources: modelResources,
        numThreads: KOKORO_THREADS
      })
      if (!initialized) {
        recordProcessFailure(
          'initialization',
          'KOKORO_PROCESS_MESSAGE_FAILED',
          'The local Kokoro process could not receive initialization data.'
        )
        finish(false)
      }
    })
  })()

  try {
    return await processStartup
  } finally {
    processStartup = undefined
  }
}

function splitLongSentence(sentence: string): string[] {
  const chunks: string[] = []
  let remaining = sentence.trim()
  while (remaining.length > MAX_SENTENCE_LENGTH) {
    const searchFrom = Math.floor(MAX_SENTENCE_LENGTH * 0.55)
    const candidate = remaining.slice(searchFrom, MAX_SENTENCE_LENGTH + 1)
    const relativeBreak = Math.max(candidate.lastIndexOf(','), candidate.lastIndexOf(' '))
    const breakAt = relativeBreak >= 0 ? searchFrom + relativeBreak + 1 : MAX_SENTENCE_LENGTH
    chunks.push(remaining.slice(0, breakAt).trim())
    remaining = remaining.slice(breakAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

export function splitSpeechText(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > MAX_SPEECH_TEXT_LENGTH) return []
  const sentences = normalized.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [normalized]
  return sentences.flatMap(splitLongSentence).filter(Boolean).slice(0, MAX_SENTENCE_COUNT)
}

export function parseSpeechSynthesisRequest(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 1) return null
  if (!('text' in value) || typeof value.text !== 'string') return null
  const text = value.text.trim()
  return text.length > 0 && text.length <= MAX_SPEECH_TEXT_LENGTH ? text : null
}

export async function startSpeechSynthesis(
  sender: WebContents,
  request: unknown
): Promise<ActionResult<{ requestId: string }>> {
  const text = parseSpeechSynthesisRequest(request)
  if (!text) {
    return {
      ok: false,
      code: 'INVALID_SPEECH_TEXT',
      message: 'Speech text must contain between 1 and 4,000 characters.',
      recoverable: true
    }
  }

  const sentences = splitSpeechText(text)
  if (sentences.length === 0) {
    return {
      ok: false,
      code: 'INVALID_SPEECH_TEXT',
      message: 'The response did not contain speakable text.',
      recoverable: true
    }
  }
  if (!(await ensureProcess()) || !processReady || !speechProcess) {
    return {
      ok: false,
      code: lastProcessFailure?.code ?? 'KOKORO_NOT_CONFIGURED',
      message: lastProcessFailure?.message ?? 'Kokoro could not initialize. Please try again.',
      recoverable: true
    }
  }

  cancelSpeechSynthesis(sender.id)
  const settings = getSettings()
  const requestId = randomUUID()
  const session: SpeechSession = { requestId, sender }
  sessions.set(sender.id, session)
  if (!cleanupSenders.has(sender.id)) {
    cleanupSenders.add(sender.id)
    sender.once('destroyed', () => {
      cleanupSenders.delete(sender.id)
      cancelSpeechSynthesis(sender.id)
    })
  }

  const sent = sendToProcess({
    type: 'synthesize',
    requestId,
    sentences,
    speakerId: KOKORO_SPEAKER_IDS[settings.kokoroVoice],
    speed: settings.speechRate
  })
  if (!sent) {
    sessions.delete(sender.id)
    resetProcess()
    return {
      ok: false,
      code: 'KOKORO_PROCESS_MESSAGE_FAILED',
      message: 'Kokoro could not receive the speech request. Please try again.',
      recoverable: true
    }
  }
  return { ok: true, message: 'Kokoro is synthesizing locally.', data: { requestId } }
}

export function cancelSpeechSynthesis(senderId: number): ActionResult {
  const session = sessions.get(senderId)
  if (!session) return { ok: true, message: 'No speech is being synthesized.' }
  sessions.delete(senderId)
  sendToProcess({ type: 'cancel', requestId: session.requestId })
  emit(session, { type: 'cancelled', requestId: session.requestId })
  return { ok: true, message: 'Speech synthesis cancelled.' }
}

export function stopAllSpeechSynthesis(): void {
  for (const senderId of [...sessions.keys()]) cancelSpeechSynthesis(senderId)
  sendToProcess({ type: 'shutdown' })
  resetProcess()
  runtimeRootPromise = undefined
  lastProcessFailure = undefined
}
