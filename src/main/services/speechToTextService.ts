import { app } from 'electron'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, unlink, writeFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ActionResult, Transcription } from '../../shared/types'
import {
  hasAudiblePcm16Samples,
  isPcmWav,
  normalizeWhisperOutput,
  parseWhisperDetectedLanguage
} from './speechToTextValidation'
import { getSettings } from './settingsService'

const TRANSCRIPTION_TIMEOUT_MS = 45_000
const MAX_PROCESS_OUTPUT_LENGTH = 1_000_000
const WHISPER_THREADS = Math.max(1, Math.min(10, availableParallelism()))
const WHISPER_COMMAND_PROMPT =
  'Orbit Orbit. Open, launch, focus, play, pause, next, previous, volume up, volume down, mute, unmute, search, maximize, minimize, restore, stop speaking, disable Orbit. Buksan, i-play, patugtugin, hanapin. YouTube, Google, Chrome, Spotify, Calculator, File Explorer, Visual Studio Code.'

function whisperResourcePath(filename: string): string {
  const resourceRoot = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
  return join(resourceRoot, 'whisper', filename)
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

function runWhisper(
  executablePath: string,
  modelPath: string,
  audioPath: string,
  signal: AbortSignal
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
      child = spawn(
        executablePath,
        [
          '-m',
          basename(modelPath),
          '-f',
          audioPath,
          '-l',
          recognitionLanguage,
          '--threads',
          String(WHISPER_THREADS),
          '--prompt',
          WHISPER_COMMAND_PROMPT,
          '--no-timestamps'
        ],
        {
          // whisper.cpp's Windows CLI does not reliably parse non-ASCII model paths.
          // Run beside the fixed bundled model and pass only its trusted filename.
          cwd: dirname(executablePath),
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
    } catch {
      resolve(unavailableResult('whisper-cli.exe'))
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
      child.kill()
      finish({
        ok: false,
        code: 'TRANSCRIPTION_CANCELLED',
        message: 'The recording was cancelled.',
        recoverable: true
      })
    }

    const timeout = setTimeout(() => {
      child.kill()
      finish({
        ok: false,
        code: 'TRANSCRIPTION_TIMEOUT',
        message: 'Transcription timed out.',
        recoverable: true
      })
    }, TRANSCRIPTION_TIMEOUT_MS)

    signal.addEventListener('abort', abort, { once: true })
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
      finish(unavailableResult('whisper-cli.exe'))
    })
    child.on('close', (exitCode) => {
      if (settled) return

      const text = normalizeWhisperOutput(stdout)
      if (exitCode !== 0 || !text) {
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
            recognitionLanguage === 'en' ? 'en' : parseWhisperDetectedLanguage(stderr)
        }
      })
    })
  })
}

export async function transcribeRecording(
  audio: Uint8Array,
  signal: AbortSignal
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

  const executablePath = whisperResourcePath('whisper-cli.exe')
  const modelPath = whisperResourcePath('ggml-small.bin')
  if (!(await pathExists(executablePath))) return unavailableResult('whisper-cli.exe')
  if (!(await pathExists(modelPath))) return unavailableResult('ggml-small.bin')

  const audioPath = join(app.getPath('temp'), `orbit-recording-${randomUUID()}.wav`)

  try {
    await writeFile(audioPath, audio, { flag: 'wx' })
    return await runWhisper(executablePath, modelPath, audioPath, signal)
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
