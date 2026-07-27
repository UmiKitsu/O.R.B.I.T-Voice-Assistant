import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export type OperationalLogEvent =
  | {
      event:
        | 'app.started'
        | 'app.closed'
        | 'ollama.connected'
        | 'recording.started'
        | 'wake-word.started'
        | 'wake-word.stopped'
    }
  | { event: 'wake-word.command-transcribed'; outcome: 'succeeded' | 'failed' }
  | { event: 'transcription.completed'; outcome: 'succeeded' | 'failed' }
  | { event: 'capability.requested'; capability: string }
  | { event: 'policy.decided'; capability: string; decision: 'allowed' | 'blocked' }
  | { event: 'action.completed'; capability: string; outcome: 'succeeded' | 'failed' }

let logDirectory: string | undefined
let writeQueue: Promise<void> = Promise.resolve()

export function initializeLogger(userDataDirectory: string): void {
  logDirectory = join(userDataDirectory, 'logs')
}

function safeCapabilityName(capability: string): string {
  return /^[a-z][a-zA-Z0-9.]{0,99}$/.test(capability) ? capability : 'unknown'
}

export function serializeOperationalLogEvent(entry: OperationalLogEvent, timestamp: Date): string {
  const safeEntry =
    'capability' in entry ? { ...entry, capability: safeCapabilityName(entry.capability) } : entry
  return `${JSON.stringify({ timestamp: timestamp.toISOString(), ...safeEntry })}\n`
}

export function logOperationalEvent(entry: OperationalLogEvent): void {
  if (!logDirectory) return

  const line = serializeOperationalLogEvent(entry, new Date())
  const directory = logDirectory
  writeQueue = writeQueue
    .then(async () => {
      await mkdir(directory, { recursive: true })
      await appendFile(join(directory, 'titan.log'), line, { encoding: 'utf8' })
    })
    .catch(() => undefined)
}

export function flushLogs(): Promise<void> {
  return writeQueue
}
