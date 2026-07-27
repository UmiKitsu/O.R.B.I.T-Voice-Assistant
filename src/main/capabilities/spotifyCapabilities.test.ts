import { describe, expect, it, vi } from 'vitest'
import type { ForegroundTarget } from '../security/protectedTargets'
import type { SpotifyPlaybackController } from '../services/spotifyService'
import type { PolicyResult } from '../security/policyEngine'
import { createCapabilityRuntime } from './capabilityRuntime'

const target: ForegroundTarget = {
  windowHandle: 7,
  title: 'Bruno Mars ? Spotify',
  className: 'Chrome_WidgetWin_0',
  processName: 'Spotify.exe',
  focusedClassName: 'Chrome_RenderWidgetHostHWND',
  isPasswordField: false
}

const controller: SpotifyPlaybackController = {
  findWindow: vi.fn(() => 7),
  getForegroundTarget: vi.fn(() => target),
  show: vi.fn(() => true),
  activate: vi.fn(() => true),
  focusSpotifySearch: vi.fn(() => true),
  typeUnicodeText: vi.fn(() => true),
  chooseSpotifyTopResult: vi.fn(() => true),
  pressEnter: vi.fn(() => true)
}

function execute(parameters: unknown): Promise<PolicyResult> {
  return createCapabilityRuntime({
    spotifyController: controller,
    spotifyDelay: vi.fn(async () => undefined)
  }).evaluateAndExecute({
    capability: 'spotify.playSearch',
    parameters,
    summary: 'Play Spotify result'
  })
}

describe('Spotify capability', () => {
  it('executes a validated plain-text query automatically', async () => {
    await expect(execute({ query: 'Bruno Mars' })).resolves.toMatchObject({
      status: 'executed',
      result: { ok: true, data: { application: 'spotify', query: 'Bruno Mars' } }
    })
  })

  it.each([
    {},
    { query: '' },
    { query: 'x'.repeat(201) },
    { query: 'Bruno\nMars' },
    { query: 'Bruno Mars', command: 'powershell.exe' }
  ])('rejects invalid or executable parameter shapes', async (parameters) => {
    await expect(execute(parameters)).resolves.toMatchObject({ status: 'invalid-parameters' })
  })
})
