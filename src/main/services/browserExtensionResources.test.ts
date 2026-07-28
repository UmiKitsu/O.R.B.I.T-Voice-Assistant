import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ORBIT_APP_ID,
  ORBIT_BROWSER_EXTENSION_ID,
  ORBIT_BROWSER_EXTENSION_ORIGIN,
  ORBIT_BROWSER_EXTENSION_PUBLIC_KEY,
  ORBIT_BROWSER_PAIRING_FILE_NAME,
  ORBIT_PACKAGE_NAME
} from './browserBridgeCompatibility'

type ExtensionManifest = {
  manifest_version: number
  minimum_chrome_version: string
  permissions: string[]
  host_permissions: string[]
  optional_host_permissions: string[]
  version: string
  key: string
  background?: { service_worker?: string; type?: string }
  action?: { default_popup?: string }
}

function deriveChromeExtensionId(publicKeyBase64: string): string {
  const digest = createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest()
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('')
}

describe('Orbit browser extension resources', () => {
  it('uses a fixed public manifest key that always derives the permanent extension ID', async () => {
    const manifest = JSON.parse(
      await readFile(
        join(process.cwd(), 'resources', 'orbit-browser-extension', 'manifest.json'),
        'utf8'
      )
    ) as ExtensionManifest

    expect(manifest.key).toBe(ORBIT_BROWSER_EXTENSION_PUBLIC_KEY)
    expect(deriveChromeExtensionId(manifest.key)).toBe(ORBIT_BROWSER_EXTENSION_ID)
    expect(ORBIT_BROWSER_EXTENSION_ORIGIN).toBe(
      `chrome-extension://${ORBIT_BROWSER_EXTENSION_ID}`
    )
  })

  it('uses a minimal Manifest V3 permission set', async () => {
    const manifest = JSON.parse(
      await readFile(
        join(process.cwd(), 'resources', 'orbit-browser-extension', 'manifest.json'),
        'utf8'
      )
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
    expect(manifest.version).toBe('1.2.0')
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

  it('keeps app identity and pairing location as explicit compatibility identifiers', async () => {
    const [packageSource, builderConfig, serviceSource] = await Promise.all([
      readFile(join(process.cwd(), 'package.json'), 'utf8'),
      readFile(join(process.cwd(), 'electron-builder.yml'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main', 'services', 'browserBridgeService.ts'), 'utf8')
    ])
    const packageJson = JSON.parse(packageSource) as { name: string }

    expect(packageJson.name).toBe(ORBIT_PACKAGE_NAME)
    expect(builderConfig).toContain(`appId: ${ORBIT_APP_ID}`)
    expect(serviceSource).toContain("app.getPath('userData')")
    expect(serviceSource).toContain('ORBIT_BROWSER_PAIRING_FILE_NAME')
    expect(ORBIT_BROWSER_PAIRING_FILE_NAME).toBe('orbit-browser-pairing.bin')
    expect(serviceSource).toContain('await rename(temporaryPath, pairingFilePath)')
    expect(builderConfig).toContain('from: resources/orbit-browser-extension')
    expect(builderConfig).toContain('to: orbit-browser-extension')
  })

  it('keeps pairing secrets out of renderer IPC, generic settings, logs, and conversation state', async () => {
    const [preloadSource, browserIpcSource, settingsSource, loggerSource] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main', 'ipc', 'browserHandlers.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main', 'services', 'settingsService.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main', 'services', 'loggerService.ts'), 'utf8')
    ])
    expect(preloadSource).not.toContain('orbitSecret')
    expect(preloadSource).not.toContain('pairingSecret')
    expect(browserIpcSource).not.toContain('secretBuffer')
    expect(browserIpcSource).not.toContain('orbitSecret')
    expect(settingsSource).not.toContain('browserPairingSecret')
    expect(settingsSource).not.toContain('orbitSecret')
    expect(loggerSource).not.toContain('orbitSecret')
  })

  it('uses durable local pairing storage, temporary session state, and silent update reconnects', async () => {
    const root = join(process.cwd(), 'resources', 'orbit-browser-extension')
    const [worker, storageSource, lifecycleSource, optionsHtml, optionsSource] = await Promise.all([
      readFile(join(root, 'service-worker.js'), 'utf8'),
      readFile(join(root, 'pairing-storage.js'), 'utf8'),
      readFile(join(root, 'extension-lifecycle.js'), 'utf8'),
      readFile(join(root, 'options.html'), 'utf8'),
      readFile(join(root, 'options.js'), 'utf8')
    ])

    expect(worker).toContain('chrome.storage.local.get(DURABLE_PAIRING_KEYS)')
    expect(worker).toContain('chrome.storage.session.get')
    expect(worker).toContain('chrome.storage.session.set')
    expect(worker).not.toContain('chrome.storage.local.clear')
    expect(worker.match(/chrome\.storage\.local\.remove\(DURABLE_PAIRING_KEYS\)/g)).toHaveLength(1)
    expect(storageSource).toContain("'orbitSecret'")
    expect(storageSource).toContain("kind: 'unreadable'")
    expect(lifecycleSource).toContain("openOptions: reason === 'install'")
    expect(worker).toContain('getInstalledLifecycle(details.reason)')
    expect(worker).toContain('if (lifecycle.openOptions) void chrome.runtime.openOptionsPage()')
    expect(worker).not.toContain('chrome.runtime.onInstalled.addListener(() =>')
    expect(optionsHtml).toContain(
      'Paired—reconnects automatically after updates and restarts.'
    )
    expect(optionsSource).toContain('pairingSetup.hidden = paired')
    expect(optionsSource).toContain('pairedSummary.hidden = !paired')
  })

  it('uses authenticated symmetric forgetting and prevents accidental second pairing', async () => {
    const worker = await readFile(
      join(process.cwd(), 'resources', 'orbit-browser-extension', 'service-worker.js'),
      'utf8'
    )
    const service = await readFile(
      join(process.cwd(), 'src', 'main', 'services', 'browserBridgeService.ts'),
      'utf8'
    )

    for (const source of [worker, service]) {
      expect(source).toContain('forget_pairing_request')
      expect(source).toContain('forget_pairing_ack')
      expect(source).toContain('forget-request-orbit')
      expect(source).toContain('forget-request-extension')
    }
    expect(worker).toContain('This extension is already paired')
    expect(service).toContain('Orbit is already paired')
    expect(worker).toContain('could not acknowledge it')
    expect(service).toContain('could not acknowledge it')
  })

  it('uses durable retries and an exact-origin toolbar permission UI', async () => {
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
    expect(worker).toContain('function orderedPorts(savedPort)')
    expect(worker).toContain('async function getGrantedOriginAllowlist()')
    expect(worker).toContain('AUTHENTICATED_CONTACT_TIMEOUT_MS = 60000')
    expect(worker).toContain("setLifecycle('connected'")
    expect(worker).toContain("failure('YOUTUBE_TAB_CLOSED'")
    expect(controls).toContain('YOUTUBE_SPA_NAVIGATION_TIMEOUT')
    expect(controls).toContain('YOUTUBE_TARGET_CHANGED')
    expect(popupHtml).toContain('Grant this site')
    expect(popupHtml).toContain('Revoke this site')
    expect(popupSource).toContain('chrome.tabs.query({ active: true, currentWindow: true })')
    expect(popupSource).toContain('chrome.permissions.request({ origins: [activePattern] })')
    expect(popupSource).toContain('chrome.permissions.remove({ origins: [activePattern] })')
    expect(optionsSource).not.toContain('chrome.tabs.query')

    for (const visiblePageSource of [popupSource, optionsSource]) {
      expect(visiblePageSource).toContain("const ACCESS_PROBE_PATH = '/orbit-browser-v1/access'")
      expect(visiblePageSource).toContain('async function probeLocalNetworkAccess(port)')
      expect(visiblePageSource).toContain("cache: 'no-store'")
    }

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
