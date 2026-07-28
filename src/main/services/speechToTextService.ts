import { app } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, unlink, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ActionResult, Transcription, TranscriptionBackend } from '../../shared/types'
import {
  hasAudiblePcm16Samples,
  isPcmWav,
  normalizeWhisperOutput,
  parseWhisperDetectedLanguage
} from './speechToTextValidation'
import { getSettings } from './settingsService'

const VULKAN_TURBO_TIMEOUT_MS = 5_000
const STANDARD_CPU_SMALL_TIMEOUT_MS = 7_000
const WAKE_CPU_SMALL_TIMEOUT_MS = 4_000
const MAX_PROCESS_OUTPUT_LENGTH = 1_000_000
const WHISPER_THREADS = Math.max(1, Math.min(10, availableParallelism()))
const SHORT_WAKE_CANDIDATE_MAX_MS = 5_000
const SHORT_WAKE_AUDIO_CONTEXT = 256
const STANDARD_COMMAND_AUDIO_CONTEXT = 768
const WHISPER_COMMAND_PROMPT =
  'Orbit Orbit. Open, launch, focus, play, pause, skip, skip it, next, next song, next track, previous, previous song, previous track, go back, volume up, volume down, mute, unmute, search, maximize, minimize, restore, stop speaking, disable Orbit. Buksan, i-play, patugtugin, hanapin. YouTube, Google, Chrome, Spotify, Calculator, File Explorer, Visual Studio Code.'

export type TranscriptionProfile = 'standard' | 'wake-candidate'

type WhisperCandidate = {
  executable: string
  model: string
  backend: TranscriptionBackend
  modelName: Transcription['model']
  timeoutMs: number
}

function whisperRoot(): string {
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(resourceRoot, 'whisper')
}

function unavailableResult(filename: string): ActionResult<Transcription> {
  return {
    ok: false,
    code: 'WHISPER_NOT_CONFIGURED',
    message: `Local speech recognition is not configured. Add ${filename} to the bundled whisper resources.`,
    recoverable: true
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function resolveWhisperCandidates(
  profile: TranscriptionProfile
): Promise<WhisperCandidate[]> {
  const root = whisperRoot()
  const cpuExecutable = join(root, 'whisper-cli.exe')
  const smallModel = join(root, 'ggml-small.bin')
  const turboModel = join(root, 'ggml-large-v3-turbo-q5_0.bin')
  const vulkanExecutable = join(root, 'vulkan', 'whisper-cli.exe')

  const [cpuAvailable, vulkanAvailable, smallAvailable, turboAvailable] = await Promise.all([
    pathExists(cpuExecutable),
    pathExists(vulkanExecutable),
    pathExists(smallModel),
    pathExists(turboModel)
  ])

  if (profile === 'wake-candidate') {
    return smallAvailable && cpuAvailable
      ? [
          {
            executable: cpuExecutable,
            model: smallModel,
            backend: 'cpu-small',
            modelName: 'small',
            timeoutMs: WAKE_CPU_SMALL_TIMEOUT_MS
          }
        ]
      : []
  }

  const candidates: WhisperCandidate[] = []
  if (turboAvailable && vulkanAvailable) {
    candidates.push({
      executable: vulkanExecutable,
      model: turboModel,
      backend: 'vulkan-turbo',
      modelName: 'large-v3-turbo-q5_0',
      timeoutMs: VULKAN_TURBO_TIMEOUT_MS
    })
  }
  if (smallAvailable && cpuAvailable) {
    candidates.push({
      executable: cpuExecutable,
      model: smallModel,
      backend: 'cpu-small',
      modelName: 'small',
      timeoutMs: STANDARD_CPU_SMALL_TIMEOUT_MS
    })
  }
  return candidates
}

function runWhisper(
  candidate: WhisperCandidate,
  audioPath: string,
  signal: AbortSignal,
  profile: TranscriptionProfile,
  optimizeShortWakeCandidate: boolean
): Promise<ActionResult<Transcription>> {
  return new Promise((resolve) => {
    const recognitionLanguage = getSettings().recognitionLanguage
    if (signal.aborted) {
      resolve({
        ok: false,
        code: 'TRANSCRIPTION_CANCELLED',
        message: 'The recording was cancelled.',
        recoverable: true
      })
      return
    }

    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      const arguments_ = [
        '-m',
        basename(candidate.model),
        '-f',
        audioPath,
        '-l',
        recognitionLanguage,
        '--threads',
        String(WHISPER_THREADS),
        '--prompt',
        WHISPER_COMMAND_PROMPT,
        '--no-timestamps'
      ]
      arguments_.push('--beam-size', '1', '--best-of', '1', '--no-fallback')
      if (optimizeShortWakeCandidate) {
        arguments_.push('--audio-ctx', String(SHORT_WAKE_AUDIO_CONTEXT))
      } else if (profile === 'standard') {
        arguments_.push('--audio-ctx', String(STANDARD_COMMAND_AUDIO_CONTEXT))
      }
      child = spawn(candidate.executable, arguments_, {
        // The development folder contains Unicode punctuation. Using the fixed model directory as
        // cwd lets whisper.cpp receive a trusted ASCII model filename while backend DLLs still load
        // from the executable's own directory.
        cwd: dirname(candidate.model),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      resolve({
        ok: false,
        code: 'WHISPER_BACKEND_UNAVAILABLE',
        message: 'The selected local speech-recognition backend could not start.',
        recoverable: true
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: ActionResult<Transcription>): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }

    const abort = (): void => {
      child.kill('SIGKILL')
      finish({
        ok: false,
        code: 'TRANSCRIPTION_CANCELLED',
        message: 'The recording was cancelled.',
        recoverable: true
      })
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        ok: false,
        code: 'TRANSCRIPTION_TIMEOUT',
        message: 'Transcription timed out.',
        recoverable: true
      })
    }, candidate.timeoutMs)

    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_PROCESS_OUTPUT_LENGTH) {
        stderr += chunk.slice(0, MAX_PROCESS_OUTPUT_LENGTH - stderr.length)
      }
    })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_PROCESS_OUTPUT_LENGTH) {
        stdout += chunk.slice(0, MAX_PROCESS_OUTPUT_LENGTH - stdout.length)
      }
    })
    child.on('error', () => {
      finish({
        ok: false,
        code: 'WHISPER_BACKEND_UNAVAILABLE',
        message: 'The selected local speech-recognition backend could not start.',
        recoverable: true
      })
    })
    child.on('close', (exitCode) => {
      if (settled) return
      if (exitCode !== 0) {
        finish({
          ok: false,
          code: 'WHISPER_BACKEND_FAILED',
          message: 'The selected local speech-recognition backend failed.',
          recoverable: true
        })
        return
      }

      const text = normalizeWhisperOutput(stdout)
      if (!text) {
        finish({
          ok: false,
          code: 'TRANSCRIPTION_UNCLEAR',
          message: 'I could not understand the recording.',
          recoverable: true
        })
        return
      }

      finish({
        ok: true,
        message: 'Recording transcribed locally.',
        data: {
          text,
          detectedLanguage:
            recognitionLanguage === 'en' ? 'en' : parseWhisperDetectedLanguage(stderr),
          backend: candidate.backend,
          model: candidate.modelName
        }
      })
    })
  })
}

