import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getFilesystemMetadata,
  listDirectoryBounded,
  readTextFileBounded,
  searchFilesystemBounded
} from './filesystemService'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orbit-filesystem-test-'))
})

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})

describe('bounded filesystem read operations', () => {
  it('reads only the exact requested text file and reports truncation', async () => {
    const path = join(root, 'notes.txt')
    await writeFile(path, 'abcdefghij', 'utf8')

    await expect(readTextFileBounded(path, 5)).resolves.toMatchObject({
      ok: true,
      data: { path, text: 'abcde', truncated: true }
    })
  })

  it('rejects binary and known credential or private-key targets', async () => {
    const binary = join(root, 'image.bin')
    const environment = join(root, '.env')
    const sshDirectory = join(root, '.ssh')
    const privateKey = join(sshDirectory, 'id_rsa')
    await writeFile(binary, Buffer.from([0, 1, 2, 3]))
    await writeFile(environment, 'TOKEN=secret', 'utf8')
    await mkdir(sshDirectory)
    await writeFile(privateKey, 'private-key', 'utf8')

    await expect(readTextFileBounded(binary)).resolves.toMatchObject({
      ok: false,
      code: 'BINARY_FILE_BLOCKED'
    })
    await expect(readTextFileBounded(environment)).resolves.toMatchObject({
      ok: false,
      code: 'SENSITIVE_FILE_BLOCKED'
    })
    await expect(readTextFileBounded(privateKey)).resolves.toMatchObject({
      ok: false,
      code: 'SENSITIVE_FILE_BLOCKED'
    })
  })

  it('bounds directory listings and filename search results', async () => {
    await Promise.all([
      writeFile(join(root, 'report-one.txt'), 'one', 'utf8'),
      writeFile(join(root, 'report-two.txt'), 'two', 'utf8'),
      writeFile(join(root, 'other.txt'), 'other', 'utf8')
    ])
    const secretDirectory = join(root, '.ssh')
    await mkdir(secretDirectory)
    await writeFile(join(secretDirectory, 'report-secret.txt'), 'secret', 'utf8')

    await expect(listDirectoryBounded(root, 2)).resolves.toMatchObject({
      ok: true,
      data: { path: root, truncated: true }
    })

    const search = await searchFilesystemBounded(root, 'report', 10, 4)
    expect(search).toMatchObject({ ok: true, data: { root, truncated: false } })
    if (!search.ok || !search.data) throw new Error('Expected a successful search result.')
    expect(search.data.matches).toEqual(
      expect.arrayContaining([join(root, 'report-one.txt'), join(root, 'report-two.txt')])
    )
    expect(search.data.matches.some((path) => path.includes('.ssh'))).toBe(false)
  })

  it('returns metadata without reading file contents', async () => {
    const path = join(root, 'metadata.txt')
    await writeFile(path, 'private contents are not returned', 'utf8')

    const result = await getFilesystemMetadata(path)
    expect(result).toMatchObject({
      ok: true,
      data: { path, type: 'file', size: 33 }
    })
    expect(JSON.stringify(result)).not.toContain('private contents')
  })
})
