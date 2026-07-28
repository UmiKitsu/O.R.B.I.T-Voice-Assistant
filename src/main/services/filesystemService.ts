import { shell } from 'electron'
import { access, copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, parse, resolve, win32 } from 'node:path'
import type { ActionResult } from '../../shared/types'

export type TrashController = (path: string) => Promise<void>

function isAbsoluteOnSupportedPlatform(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value)
}

export function validateAbsolutePath(value: string): string | null {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  if (!trimmed || trimmed.length > 1_024 || !isAbsoluteOnSupportedPlatform(trimmed)) return null
  return normalize(trimmed)
}

function normalizedForComparison(value: string): string {
  return resolve(value).replace(/[\\/]+$/, '').toLocaleLowerCase()
}

function protectedRoots(): string[] {
  return [
    process.env.SystemRoot,
    process.env.windir,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData
  ]
    .filter((value): value is string => Boolean(value))
    .map(normalizedForComparison)
}

export function isProtectedSystemPath(path: string): boolean {
  const normalized = normalizedForComparison(path)
  const root = normalizedForComparison(parse(path).root)
  if (normalized === root) return true
  return protectedRoots().some(
    (protectedRoot) => normalized === protectedRoot || normalized.startsWith(`${protectedRoot}\\`)
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function invalidPathResult(): ActionResult {
  return {
    ok: false,
    code: 'INVALID_PATH',
    message: 'Use a complete absolute path for this protected action.',
    recoverable: true
  }
}

function protectedPathResult(): ActionResult {
  return {
    ok: false,
    code: 'PROTECTED_SYSTEM_PATH',
    message: 'Orbit will not modify Windows, Program Files, ProgramData, or a drive root.',
    recoverable: true
  }
}

export async function trashPath(
  requestedPath: string,
  trashController: TrashController = (path) => shell.trashItem(path)
): Promise<ActionResult<{ path: string }>> {
  const path = validateAbsolutePath(requestedPath)
  if (!path) return invalidPathResult()
  if (isProtectedSystemPath(path)) return protectedPathResult()
  if (!(await pathExists(path))) {
    return {
      ok: false,
      code: 'PATH_NOT_FOUND',
      message: `I could not find ${basename(path)}.`,
      recoverable: true
    }
  }

  try {
    await trashController(path)
    return {
      ok: true,
      message: `${basename(path)} was moved to the Recycle Bin.`,
      data: { path }
    }
  } catch {
    return {
      ok: false,
      code: 'DELETE_FAILED',
      message: `${basename(path)} could not be moved to the Recycle Bin.`,
      recoverable: true
    }
  }
}

export async function movePath(
  requestedSource: string,
  requestedDestination: string
): Promise<ActionResult<{ source: string; destination: string }>> {
  const source = validateAbsolutePath(requestedSource)
  const destination = validateAbsolutePath(requestedDestination)
  if (!source || !destination) return invalidPathResult()
  if (isProtectedSystemPath(source) || isProtectedSystemPath(destination)) {
    return protectedPathResult()
  }
  if (!(await pathExists(source))) {
    return { ok: false, code: 'SOURCE_NOT_FOUND', message: 'The source path was not found.', recoverable: true }
  }
  if (await pathExists(destination)) {
    return { ok: false, code: 'DESTINATION_EXISTS', message: 'The destination already exists.', recoverable: true }
  }

  try {
    await rename(source, destination)
    return {
      ok: true,
      message: `${basename(source)} was moved to ${destination}.`,
      data: { source, destination }
    }
  } catch {
    return {
      ok: false,
      code: 'MOVE_FAILED',
      message: 'The item could not be moved. The source and destination may be on different drives.',
      recoverable: true
    }
  }
}

export async function renamePath(
  requestedSource: string,
  newName: string
): Promise<ActionResult<{ source: string; destination: string }>> {
  const source = validateAbsolutePath(requestedSource)
  const cleanName = newName.trim()
  if (!source || !cleanName || cleanName !== basename(cleanName) || cleanName.length > 255) {
    return invalidPathResult()
  }
  const destination = join(dirname(source), cleanName)
  return movePath(source, destination)
}

export async function copyFilePath(
  requestedSource: string,
  requestedDestination: string
): Promise<ActionResult<{ source: string; destination: string }>> {
  const source = validateAbsolutePath(requestedSource)
  const destination = validateAbsolutePath(requestedDestination)
  if (!source || !destination) return invalidPathResult()
  if (isProtectedSystemPath(source) || isProtectedSystemPath(destination)) {
    return protectedPathResult()
  }
  try {
    if ((await stat(source)).isDirectory()) {
      return {
        ok: false,
        code: 'DIRECTORY_COPY_UNSUPPORTED',
        message: 'Folder copying is not supported yet.',
        recoverable: true
      }
    }
  } catch {
    return { ok: false, code: 'SOURCE_NOT_FOUND', message: 'The source file was not found.', recoverable: true }
  }
  if (await pathExists(destination)) {
    return { ok: false, code: 'DESTINATION_EXISTS', message: 'The destination already exists.', recoverable: true }
  }

  try {
    await copyFile(source, destination)
    return {
      ok: true,
      message: `${basename(source)} was copied to ${destination}.`,
      data: { source, destination }
    }
  } catch {
    return { ok: false, code: 'COPY_FAILED', message: 'The file could not be copied.', recoverable: true }
  }
}

export async function createDirectoryPath(
  requestedPath: string
): Promise<ActionResult<{ path: string }>> {
  const path = validateAbsolutePath(requestedPath)
  if (!path) return invalidPathResult()
  if (isProtectedSystemPath(path)) return protectedPathResult()
  if (await pathExists(path)) {
    return { ok: false, code: 'PATH_EXISTS', message: 'That path already exists.', recoverable: true }
  }

  try {
    await mkdir(path, { recursive: false })
    return { ok: true, message: `Created the folder ${basename(path)}.`, data: { path } }
  } catch {
    return { ok: false, code: 'CREATE_DIRECTORY_FAILED', message: 'The folder could not be created.', recoverable: true }
  }
}

export async function writeTextFile(
  requestedPath: string,
  content: string,
  overwrite: boolean
): Promise<ActionResult<{ path: string }>> {
  const path = validateAbsolutePath(requestedPath)
  if (!path) return invalidPathResult()
  if (isProtectedSystemPath(path)) return protectedPathResult()

  try {
    await writeFile(path, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx', mode: 0o600 })
    return {
      ok: true,
      message: `${basename(path)} was ${overwrite ? 'updated' : 'created'}.`,
      data: { path }
    }
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    if (code === 'EEXIST') {
      return {
        ok: false,
        code: 'PATH_EXISTS',
        message: 'That file already exists. Request an explicit overwrite to replace it.',
        recoverable: true
      }
    }
    return { ok: false, code: 'WRITE_FAILED', message: 'The file could not be written.', recoverable: true }
  }
}
