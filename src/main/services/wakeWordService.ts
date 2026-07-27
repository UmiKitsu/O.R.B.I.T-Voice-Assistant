import { app, type WebContents } from 'electron'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type {
  ActionResult,
  MicrophoneTestResult,
  WakeWordEvent,
  WakeWordState,
  WakeWordTestResult
} from '../../shared/types'
import CreateWakeWordWorker from './wakeWordWorker?nodeWorker'
import type { WakeAudioMetrics } from './wakeWordCandidateSegmenter'
import type {
  WakeWordWorkerInput,
  WakeWordWorkerOutput,
  WakeWordWorkerResources
} from './wakeWordProtocol'
import { logOperationalEvent } from './loggerService'
import { getSettings } from './settingsService'
import { diagnoseVoiceRecording, diagnoseWakeCandidateRecording } from './voiceDiagnosticsService'
import { encodePcm16Wav, isValidWakeWordCommand } from './wakeWordValidation'

const START_TIMEOUT_MS = 10_000
const COMMAND_TRANSCRIPTION_DEADLINE_MS = 12_500
const WAKE_WORD_TEST_LISTEN_MS = 8_000
const WAKE_WORD_TEST_PROCESSING_GRACE_MS = 4_000

function wakeWordResourcePath(filename: string): string {
  const root = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(root, 'wake-word', filename)
}

function resources(): WakeWordWorkerResources {
  return {
    encoder: wakeWordResourcePath('encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
    decoder: wakeWordResourcePath('decoder-epoch-13-avg-2-chunk-16-left-64.onnx'),
    joiner: wakeWordResourcePath('joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx'),
    tokens: wakeWordResourcePath('tokens.txt'),
    keywords: wakeWordResourcePath('keywords.txt')
  }
}

function stateMessage(state: WakeWordState): string {
  const messages: Record<WakeWordState, string> = {
    off: 'Wake-word listening is off.',
    starting: 'Starting local wake-word listening.',
    armed: 'Listening locally for ORBIT.',
    detected: 'Orbit detected.',
    capturing: 'Listening for your command.',
    transcribing: 'Transcribing your command locally.',
    paused: 'Wake-word listening is paused.',
    error: 'Wake-word listening encountered an error.'
  }
  return messages[state]
}

const EMPTY_WAKE_METRICS: WakeAudioMetrics = {
  captureDurationMs: 0,
  audioChunkCount: 0,
  peakLevel: 0,
  rmsLevel: 0,
  signalQuality: 'none'
}

type WakeWordTestSession = {
  startedAt: number
  windowTimeout: ReturnType<typeof setTimeout>
  processingTimeout?: ReturnType<typeof setTimeout>
  windowEnded: boolean
  metrics: WakeAudioMetrics
  heardText?: string
}

type FallbackTranscription = {
  candidateId: number
  controller: AbortController
  test: boolean
}

type WakeWordSession = {
  worker: ReturnType<typeof CreateWakeWordWorker>
  sender: WebContents
  transcription?: AbortController
  fallback?: FallbackTranscription
  wakeTest?: WakeWordTestSession
  ready: boolean
}

const sessions = new Map<number, WakeWordSession>()

function emit(session: WakeWordSession, event: WakeWordEvent): void {
  if (!session.sender.isDestroyed()) session.sender.send(IPC_CHANNELS.wakeWordEvent, event)
}

function emitState(session: WakeWordSession, state: WakeWordState): void {
  emit(session, { type: 'state', state, message: stateMessage(state) })
}

function clearWakeWordTestTimers(test: WakeWordTestSession): void {
  clearTimeout(test.windowTimeout)
  if (test.processingTimeout) clearTimeout(test.processingTimeout)
}

function finishWakeWordTest(session: WakeWordSession, result: WakeWordTestResult): void {
  const test = session.wakeTest
  if (!test) return
  clearWakeWordTestTimers(test)
  session.wakeTest = undefined
  if (session.fallback?.test) {
    session.fallback.controller.abort()
    session.fallback = undefined
  }
  session.worker.postMessage({ type: 'test-cancel' } satisfies WakeWordWorkerInput)
  emit(session, { type: 'test-result', result })
}

function failedWakeWordTestResult(
  metrics: WakeAudioMetrics,
  heardText?: string
): WakeWordTestResult {
  return { detected: false, heardText, ...metrics }
}

async function diagnoseCommandWithDeadline(
  audio: Uint8Array,
  controller: AbortController
): Promise<ActionResult<MicrophoneTestResult>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<ActionResult<MicrophoneTestResult>>((resolve) => {
    timeout = setTimeout(() => {
      resolve({
        ok: false,
        code: 'TRANSCRIPTION_TIMEOUT',
        message: 'Command transcription took too long. Please try again.',
        recoverable: true
      })
      controller.abort()
    }, COMMAND_TRANSCRIPTION_DEADLINE_MS)
  })

  try {
    return await Promise.race([diagnoseVoiceRecording(audio, controller.signal), deadline])
  } catch {
    return {
      ok: false,
      code: 'TRANSCRIPTION_FAILED',
      message: 'Command transcription failed. Please try again.',
      recoverable: true
    }
  } finally {
    if (timeout) clearTimeout(timeout)
  }
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

  const result = await diagnoseCommandWithDeadline(encodePcm16Wav(samples), controller)
  if (session.transcription !== controller) return
  session.transcription = undefined
  if (controller.signal.aborted && !result.ok && result.code === 'TRANSCRIPTION_CANCELLED') return

  if (!result.ok || !result.data) {
    logOperationalEvent({ event: 'wake-word.command-transcribed', outcome: 'failed' })
    emit(session, {
      type: 'error',
      code: result.ok ? 'EMPTY_WAKE_WORD_COMMAND' : result.code,
      message: result.ok ? 'No command was heard after Orbit.' : result.message,
      fatal: false
    })
    return
  }

  logOperationalEvent({ event: 'wake-word.command-transcribed', outcome: 'succeeded' })
  emit(session, {
    type: 'transcription',
    transcript: result.data.transcript,
    diagnostics: result.data.diagnostics
  })
}

