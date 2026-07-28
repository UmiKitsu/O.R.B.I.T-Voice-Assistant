import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type ExtensionManifest = {
  manifest_version: number
  minimum_chrome_version: string
  permissions: string[]
  host_permissions: string[]
  optional_host_permissions: string[]
  version: string
  background?: { service_worker?: string; type?: string }
  action?: { default_popup?: string }
}

describe('Orbit browser extension resources', () => {
  it('uses a minimal Manifest V3 permission set', async () => {
    const root = process.cwd()
    const manifest = JSON.parse(
      await readFile(join(root, 'resources', 'orbit-browser-extension', 'manifest.json'), 'utf8')
    ) as ExtensionManifest

    expect(manifest.manifest_version).toBe(3)
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(116)
    expect(manifest.permissions.sort()).toEqual(['alarms', 'scripting', 'storage', 'tabs'])
    expect(manifest.host_permissions).toEqual([
      'http://127.0.0.1/*',
      'https://www.youtube.com/*'
    ])
    expect(manifest.optional_host_permissions.sort()).toEqual(['http://*/*', 'https://*/*'])
    expect(manifest.background).toEqual({
      service_worker: 'service-worker.js',
      type: 'module'
    })
    expect(manifest.version).toBe('1.1.1')
    expect(manifest.action?.default_popup).toBe('popup.html')

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

  it('uses durable lifecycle retries and an exact-origin toolbar permission UI', async () => {
    const root = join(process.cwd(), 'resources', 'orbit-browser-extension')
    const [worker, controls, popupHtml, popupSource, optionsSource] = await Promise.all([
      readFile(join(root, 'service-worker.js'), 'utf8'),
      readFile(join(root, 'youtube-controls.js'), 'utf8'),
      readFile(join(root, 'popup.html'), 'utf8'),
      readFile(join(root, 'popup.js'), 'utf8'),
      readFile(join(root, 'options.js'), 'utf8')
    ])

    expect(worker).toContain("const RETRY_DELAYS_MS = [30000, 60000, 120000, 300000]")
    expect(worker).toContain('chrome.alarms.create')
    expect(worker).toContain('chrome.alarms.onAlarm.addListener')
    expect(worker).toContain("requestConnection('authenticated-disconnect')")
    expect(worker).toContain('let connectionAttempt = null')
    expect(worker).toContain('function orderedPorts(savedPort)')
    expect(worker).toContain('async function requireActiveWebTab()')
    expect(worker).toContain('async function getGrantedOriginAllowlist()')
    expect(worker).toContain('allowed.includes(parsed.origin)')
    expect(worker).toContain('chrome.tabs.query({ active: true, currentWindow: true })')
    expect(worker).toContain('AUTHENTICATED_CONTACT_TIMEOUT_MS = 60000')
    expect(worker).toContain('orbitPairingConfirmed: false')
    expect(worker).toContain("setLifecycle('connected'")
    expect(worker).toContain("failure('YOUTUBE_TAB_CLOSED'")
    expect(controls).toContain('YOUTUBE_SPA_NAVIGATION_TIMEOUT')
    expect(controls).toContain('YOUTUBE_TARGET_CHANGED')
    expect(popupHtml).toContain('Grant this site')
    expect(popupHtml).toContain('Revoke this site')
    expect(popupSource).toContain('chrome.tabs.query({ active: true, currentWindow: true })')
    expect(popupSource).toContain('chrome.permissions.request({ origins: [activePattern] })')
    expect(popupSource).toContain('chrome.permissions.remove({ origins: [activePattern] })')
    expect(popupSource).toContain("type: 'site-granted'")
    expect(popupSource).toContain("type: 'site-revoked'")
    expect(optionsSource).not.toContain('grant-site')
    expect(optionsSource).not.toContain('chrome.tabs.query')

    for (const visiblePageSource of [popupSource, optionsSource]) {
      expect(visiblePageSource).toContain("const ACCESS_PROBE_PATH = '/orbit-browser-v1/access'")
      expect(visiblePageSource).toContain('async function probeLocalNetworkAccess(port)')
      expect(visiblePageSource).toContain("cache: 'no-store'")
      expect(visiblePageSource).toContain(
        "Orbit must be open and Chrome's Local Network Access permission must be allowed."
      )
      const retryHandler = visiblePageSource.indexOf("retryButton.addEventListener('click'")
      const retryProbe = visiblePageSource.indexOf('await probeLocalNetworkAccess(', retryHandler)
      const retryRequest = visiblePageSource.indexOf("type: 'retry-connection'", retryHandler)
      expect(retryHandler).toBeGreaterThanOrEqual(0)
      expect(retryProbe).toBeGreaterThan(retryHandler)
      expect(retryRequest).toBeGreaterThan(retryProbe)
      expect(visiblePageSource.indexOf("type: 'get-status'", retryHandler)).toBe(-1)
    }

    const pairHandler = optionsSource.indexOf("pairButton.addEventListener('click'")
    const pairProbe = optionsSource.indexOf('await probeLocalNetworkAccess(port)', pairHandler)
    const pairRequest = optionsSource.indexOf("type: 'pair', port, code", pairHandler)
    expect(pairProbe).toBeGreaterThan(pairHandler)
    expect(pairRequest).toBeGreaterThan(pairProbe)

    const closeCodeBlock = worker.slice(
      worker.indexOf('const CLIENT_CLOSE_CODE = Object.freeze({'),
      worker.indexOf('const EXTENSION_ORIGIN =')
    )
    const clientCloseCodes = [...closeCodeBlock.matchAll(/:\s*(\d{4})[,\n]/g)].map((match) =>
      Number(match[1])
    )
    expect(clientCloseCodes.length).toBeGreaterThan(0)
    expect(clientCloseCodes.every((code) => code >= 4000 && code <= 4999)).toBe(true)
    expect(worker).not.toMatch(/\.close\(\s*(?:1002|1003|1008|1011)\b/)
    expect(worker).not.toMatch(/\.close\(\s*\d{4}\b/)
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
