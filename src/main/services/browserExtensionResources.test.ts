import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type ExtensionManifest = {
  manifest_version: number
  minimum_chrome_version: string
  permissions: string[]
  host_permissions: string[]
  optional_host_permissions: string[]
  background?: { service_worker?: string; type?: string }
}

describe('Orbit browser extension resources', () => {
  it('uses a minimal Manifest V3 permission set', async () => {
    const root = process.cwd()
    const manifest = JSON.parse(
      await readFile(join(root, 'resources', 'orbit-browser-extension', 'manifest.json'), 'utf8')
    ) as ExtensionManifest

    expect(manifest.manifest_version).toBe(3)
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116)
    expect(manifest.permissions.sort()).toEqual(['scripting', 'storage', 'tabs'])
    expect(manifest.host_permissions).toEqual(['https://www.youtube.com/*'])
    expect(manifest.optional_host_permissions.sort()).toEqual(['http://*/*', 'https://*/*'])
    expect(manifest.background).toEqual({
      service_worker: 'service-worker.js',
      type: 'module'
    })

    const forbidden = [
      'cookies',
      'downloads',
      'debugger',
      'management',
      'webRequest',
      'webRequestBlocking',
      'nativeMessaging',
      'clipboardRead'
    ]
    expect(manifest.permissions.some((permission) => forbidden.includes(permission))).toBe(false)
  })

  it('packages the trusted extension as an Electron extra resource', async () => {
    const builderConfig = await readFile(join(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(builderConfig).toContain('from: resources/orbit-browser-extension')
    expect(builderConfig).toContain('to: orbit-browser-extension')
  })

  it('keeps pairing secrets out of renderer IPC and generic settings', async () => {
    const [preloadSource, browserIpcSource, settingsSource] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main', 'ipc', 'browserHandlers.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main', 'services', 'settingsService.ts'), 'utf8')
    ])
    expect(preloadSource).not.toContain('orbitSecret')
    expect(preloadSource).not.toContain('pairingSecret')
    expect(browserIpcSource).not.toContain('secretBuffer')
    expect(browserIpcSource).not.toContain('orbitSecret')
    expect(settingsSource).not.toContain('browserPairingSecret')
    expect(settingsSource).not.toContain('orbitSecret')
  })

  it('contains no arbitrary JavaScript or Chrome debugger bridge', async () => {
    const source = await readFile(
      join(process.cwd(), 'resources', 'orbit-browser-extension', 'service-worker.js'),
      'utf8'
    )
    expect(source).not.toMatch(/\beval\s*\(/)
    expect(source).not.toMatch(/new\s+Function\s*\(/)
    expect(source).not.toContain('chrome.debugger')
    expect(source).not.toContain('chrome.cookies')
    expect(source).not.toContain('chrome.downloads')
    expect(source).not.toContain('remote-debugging-port')
  })
})
