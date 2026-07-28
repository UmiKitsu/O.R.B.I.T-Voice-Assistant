import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverShortcutApplications } from './applicationDiscoveryService'

let temporaryRoot: string | null = null

afterEach(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = null
})

describe('application shortcut discovery', () => {
  it('normalizes a Roblox Player shortcut so a Roblox request can match it', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'orbit-app-discovery-'))
    const shortcut = join(temporaryRoot, 'Roblox Player.lnk')
    await writeFile(shortcut, '')

    expect(discoverShortcutApplications([temporaryRoot])).toContainEqual(
      expect.objectContaining({
        displayName: 'Roblox Player',
        executable: 'explorer.exe',
        args: [shortcut],
        aliases: expect.arrayContaining(['roblox player', 'roblox'])
      })
    )
  })
})