function postFallbackDecision(
  session: WakeWordSession,
  candidateId: number,
  detected: boolean,
  hasCommand: boolean
): void {
  session.worker.postMessage({
    type: 'fallback-result',
    candidateId,
    detected,
    hasCommand
  } satisfies WakeWordWorkerInput)
}

async function transcribeWakeCandidate(
  session: WakeWordSession,
  message: Extract<WakeWordWorkerOutput, { type: 'wake-candidate' }>
): Promise<void> {
  if (!isValidWakeWordCommand(message.samples)) {
    postFallbackDecision(session, message.candidateId, false, false)
    return
  }
  if (message.test && !session.wakeTest) {
    postFallbackDecision(session, message.candidateId, false, false)
    return
  }

  session.fallback?.controller.abort()
  const controller = new AbortController()
  const fallback: FallbackTranscription = {
    candidateId: message.candidateId,
    controller,
    test: message.test
  }
  session.fallback = fallback
  if (message.test && session.wakeTest) session.wakeTest.metrics = message.metrics

  const result = await diagnoseWakeCandidateRecording(
    encodePcm16Wav(message.samples),
    controller.signal
  )
  if (session.fallback !== fallback || controller.signal.aborted) return
  session.fallback = undefined

  if (!result.ok || !result.data) {
    postFallbackDecision(session, message.candidateId, false, false)
    if (message.test && session.wakeTest?.windowEnded) {
      finishWakeWordTest(
        session,
        failedWakeWordTestResult(session.wakeTest.metrics, session.wakeTest.heardText)
      )
    }
    return
  }

  const diagnosis = result.data
  if (!diagnosis.detected) {
    if (message.test && session.wakeTest) {
      session.wakeTest.heardText = diagnosis.heardText.slice(0, 500)
    }
    postFallbackDecision(session, message.candidateId, false, false)
    if (message.test && session.wakeTest?.windowEnded) {
      finishWakeWordTest(
        session,
        failedWakeWordTestResult(session.wakeTest.metrics, session.wakeTest.heardText)
      )
    }
    return
  }

  const hasCommand = diagnosis.transcript !== undefined && diagnosis.diagnostics !== undefined
  postFallbackDecision(session, message.candidateId, true, hasCommand)

  if (message.test) {
    const test = session.wakeTest
    if (!test) return
    finishWakeWordTest(session, {
      detected: true,
      method: 'whisper-fallback',
      latencyMs: Math.max(0, Date.now() - test.startedAt),
      heardText: diagnosis.heardText.slice(0, 500),
      ...test.metrics
    })
    return
  }

  if (hasCommand) {
    // Small is trusted only to detect the wake phrase. Preserve the same in-memory PCM and let
    // Vulkan Large-v3 Turbo produce the final command transcript for better command accuracy.
    emitState(session, 'detected')
    await transcribeCommand(session, message.samples)
  }
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
        case 'wake-candidate':
          void transcribeWakeCandidate(session, message)
          break
        case 'test-detected':
          finishWakeWordTest(session, {
            detected: true,
            method: 'keyword',
            latencyMs: message.latencyMs,
            heardText: 'Orbit',
            ...message.metrics
          })
          break
        case 'test-window-ended': {
          const test = session.wakeTest
          if (!test) break
          test.metrics = message.metrics
          if (!session.fallback) {
            finishWakeWordTest(session, failedWakeWordTestResult(message.metrics, test.heardText))
          }
          break
        }
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
          session.fallback?.controller.abort()
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
      session.fallback?.controller.abort()
      if (session.wakeTest) clearWakeWordTestTimers(session.wakeTest)
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
      resources: modelResources,
      recognitionMode: getSettings().wakeRecognitionMode
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

export function startWakeWordTest(senderId: number): ActionResult {
  const session = sessions.get(senderId)
  if (!session?.ready) {
    return {
      ok: false,
      code: 'WAKE_WORD_TEST_NOT_READY',
      message: 'Start local voice listening before testing the Orbit wake word.',
      recoverable: true
    }
  }
  if (session.wakeTest) {
    clearWakeWordTestTimers(session.wakeTest)
    session.wakeTest = undefined
  }
  session.transcription?.abort()
  session.transcription = undefined
  if (session.fallback?.test) session.fallback.controller.abort()
  session.fallback = undefined
  session.worker.postMessage({ type: 'test-start' } satisfies WakeWordWorkerInput)

  const test: WakeWordTestSession = {
    startedAt: Date.now(),
    windowEnded: false,
    metrics: { ...EMPTY_WAKE_METRICS },
    windowTimeout: setTimeout(() => {
      if (session.wakeTest !== test) return
      test.windowEnded = true
      session.worker.postMessage({ type: 'test-window-end' } satisfies WakeWordWorkerInput)
      test.processingTimeout = setTimeout(() => {
        if (session.wakeTest !== test) return
        finishWakeWordTest(session, failedWakeWordTestResult(test.metrics, test.heardText))
      }, WAKE_WORD_TEST_PROCESSING_GRACE_MS)
    }, WAKE_WORD_TEST_LISTEN_MS)
  }
  session.wakeTest = test
  return {
    ok: true,
    message: 'Listening for Orbit for eight seconds with local fallback recognition.'
  }
}

export function cancelWakeWordTest(senderId: number): ActionResult {
  const session = sessions.get(senderId)
  const test = session?.wakeTest
  if (!session || !test) return { ok: true, message: 'No wake-word test is running.' }
  clearWakeWordTestTimers(test)
  session.wakeTest = undefined
  if (session.fallback?.test) {
    session.fallback.controller.abort()
    session.fallback = undefined
  }
  session.worker.postMessage({ type: 'test-cancel' } satisfies WakeWordWorkerInput)
  return { ok: true, message: 'Wake-word test cancelled.' }
}

function changeWakeWordState(senderId: number, type: 'pause' | 'resume'): ActionResult {
  const session = sessions.get(senderId)
  if (!session?.ready) {
    return { ok: true, message: 'Wake-word listening is not running.' }
  }
  if (type === 'pause') {
    cancelWakeWordTest(senderId)
    session.transcription?.abort()
    session.transcription = undefined
    session.fallback?.controller.abort()
    session.fallback = undefined
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
  if (session.wakeTest) clearWakeWordTestTimers(session.wakeTest)
  session.transcription?.abort()
  session.fallback?.controller.abort()
  session.worker.postMessage({ type: 'shutdown' } satisfies WakeWordWorkerInput)
  void session.worker.terminate()
  emitState(session, 'off')
  logOperationalEvent({ event: 'wake-word.stopped' })
  return { ok: true, message: stateMessage('off') }
}

export function stopAllWakeWordSessions(): void {
  for (const senderId of [...sessions.keys()]) stopWakeWord(senderId)
}
