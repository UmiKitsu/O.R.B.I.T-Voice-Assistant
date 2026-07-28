import { shell } from 'electron'
import {
  access,
  appendFile,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  stat,
  writeFile
} from 'node:fs/promises'
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  parse,
  resolve,
  win32
} from 'node:path'
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

const SAFE_OPEN_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.csv',
  '.json',
  '.log'
])

function isKnownSecretTarget(path: string): boolean {
  const normalized = path.replaceAll('/', '\\').toLocaleLowerCase()
  const name = basename(normalized).toLocaleLowerCase()
  if (
    /(?:^|\\)(?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)(?:\\|$)/.test(normalized) ||
    /(?:^|\\)(?:cookies|login data|web data)(?:$|\\)/.test(normalized)
  ) {
    return true
  }
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..+)?$/.test(name) ||
    /(?:^|[._-])(?:passwords?|credentials?|secrets?|tokens?)(?:[._-]|$)/.test(name) ||
    ['.pem', '.key', '.pfx', '.p12', '.kdbx'].includes(extname(name))
  )
}

function readablePath(requestedPath: string): ActionResult<{ path: string }> {
  const path = validateAbsolutePath(requestedPath)
  if (!path) return invalidPathResult() as ActionResult<{ path: string }>
  if (isProtectedSystemPath(path)) return protectedPathResult() as ActionResult<{ path: string }>
  if (isKnownSecretTarget(path)) {
    return {
      ok: false,
      code: 'SENSITIVE_FILE_BLOCKED',
      message: 'Orbit will not read credential stores, private keys, token files, or known secret targets.',
      recoverable: true
    }
  }
  return { ok: true, message: 'The path is valid.', data: { path } }
}

function appearsBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true
  if (buffer.length === 0) return false
  const decoded = buffer.toString('utf8')
  const replacements = [...decoded].filter((character) => character === '\uFFFD').length
  return replacements > Math.max(2, Math.floor(decoded.length * 0.01))
}

export async function readTextFileBounded(
  requestedPath: string,
  maxBytes = 32_000
): Promise<ActionResult<{ path: string; text: string; truncated: boolean }>> {
  const validated = readablePath(requestedPath)
  if (!validated.ok || !validated.data) {
    return validated as ActionResult<{ path: string; text: string; truncated: boolean }>
  }
  const path = validated.data.path
  const boundedBytes = Math.max(1, Math.min(64_000, Math.trunc(maxBytes)))

  let handle
  try {
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) {
      return {
        ok: false,
        code: 'TEXT_FILE_REQUIRED',
        message: 'The requested path must be a regular text file.',
        recoverable: true
      }
    }
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(Math.min(boundedBytes + 1, Number(details.size) + 1))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const content = buffer.subarray(0, bytesRead)
    if (appearsBinary(content)) {
      return {
        ok: false,
        code: 'BINARY_FILE_BLOCKED',
        message: 'Orbit will not return binary file contents.',
        recoverable: true
      }
    }
    const truncated = bytesRead > boundedBytes || details.size > boundedBytes
    return {
      ok: true,
      message: truncated
        ? `Read the first ${boundedBytes} bytes of ${basename(path)}.`
        : `Read ${basename(path)}.`,
      data: {
        path,
        text: content.subarray(0, boundedBytes).toString('utf8'),
        truncated
      }
    }
  } catch {
    return {
      ok: false,
      code: 'READ_FAILED',
      message: 'The requested text file could not be read.',
      recoverable: true
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function listDirectoryBounded(
  requestedPath: string,
  limit = 100
): Promise<
  ActionResult<{
    path: string
    entries: Array<{ name: string; type: 'file' | 'directory' | 'other'; size?: number }>
    truncated: boolean
  }>
> {
  const validated = readablePath(requestedPath)
  if (!validated.ok || !validated.data) {
    return validated as ActionResult<{
      path: string
      entries: Array<{ name: string; type: 'file' | 'directory' | 'other'; size?: number }>
      truncated: boolean
    }>
  }
  const path = validated.data.path
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  try {
    const details = await lstat(path)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      return { ok: false, code: 'DIRECTORY_REQUIRED', message: 'The requested path must be a directory.', recoverable: true }
    }
    const rawEntries = await readdir(path, { withFileTypes: true })
    const selected = rawEntries.slice(0, boundedLimit)
    const entries = await Promise.all(
      selected.map(async (entry) => {
        const type = entry.isDirectory() ? 'directory' as const : entry.isFile() ? 'file' as const : 'other' as const
        if (type !== 'file') return { name: entry.name.slice(0, 255), type }
        const itemStat = await stat(join(path, entry.name)).catch(() => null)
        return {
          name: entry.name.slice(0, 255),
          type,
          ...(itemStat ? { size: Math.max(0, itemStat.size) } : {})
        }
      })
    )
    return {
      ok: true,
      message: `Listed ${entries.length} items in ${basename(path) || path}.`,
      data: { path, entries, truncated: rawEntries.length > boundedLimit }
    }
  } catch {
    return { ok: false, code: 'LIST_DIRECTORY_FAILED', message: 'The directory could not be listed.', recoverable: true }
  }
}

export async function searchFilesystemBounded(
  requestedRoot: string,
  query: string,
  maxResults = 50,
  maxDepth = 5
): Promise<ActionResult<{ root: string; matches: string[]; truncated: boolean }>> {
  const validated = readablePath(requestedRoot)
  if (!validated.ok || !validated.data) {
    return validated as ActionResult<{ root: string; matches: string[]; truncated: boolean }>
  }
  const root = validated.data.path
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery || normalizedQuery.length > 200) {
    return { ok: false, code: 'INVALID_SEARCH_QUERY', message: 'The file search query is invalid.', recoverable: true }
  }
  const resultLimit = Math.max(1, Math.min(50, Math.trunc(maxResults)))
  const depthLimit = Math.max(0, Math.min(8, Math.trunc(maxDepth)))
  const matches: string[] = []
  let truncated = false

  const visit = async (directory: string, depth: number): Promise<void> => {
    if (matches.length >= resultLimit) {
      truncated = true
      return
    }
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (matches.length >= resultLimit) {
        truncated = true
        return
      }
      const path = join(directory, entry.name)
      if (isKnownSecretTarget(path)) continue
      if (entry.name.toLocaleLowerCase().includes(normalizedQuery)) matches.push(path)
      if (depth < depthLimit && entry.isDirectory() && !entry.isSymbolicLink()) {
        await visit(path, depth + 1)
      }
    }
  }

  try {
    const details = await lstat(root)
    if (!details.isDirectory() || details.isSymbolicLink()) {
      return { ok: false, code: 'DIRECTORY_REQUIRED', message: 'The search root must be a directory.', recoverable: true }
    }
    await visit(root, 0)
    return {
      ok: true,
      message: `Found ${matches.length} matching paths.`,
      data: { root, matches, truncated }
    }
  } catch {
    return { ok: false, code: 'FILESYSTEM_SEARCH_FAILED', message: 'The file search could not be completed.', recoverable: true }
  }
}

