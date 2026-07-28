import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import {
  runFixedWindowsOperation,
  type FixedOperationSpawner,
  type WindowsFixedOperationId
} from './windowsFixedOperationRunner'

type FakeProcess = EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function successfulSpawner(
  response: unknown,
  capture: { executable?: string; args?: readonly string[]; stdin?: string }
): FixedOperationSpawner {
  return (executable, args) => {
    capture.executable = executable
    capture.args = args
    const child = new EventEmitter() as FakeProcess
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true)
    const chunks: Buffer[] = []
    child.stdin.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
    child.stdin.once('finish', () => {
      capture.stdin = Buffer.concat(chunks).toString('utf8')
      child.stdout.end(JSON.stringify(response), 'utf8')
      queueMicrotask(() => child.emit('close', 0, null))
    })
    return child as unknown as ChildProcessWithoutNullStreams
  }
}

describe('fixed Windows operation runner', () => {
  it('uses fixed PowerShell arguments and sends typed JSON only through stdin', async () => {
    const capture: { executable?: string; args?: readonly string[]; stdin?: string } = {}
    const result = await runFixedWindowsOperation(
      'process.listUser',
      { limit: 20 },
      z.object({ processes: z.array(z.unknown()), truncated: z.boolean() }).strict(),
      new AbortController().signal,
      {
        platform: 'win32',
        scriptPath: 'C:\\Orbit\\windows-fixed-operations.ps1',
        spawner: successfulSpawner(
          { ok: true, data: { processes: [], truncated: false } },
          capture
        )
      }
    )

    expect(result).toMatchObject({ ok: true, data: { processes: [], truncated: false } })
    expect(capture.executable).toBe('powershell.exe')
    expect(capture.args).toEqual([
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Orbit\\windows-fixed-operations.ps1'
    ])
    expect(JSON.parse(capture.stdin ?? '')).toEqual({
      operationId: 'process.listUser',
      parameters: { limit: 20 }
    })
    expect(capture.args?.join(' ')).not.toContain('process.listUser')
  })

  it.each([
    '"; Stop-Process -Id 1; "',
    "' | Remove-Item C:\\\\* -Recurse | '",
    '; shutdown /s',
    '`whoami`',
    '$(Get-ChildItem Env:)',
    '-EncodedCommand SQBFAFgA',
    'value with extra fields'
  ])('keeps PowerShell injection payload inert: %s', async (payload) => {
    const spawner = vi.fn()
    const result = await runFixedWindowsOperation(
      'display.setBrightness',
      { percent: 50, payload },
      z.object({ percent: z.number() }).strict(),
      new AbortController().signal,
      { platform: 'win32', spawner: spawner as unknown as FixedOperationSpawner }
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'WINDOWS_FIXED_OPERATION_INVALID_PARAMETERS'
    })
    expect(spawner).not.toHaveBeenCalled()
  })

  it('rejects an unregistered operation ID before starting PowerShell', async () => {
    const spawner = vi.fn()
    const operation = 'process.listUser; shutdown /s' as WindowsFixedOperationId
    const result = await runFixedWindowsOperation(
      operation,
      {},
      z.unknown(),
      new AbortController().signal,
      { platform: 'win32', spawner: spawner as unknown as FixedOperationSpawner }
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'WINDOWS_FIXED_OPERATION_NOT_REGISTERED'
    })
    expect(spawner).not.toHaveBeenCalled()
  })

  it.runIf(process.platform === 'win32')(
    'executes a real no-parameter operation through the fixed script',
    async () => {
      const result = await runFixedWindowsOperation(
        'system.getBattery',
        {},
        z.discriminatedUnion('present', [
          z.object({ present: z.literal(false) }).strict(),
          z
            .object({
              present: z.literal(true),
              percent: z.number().int().min(0).max(100),
              charging: z.boolean()
            })
            .strict()
        ]),
        new AbortController().signal,
        {
          platform: 'win32',
          scriptPath: join(process.cwd(), 'resources', 'windows-fixed-operations.ps1')
        }
      )

      expect(result).toMatchObject({ ok: true })
    }
  )

  it('rejects extra result fields and does not trust PowerShell output shape', async () => {
    const capture: { executable?: string; args?: readonly string[]; stdin?: string } = {}
    const result = await runFixedWindowsOperation(
      'system.getBattery',
      {},
      z.object({ present: z.boolean() }).strict(),
      new AbortController().signal,
      {
        platform: 'win32',
        scriptPath: 'C:\\Orbit\\windows-fixed-operations.ps1',
        spawner: successfulSpawner(
          { ok: true, data: { present: false }, command: 'whoami' },
          capture
        )
      }
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'WINDOWS_FIXED_OPERATION_INVALID_RESULT'
    })
  })
})
