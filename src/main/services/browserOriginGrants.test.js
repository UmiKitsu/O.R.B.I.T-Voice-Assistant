import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('browser protocol v3 global website access', () => {
  it('removes per-origin grant storage and toolbar grant controls', async () => {
    const root = join(process.cwd(), 'resources', 'orbit-browser-extension')
    const [manifestSource, worker, popupHtml, popupSource, optionsSource, legacyModule] =
      await Promise.all([
        readFile(join(root, 'manifest.json'), 'utf8'),
        readFile(join(root, 'service-worker.js'), 'utf8'),
        readFile(join(root, 'popup.html'), 'utf8'),
        readFile(join(root, 'popup.js'), 'utf8'),
        readFile(join(root, 'options.js'), 'utf8'),
        readFile(join(root, 'origin-grants.js'), 'utf8')
      ])
    const manifest = JSON.parse(manifestSource)

    expect(manifest.host_permissions.sort()).toEqual(['http://*/*', 'https://*/*'])
    expect(manifest.optional_host_permissions).toBeUndefined()
    expect(worker).not.toContain("from './origin-grants.js'")
    expect(worker).not.toContain('getGrantedOriginAllowlist')
    expect(worker).not.toContain('setGrantedOrigin')
    expect(worker).not.toContain("message?.type === 'site-granted'")
    expect(worker).not.toContain("message?.type === 'site-revoked'")
    expect(worker).toContain("chrome.storage.local.remove(['orbitGrantedOrigins', 'orbitOriginAllowlistMigrated'])")
    expect(popupHtml).not.toContain('Grant this site')
    expect(popupHtml).not.toContain('Revoke this site')
    expect(popupSource).not.toContain('chrome.permissions.request')
    expect(popupSource).not.toContain('chrome.permissions.remove')
    expect(optionsSource).not.toContain('grantedOrigins')
    expect(legacyModule).toContain('Per-origin grants were removed')
  })
})