export async function getFilesystemMetadata(
  requestedPath: string
): Promise<ActionResult<{ path: string; type: 'file' | 'directory' | 'other'; size: number; createdAt: string; modifiedAt: string }>> {
  const validated = readablePath(requestedPath)
  if (!validated.ok || !validated.data) {
    return validated as ActionResult<{
      path: string
      type: 'file' | 'directory' | 'other'
      size: number
      createdAt: string
      modifiedAt: string
    }>
  }
  const path = validated.data.path
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink()) {
      return { ok: false, code: 'SYMLINK_BLOCKED', message: 'Orbit will not inspect symbolic-link targets.', recoverable: true }
    }
    return {
      ok: true,
      message: `Read metadata for ${basename(path)}.`,
      data: {
        path,
        type: details.isFile() ? 'file' : details.isDirectory() ? 'directory' : 'other',
        size: Math.max(0, details.size),
        createdAt: details.birthtime.toISOString(),
        modifiedAt: details.mtime.toISOString()
      }
    }
  } catch {
    return { ok: false, code: 'METADATA_FAILED', message: 'The path metadata could not be read.', recoverable: true }
  }
}

export async function openFileReadOnly(
  requestedPath: string
): Promise<ActionResult<{ path: string }>> {
  const validated = readablePath(requestedPath)
  if (!validated.ok || !validated.data) return validated
  const path = validated.data.path
  if (!SAFE_OPEN_EXTENSIONS.has(extname(path).toLocaleLowerCase())) {
    return {
      ok: false,
      code: 'READ_ONLY_FILE_TYPE_BLOCKED',
      message: 'Orbit opens only known document, text, and image formats through read-only file access.',
      recoverable: true
    }
  }
  try {
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) throw new Error('invalid')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return { ok: true, message: `Opened ${basename(path)}.`, data: { path } }
  } catch {
    return { ok: false, code: 'OPEN_FILE_FAILED', message: 'The file could not be opened.', recoverable: true }
  }
}

export async function navigateFolderReadOnly(
  requestedPath: string
): Promise<ActionResult<{ path: string }>> {
  const validated = readablePath(requestedPath)
  if (!validated.ok || !validated.data) return validated
  const path = validated.data.path
  try {
    const details = await lstat(path)
    if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('invalid')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return { ok: true, message: `Opened ${basename(path) || path}.`, data: { path } }
  } catch {
    return { ok: false, code: 'OPEN_FOLDER_FAILED', message: 'The folder could not be opened.', recoverable: true }
  }
}

export async function appendTextFile(
  requestedPath: string,
  content: string
): Promise<ActionResult<{ path: string }>> {
  const path = validateAbsolutePath(requestedPath)
  if (!path) return invalidPathResult()
  if (isProtectedSystemPath(path) || isKnownSecretTarget(path)) return protectedPathResult()
  try {
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink()) {
      return { ok: false, code: 'TEXT_FILE_REQUIRED', message: 'The target must be an existing regular text file.', recoverable: true }
    }
    const probe = await readTextFileBounded(path, 4_096)
    if (!probe.ok) return probe
    await appendFile(path, content, { encoding: 'utf8' })
    return { ok: true, message: `Appended text to ${basename(path)}.`, data: { path } }
  } catch {
    return { ok: false, code: 'APPEND_FAILED', message: 'The text could not be appended.', recoverable: true }
  }
}
