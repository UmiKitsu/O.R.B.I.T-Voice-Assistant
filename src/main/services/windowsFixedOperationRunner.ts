import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'
import type { ActionResult } from '../../shared/types'

export const WINDOWS_FIXED_OPERATION_OUTPUT_LIMIT = 64 * 1024
export const WINDOWS_FIXED_OPERATION_ERROR_LIMIT = 8 * 1024

export const windowsFixedOperationSchemas = {
  'system.getBattery': z.object({}).strict(),
  'system.getNetworkStatus': z.object({}).strict(),
  'process.listUser': z.object({ limit: z.number().int().min(1).max(100) }).strict(),
  'process.stopUser': z
    .object({ pid: z.number().int().positive(), orbitPid: z.number().int().positive() })
    .strict(),
  'display.setBrightness': z.object({ percent: z.number().int().min(0).max(100) }).strict(),
  'system.lock': z.object({}).strict(),
  'system.signOut': z.object({}).strict(),
  'system.restart': z.object({}).strict(),
  'system.shutdown': z.object({}).strict()
} as const

export type WindowsFixedOperationId = keyof typeof windowsFixedOperationSchemas

const fixedOperationWireSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.string().trim().min(1).max(100),
      message: z.string().trim().min(1).max(500)
    })
    .strict()
])

export type FixedOperationSpawner = (
  executable: string,
  args: readonly string[]
) => ChildProcessWithoutNullStreams

const defaultSpawner: FixedOperationSpawner = (executable, args) =>
  spawn(executable, [...args], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })

export function getWindowsFixedOperationScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'windows-fixed-operations.ps1')
    : join(app.getAppPath(), 'resources', 'windows-fixed-operations.ps1')
}

function failure(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message, recoverable: true }
}

export async function runFixedWindowsOperation<TData>(
  operationId: WindowsFixedOperationId,
  parameters: unknown,
  dataSchema: z.ZodType<TData>,
  signal: AbortSignal,
  options: {
    timeoutMs?: number
    scriptPath?: string
    spawner?: FixedOperationSpawner
    platform?: NodeJS.Platform
  } = {}
): Promise<ActionResult<TData>> {
  const requestSchema = windowsFixedOperationSchemas[operationId]
  if (!requestSchema) {
    return failure(
      'WINDOWS_FIXED_OPERATION_NOT_REGISTERED',
      'The fixed Windows operation is not registered.'
    )
  }
  const parsedParameters = requestSchema.safeParse(parameters)
  if (!parsedParameters.success) {
    return failure('WINDOWS_FIXED_OPERATION_INVALID_PARAMETERS', 'The fixed Windows operation parameters are invalid.')
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    return failure('WINDOWS_ONLY_OPERATION', 'That operation is available only on Windows.')
  }
  if (signal.aborted) return failure('ACTION_CANCELLED', 'The request was cancelled.')

  const executable = 'powershell.exe'
  const scriptPath = options.scriptPath ?? getWindowsFixedOperationScriptPath()
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
  const child = (options.spawner ?? defaultSpawner)(executable, args)
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 15_000, 60_000))

  return new Promise<ActionResult<TData>>((resolve) => {
    let settled = false
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    const finish = (result: ActionResult<TData>): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }

    const stopForLimit = (stream: 'output' | 'error'): void => {
      child.kill()
      finish(
        failure(
          'WINDOWS_FIXED_OPERATION_OUTPUT_LIMIT',
          `The fixed Windows operation ${stream} exceeded its safety limit.`
        ) as ActionResult<TData>
      )
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > WINDOWS_FIXED_OPERATION_OUTPUT_LIMIT) {
        stopForLimit('output')
        return
      }
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > WINDOWS_FIXED_OPERATION_ERROR_LIMIT) {
        stopForLimit('error')
        return
      }
      stderr.push(Buffer.from(chunk))
    })

    child.once('error', () => {
      finish(
        failure(
          'WINDOWS_FIXED_OPERATION_START_FAILED',
          'Orbit could not start the registered Windows operation.'
        ) as ActionResult<TData>
      )
    })

    child.once('close', (code) => {
      if (settled) return
      if (code !== 0) {
        finish(
          failure(
            'WINDOWS_FIXED_OPERATION_FAILED',
            stderr.length > 0
              ? 'The registered Windows operation failed.'
              : 'The registered Windows operation closed unexpectedly.'
          ) as ActionResult<TData>
        )
        return
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown
      } catch {
        finish(
          failure(
            'WINDOWS_FIXED_OPERATION_INVALID_RESULT',
            'The registered Windows operation returned invalid JSON.'
          ) as ActionResult<TData>
        )
        return
      }

      const wireResult = fixedOperationWireSchema.safeParse(parsedJson)
      if (!wireResult.success) {
        finish(
          failure(
            'WINDOWS_FIXED_OPERATION_INVALID_RESULT',
            'The registered Windows operation returned an invalid typed result.'
          ) as ActionResult<TData>
        )
        return
      }
      if (!wireResult.data.ok) {
        finish({
          ok: false,
          code: wireResult.data.code,
          message: wireResult.data.message,
          recoverable: true
        })
        return
      }

      const parsedData = dataSchema.safeParse(wireResult.data.data)
      if (!parsedData.success) {
        finish(
          failure(
            'WINDOWS_FIXED_OPERATION_INVALID_RESULT',
            'The registered Windows operation returned data outside its schema.'
          ) as ActionResult<TData>
        )
        return
      }
      finish({ ok: true, message: 'The registered Windows operation completed.', data: parsedData.data })
    })

    const abort = (): void => {
      child.kill()
      finish(failure('ACTION_CANCELLED', 'The request was cancelled.') as ActionResult<TData>)
    }
    signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => {
      child.kill()
      finish(
        failure('WINDOWS_FIXED_OPERATION_TIMEOUT', 'The registered Windows operation timed out.') as ActionResult<TData>
      )
    }, timeoutMs)
    timeout.unref?.()

    child.stdin.end(JSON.stringify({ operationId, parameters: parsedParameters.data }), 'utf8')
  })
}
