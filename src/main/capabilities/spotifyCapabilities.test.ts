import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  getProcessAgeMs: vi.fn(() => 20_000),
  show: vi.fn(() => true),
  activate: vi.fn(() => true),
  focusSpotifySearch: vi.fn(() => true),
  selectAllText: vi.fn(() => true),
  typeUnicodeText: vi.fn(() => true),
  pressTab: vi.fn(() => true),
  pressEnter: vi.fn(() => true)
}

let currentTime = 0

function execute(parameters: unknown): Promise<PolicyResult> {
  return createCapabilityRuntime({
    spotifyController: controller,
    spotifyDelay: vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds
    }),
    spotifyNow: () => currentTime
  }).evaluateAndExecute({
    capability: 'spotify.playSearch',
    parameters,
    summary: 'Play Spotify result'
  })
}

describe('Spotify capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentTime = 0
    vi.mocked(controller.findWindow).mockReturnValue(7)
    vi.mocked(controller.getForegroundTarget).mockReturnValue(target)
    vi.mocked(controller.getProcessAgeMs).mockReturnValue(20_000)
    vi.mocked(controller.show).mockReturnValue(true)
    vi.mocked(controller.activate).mockReturnValue(true)
    vi.mocked(controller.focusSpotifySearch).mockReturnValue(true)
    vi.mocked(controller.selectAllText).mockReturnValue(true)
    vi.mocked(controller.typeUnicodeText).mockReturnValue(true)
    vi.mocked(controller.pressTab).mockReturnValue(true)
    vi.mocked(controller.pressEnter).mockReturnValue(true)
  })

  it('executes a validated plain-text query with track intent by default', async () => {
    await expect(execute({ query: 'Bruno Mars' })).resolves.toMatchObject({
      status: 'executed',
      result: { ok: true, data: { application: 'spotify', query: 'Bruno Mars' } }
    })
    expect(controller.pressTab).toHaveBeenCalledOnce()
  })

  it('accepts artist intent and validates the dedicated Artist Play result', async () => {
    await expect(execute({ query: 'Bruno Mars', intent: 'artist' })).resolves.toMatchObject({
      status: 'executed',
      result: {
        ok: true,
        data: { method: 'desktop-artist', verification: 'activated' }
      }
    })
    expect(controller.pressTab).toHaveBeenCalledTimes(2)
    expect(controller.pressEnter).toHaveBeenCalledTimes(2)
  })

  it.each([
    {},
    { query: '' },
    { query: 'x'.repeat(201) },
    { query: 'Bruno\nMars' },
    { query: 'Bruno Mars', intent: 'album' },
    { query: 'Bruno Mars', intent: 'track', command: 'powershell.exe' }
  ])('rejects invalid or executable parameter shapes', async (parameters) => {
    await expect(execute(parameters)).resolves.toMatchObject({ status: 'invalid-parameters' })
  })
})
