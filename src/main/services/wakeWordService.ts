import { app, type WebContents } from 'electron'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, WakeWordEvent, WakeWordState } from '../../shared/types'
import CreateWakeWordWorker from './wakeWordWorker?nodeWorker'
import type {
  WakeWordWorkerInput,
  WakeWordWorkerOutput,
  WakeWordWorkerResources
} from './wakeWordProtocol'
import { logOperationalEvent } from './loggerService'
import { transcribeRecording } from './speechToTextService'
import { encodePcm16Wav, isValidWakeWordCommand, stripWakePhrase } from './wakeWordValidation'

const START_TIMEOUT_MS = 10_000

function wakeWordResourcePath(filename: string): string {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(root, 'wake-word', filename)
}

function resources(): WakeWordWorkerResources {
  return {
    encoder: wakeWordResourcePath('encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
    decoder: wakeWordResourcePath('decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
    joiner: wakeWordResourcePath('joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
    tokens: wakeWordResourcePath('tokens.txt'),
    keywords: wakeWordResourcePath('keywords.txt')
  }
}

function stateMessage(state: WakeWordState): string {
  const messages: Record<WakeWordState, string> = {
    off: 'Wake-word listening is off.',
    starting: 'Starting local wake-word listening.',
    armed: 'Listening locally for “TITAN”.',
    detected: 'Wake phrase detected.',
    capturing: 'Listening for your command.',
    transcribing: 'Transcribing your command locally.',
    paused: 'Wake-word listening is paused.',
    error: 'Wake-word listening encountered an error.'
  }
  return messages[state]
}

type WakeWordSession = {
  worker: ReturnType<typeof CreateWakeWordWorker>
  sender: WebContents
  transcription?: AbortController
  ready: boolean
}

const sessions = new Map<number, WakeWordSession>()

function emit(session: WakeWordSession, event: WakeWordEvent): void {
  if (!session.sender.isDestroyed()) session.sender.send(IPC_CHANNELS.wakeWordEvent, event)
}

function emitState(session: WakeWordSession, state: WakeWordState): void {
  emit(session, { type: 'state', state, message: stateMessage(state) })
}

async function transcribeCommand(session: WakeWordSession, samples: unknown): Promise<void> {
  if (!isValidWakeWordCommand(samples)) {
    emit(session, {
      type: 'error',
      code: 'INVALID_WAKE_WORD_AUDIO',
      message: 'The captured wake-word command was invalid.',
      fatal: false
    })
    return
  }

  const controller = new AbortController()
  session.transcription?.abort()
  session.transcription = controller
  emitState(session, 'transcribing')

  const result = await transcribeRecording(encodePcm16Wav(samples), controller.signal)
  if (session.transcription !== controller || controller.signal.aborted) return
  session.transcription = undefined

  if (!result.ok || !result.data?.text) {
    emit(session, {
      type: 'error',
      code: result.ok ? 'EMPTY_WAKE_WORD_COMMAND' : result.code,
      message: result.ok ? 'No command was heard after “TITAN”.' : result.message,
      fatal: false
    })
    return
  }

  const command = stripWakePhrase(result.data.text)
  if (!command) {
    emit(session, {
      type: 'error',
      code: 'EMPTY_WAKE_WORD_COMMAND',
      message: 'No command was heard after “TITAN”.',
      fatal: false
    })
    return
  }

  logOperationalEvent({ event: 'wake-word.command-transcribed', outcome: 'succeeded' })
  emit(session, { type: 'transcription', text: command })
}

function unavailableResult(): ActionResult {
  return {
    ok: false,
    code: 'WAKE_WORD_NOT_CONFIGURED',
    message: 'Local wake-word resources are missing from the application.',
    recoverable: true
  }
}

async function resourcesExist(value: WakeWordWorkerResources): Promise<boolean> {
  try {
    await Promise.all(Object.values(value).map((path) => access(path)))
    return true
  } catch {
    return false
  }
}

export async function startWakeWord(sender: WebContents): Promise<ActionResult> {
  const existing = sessions.get(sender.id)
  if (existing?.ready) return { ok: true, message: stateMessage('armed') }

  const modelResources = resources()
  if (!(await resourcesExist(modelResources))) return unavailableResult()

  const worker = CreateWakeWordWorker({})
  const session: WakeWordSession = { worker, sender, ready: false }
  sessions.set(sender.id, session)
  sender.once('destroyed', () => stopWakeWord(sender.id))
  emitState(session, 'starting')

  return await new Promise<ActionResult>((resolve) => {
    let settled = false
    const finish = (result: ActionResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(result)
    }
    const timeout = setTimeout(() => {
      stopWakeWord(sender.id)
      finish({
        ok: false,
        code: 'WAKE_WORD_START_TIMEOUT',
        message: 'Local wake-word detection took too long to start.',
        recoverable: true
      })
    }, START_TIMEOUT_MS)

    worker.on('message', (message: WakeWordWorkerOutput) => {
      if (sessions.get(sender.id) !== session) return
      switch (message.type) {
        case 'ready':
          session.ready = true
          emitState(session, 'armed')
          logOperationalEvent({ event: 'wake-word.started' })
          finish({ ok: true, message: stateMessage('armed') })
          break
        case 'state':
          emitState(session, message.state)
          break
        case 'command':
          void transcribeCommand(session, message.samples)
          break
        case 'error':
          emit(session, {
            type: 'error',
            code: 'WAKE_WORD_RUNTIME_FAILED',
            message: 'The local wake-word engine could not start.',
            fatal: true
          })
          finish({
            ok: false,
            code: 'WAKE_WORD_RUNTIME_FAILED',
            message: 'The local wake-word engine could not start.',
            recoverable: true
          })
          sessions.delete(sender.id)
          void worker.terminate()
          break
      }
    })

    worker.once('error', () => {
      emit(session, {
        type: 'error',
        code: 'WAKE_WORD_RUNTIME_FAILED',
        message: 'The local wake-word engine stopped unexpectedly.',
        fatal: true
      })
      sessions.delete(sender.id)
      session.transcription?.abort()
      void worker.terminate()
      finish({
        ok: false,
        code: 'WAKE_WORD_RUNTIME_FAILED',
        message: 'The local wake-word engine stopped unexpectedly.',
        recoverable: true
      })
    })

    worker.postMessage({
      type: 'initialize',
      resources: modelResources
    } satisfies WakeWordWorkerInput)
  })
}

export function sendWakeWordAudio(senderId: number, samples: Float32Array): void {
  const session = sessions.get(senderId)
  if (!session?.ready) return
  const copy = new Float32Array(samples)
  session.worker.postMessage({ type: 'audio', samples: copy } satisfies WakeWordWorkerInput, [
    copy.buffer
  ])
}

function changeWakeWordState(senderId: number, type: 'pause' | 'resume'): ActionResult {
  const session = sessions.get(senderId)
  if (!session?.ready) {
    return { ok: true, message: 'Wake-word listening is not running.' }
  }
  if (type === 'pause') {
    session.transcription?.abort()
    session.transcription = undefined
  }
  session.worker.postMessage({ type } satisfies WakeWordWorkerInput)
  return { ok: true, message: stateMessage(type === 'pause' ? 'paused' : 'armed') }
}

export function pauseWakeWord(senderId: number): ActionResult {
  return changeWakeWordState(senderId, 'pause')
}

export function resumeWakeWord(senderId: number): ActionResult {
  return changeWakeWordState(senderId, 'resume')
}

export function stopWakeWord(senderId: number): ActionResult {
  const session = sessions.get(senderId)
  if (!session) return { ok: true, message: stateMessage('off') }
  sessions.delete(senderId)
  session.transcription?.abort()
  session.worker.postMessage({ type: 'shutdown' } satisfies WakeWordWorkerInput)
  void session.worker.terminate()
  emitState(session, 'off')
  logOperationalEvent({ event: 'wake-word.stopped' })
  return { ok: true, message: stateMessage('off') }
}

export function stopAllWakeWordSessions(): void {
  for (const senderId of [...sessions.keys()]) stopWakeWord(senderId)
}