function shouldTryNextBackend(result: ActionResult<Transcription>): boolean {
  return (
    !result.ok &&
    (result.code === 'WHISPER_BACKEND_UNAVAILABLE' ||
      result.code === 'WHISPER_BACKEND_FAILED' ||
      result.code === 'TRANSCRIPTION_TIMEOUT')
  )
}

export async function transcribeRecording(
  audio: Uint8Array,
  signal: AbortSignal,
  profile: TranscriptionProfile = 'standard'
): Promise<ActionResult<Transcription>> {
  if (!isPcmWav(audio)) {
    return {
      ok: false,
      code: 'INVALID_RECORDING',
      message: 'The recording format was invalid.',
      recoverable: true
    }
  }

  if (!hasAudiblePcm16Samples(audio)) {
    return {
      ok: false,
      code: 'NO_SPEECH_DETECTED',
      message:
        'The microphone signal was too low. Check the selected input and speak closer to it.',
      recoverable: true
    }
  }

  const candidates = await resolveWhisperCandidates(profile)
  if (candidates.length === 0) {
    return unavailableResult(profile === 'wake-candidate' ? 'ggml-small.bin' : 'Whisper models')
  }

  const audioPath = join(app.getPath('temp'), `orbit-recording-${randomUUID()}.wav`)

  try {
    await writeFile(audioPath, audio, { flag: 'wx' })
    const durationMs = ((audio.byteLength - 44) / 2 / 16_000) * 1_000
    const optimizeShortWakeCandidate =
      profile === 'wake-candidate' && durationMs <= SHORT_WAKE_CANDIDATE_MAX_MS

    let lastResult: ActionResult<Transcription> | undefined
    for (const candidate of candidates) {
      lastResult = await runWhisper(
        candidate,
        audioPath,
        signal,
        profile,
        optimizeShortWakeCandidate
      )
      if (lastResult.ok || !shouldTryNextBackend(lastResult)) return lastResult
    }
    return lastResult ?? unavailableResult('Whisper models')
  } catch {
    return {
      ok: false,
      code: 'TRANSCRIPTION_FAILED',
      message: 'I could not understand the recording.',
      recoverable: true
    }
  } finally {
    await unlink(audioPath).catch(() => undefined)
  }
}
