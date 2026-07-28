import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCapabilityRuntime } from './capabilityRuntime'
import { MAX_EXTERNAL_URL_LENGTH, validateExternalUrl } from '../services/browserService'
import { resolveApplication } from '../services/applicationDiscoveryService'
import type { PolicyEngine, PolicyResult } from '../security/policyEngine'

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() }
}))

const now = new Date(2026, 6, 27, 2, 30, 0)
const openExternalUrl = vi.fn(async () => undefined)
const sendMediaKey = vi.fn(() => true)
const setAudioMuted = vi.fn(async () => undefined)
const setAudioVolume = vi.fn(async () => undefined)
const launchApplication = vi.fn(async () => undefined)

function runtime(): PolicyEngine {
  return createCapabilityRuntime({
    now: () => new Date(now),
    openExternalUrl,
    sendMediaKey,
    setAudioMuted,
    setAudioVolume,
    launchApplication
  })
}

async function execute(capability: string, parameters: unknown = {}): Promise<PolicyResult> {
  return runtime().evaluateAndExecute({ capability, parameters, summary: capability })
}

describe('Phase 11 capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads time and date from the injected system clock', async () => {
    const time = await execute('system.getTime')
    const date = await execute('system.getDate')

    expect(time).toMatchObject({
      status: 'executed',
      result: { ok: true, data: { isoTime: now.toISOString() } }
    })
    expect(date).toMatchObject({
      status: 'executed',
      result: { ok: true, data: { isoDate: '2026-07-27' } }
    })
  })

  it('opens only validated HTTP(S) URLs without credentials', async () => {
    await expect(
      execute('browser.openUrl', { url: 'https://www.youtube.com' })
    ).resolves.toMatchObject({ status: 'executed', result: { ok: true } })
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.youtube.com/')

    for (const url of [
      'file:///C:/secret.txt',
      'javascript:alert(1)',
      'data:text/plain,test',
      'https://user:password@example.com',
      'ftp://example.com',
      'https://example.com/\nscript:run'
    ]) {
      await expect(execute('browser.openUrl', { url })).resolves.toMatchObject({
        status: 'invalid-parameters'
      })
    }

    expect(
      validateExternalUrl(`https://example.com/${'a'.repeat(MAX_EXTERNAL_URL_LENGTH)}`)
    ).toBeNull()
  })

  it('constructs web and YouTube search URLs inside the executor', async () => {
    await execute('browser.searchWeb', { query: 'Electron security & IPC' })
    await execute('browser.searchYouTube', { query: 'TypeScript tutorials' })

    expect(openExternalUrl).toHaveBeenNthCalledWith(
      1,
      'https://www.google.com/search?q=Electron%20security%20%26%20IPC'
    )
    expect(openExternalUrl).toHaveBeenNthCalledWith(
      2,
      'https://www.youtube.com/results?search_query=TypeScript%20tutorials'
    )
  })

  it('opens YouTube results but reports unverified playback while disconnected', async () => {
    await expect(
      execute('youtube.playSearch', { query: 'Bohemian Rhapsody' })
    ).resolves.toMatchObject({
      status: 'executed',
      result: {
        ok: false,
        code: 'BROWSER_EXTENSION_DISCONNECTED',
        recoverable: true
      }
    })
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://www.youtube.com/results?search_query=Bohemian%20Rhapsody'
    )
  })

  it.each([
    'youtube.play',
    'youtube.pause',
    'youtube.next',
    'youtube.previous'
  ])('registers %s without falling back to Windows media keys', async (capability) => {
    await expect(execute(capability)).resolves.toMatchObject({
      status: 'executed',
      result: { ok: false, code: 'BROWSER_CONTROL_DISABLED', recoverable: true }
    })
    expect(sendMediaKey).not.toHaveBeenCalled()
  })

  it('does not silently fall back for controlled-tab-only actions', async () => {
    await expect(execute('browser.newTab')).resolves.toMatchObject({
      status: 'executed',
      result: { ok: false, code: 'BROWSER_CONTROL_DISABLED', recoverable: true }
    })
  })

  it.each([
    ['media.playPause', 'playPause'],
    ['media.next', 'next'],
    ['media.previous', 'previous'],
    ['audio.volumeUp', 'volumeUp'],
    ['audio.volumeDown', 'volumeDown']
  ] as const)('maps %s to one fixed Windows media action', async (capability, action) => {
    await expect(execute(capability)).resolves.toMatchObject({
      status: 'executed',
      result: { ok: true }
    })
    expect(sendMediaKey).toHaveBeenCalledWith(action)
  })

  it('sets an exact validated volume percentage', async () => {
    await expect(execute('audio.setVolume', { volume: 30 })).resolves.toMatchObject({
      status: 'executed',
      result: { ok: true, message: 'Volume set to 30 percent.' }
    })
    expect(setAudioVolume).toHaveBeenCalledWith(30)

    await expect(execute('audio.setVolume', { volume: 101 })).resolves.toMatchObject({
      status: 'invalid-parameters'
    })
  })

  it.each([
    ['audio.mute', true],
    ['audio.unmute', false]
  ] as const)('sets an explicit audio mute state for %s', async (capability, muted) => {
    await expect(execute(capability)).resolves.toMatchObject({
      status: 'executed',
      result: { ok: true }
    })
    expect(setAudioMuted).toHaveBeenCalledWith(muted)
    expect(sendMediaKey).not.toHaveBeenCalled()
  })

  it('launches built-in and dynamically discovered applications only after resolution', async () => {
    await expect(
      execute('application.launch', { application: 'calculator' })
    ).resolves.toMatchObject({
      status: 'executed',
      result: { ok: true, data: { application: 'calculator' } }
    })
    expect(launchApplication).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'calculator', executable: 'calc.exe' })
    )

    await expect(
      execute('application.launch', { application: 'Definitely Not Installed Orbit Test App' })
    ).resolves.toMatchObject({
      status: 'executed',
      result: { ok: false, code: 'APPLICATION_NOT_FOUND' }
    })
    expect(launchApplication).toHaveBeenCalledTimes(1)
  })

  it('always resolves the two fixed built-in application mappings', () => {
    expect(resolveApplication('calc')).toMatchObject({ id: 'calculator', executable: 'calc.exe' })
    expect(resolveApplication('file explorer')).toMatchObject({
      id: 'explorer',
      executable: 'explorer.exe'
    })
  })
})
