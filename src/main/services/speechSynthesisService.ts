import { app, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { access, realpath, symlink, unlink } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, KokoroVoice, SpeechSynthesisEvent } from '../../shared/types'
import CreateSpeechSynthesisWorker from './speechSynthesisWorker?nodeWorker'
import type {
  SpeechSynthesisWorkerInput,
  SpeechSynthesisWorkerOutput,
  SpeechSynthesisWorkerResources
} from './speechSynthesisProtocol'
import { getSettings } from './settingsService'

const MAX_SPEECH_TEXT_LENGTH = 4_000
const MAX_SENTENCE_LENGTH = 240
const MAX_SENTENCE_COUNT = 50
const WORKER_START_TIMEOUT_MS = 20_000
const KOKORO_THREADS = Math.max(1, Math.min(4, availableParallelism()))

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

type SpeechWorker = ReturnType<typeof CreateSpeechSynthesisWorker>

let worker: SpeechWorker | undefined
let workerReady = false
let workerStartup: Promise<boolean> | undefined
let resourceAlias: string | undefined
const sessions = new Map<number, SpeechSession>()
const cleanupSenders = new Set<number>()

function kokoroRoot(): string {
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(resourceRoot, 'kokoro', 'kokoro-multi-lang-v1_0')
}

async function kokoroNativeRoot(): Promise<string> {
  const root = kokoroRoot()
  if (!/[^\x20-\x7e]/.test(root)) return root

  const temporaryRoot = app.getPath('temp')
  if (/[^\x20-\x7e]/.test(temporaryRoot)) return root
  const alias = join(temporaryRoot, `orbit-kokoro-resources-${process.pid}`)
  try {
    await symlink(root, alias, 'junction')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return root
    try {
      const [existingTarget, intendedTarget] = await Promise.all([realpath(alias), realpath(root)])
      if (existingTarget.toLowerCase() !== intendedTarget.toLowerCase()) return root
    } catch {
      return root
    }
  }
  resourceAlias = alias
  return alias
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

function emit(session: SpeechSession, event: SpeechSynthesisEvent): void {
  if (!session.sender.isDestroyed()) session.sender.send(IPC_CHANNELS.speechEvent, event)
}

function sessionForRequest(requestId: string): [number, SpeechSession] | undefined {
  for (const entry of sessions) if (entry[1].requestId === requestId) return entry
  return undefined
}

function handleWorkerOutput(message: SpeechSynthesisWorkerOutput): void {
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

function resetWorker(): void {
  const activeWorker = worker
  worker = undefined
  workerReady = false
  workerStartup = undefined
  if (activeWorker) void activeWorker.terminate()
}

async function ensureWorker(): Promise<boolean> {
  if (worker?.threadId && workerReady) return true
  if (workerStartup) return workerStartup

  workerStartup = (async () => {
    const modelResources = await resources()
    if (!(await resourcesExist(modelResources))) return false

    const nextWorker = CreateSpeechSynthesisWorker({})
    worker = nextWorker
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ready: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        workerReady = ready
        if (!ready) resetWorker()
        resolve(ready)
      }
      const timeout = setTimeout(() => finish(false), WORKER_START_TIMEOUT_MS)

      nextWorker.on('message', (message: SpeechSynthesisWorkerOutput) => {
        if (worker !== nextWorker) return
        if (message.type === 'ready') {
          finish(message.sampleRate >= 8_000 && message.sampleRate <= 48_000)
          return
        }
        if (message.type === 'error' && message.requestId === 'initialization') {
          finish(false)
          return
        }
        handleWorkerOutput(message)
      })
      nextWorker.once('error', () => {
        if (worker === nextWorker) {
          failAllSessions('KOKORO_RUNTIME_FAILED', 'The local Kokoro voice stopped unexpectedly.')
          finish(false)
        }
      })
      nextWorker.once('exit', () => {
        if (worker === nextWorker) {
          worker = undefined
          workerReady = false
          workerStartup = undefined
        }
      })
      nextWorker.postMessage({
        type: 'initialize',
        resources: modelResources,
        numThreads: KOKORO_THREADS
      } satisfies SpeechSynthesisWorkerInput)
    })
  })()

  try {
    return await workerStartup
  } finally {
    workerStartup = undefined
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
  if (!(await ensureWorker()) || !workerReady || !worker) {
    return {
      ok: false,
      code: 'KOKORO_NOT_CONFIGURED',
      message: 'Kokoro is unavailable. Orbit will use Windows speech instead.',
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
  worker.postMessage({
    type: 'synthesize',
    requestId,
    sentences,
    speakerId: KOKORO_SPEAKER_IDS[settings.kokoroVoice],
    speed: settings.speechRate
  } satisfies SpeechSynthesisWorkerInput)
  return { ok: true, message: 'Kokoro is synthesizing locally.', data: { requestId } }
}

export function cancelSpeechSynthesis(senderId: number): ActionResult {
  const session = sessions.get(senderId)
  if (!session) return { ok: true, message: 'No speech is being synthesized.' }
  sessions.delete(senderId)
  worker?.postMessage({
    type: 'cancel',
    requestId: session.requestId
  } satisfies SpeechSynthesisWorkerInput)
  emit(session, { type: 'cancelled', requestId: session.requestId })
  return { ok: true, message: 'Speech synthesis cancelled.' }
}

export function stopAllSpeechSynthesis(): void {
  for (const senderId of [...sessions.keys()]) cancelSpeechSynthesis(senderId)
  worker?.postMessage({ type: 'shutdown' } satisfies SpeechSynthesisWorkerInput)
  resetWorker()
  const alias = resourceAlias
  resourceAlias = undefined
  if (alias) void unlink(alias).catch(() => undefined)
}
