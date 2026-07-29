import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopElement, DesktopWindowSnapshot } from '../../shared/types'
import type { ForegroundTarget } from '../security/protectedTargets'
import type { SpotifyPlaybackController } from '../services/spotifyService'
import type { PolicyResult } from '../security/policyEngine'
import { createCapabilityRegistry, createCapabilityRuntime } from './capabilityRuntime'

const target: ForegroundTarget = {
  windowHandle: 7,
  title: 'Spotify Premium',
  className: 'Chrome_WidgetWin_0',
  processName: 'Spotify.exe',
  focusedClassName: 'Chrome_RenderWidgetHostHWND',
  isPasswordField: false
}

type SpotifyControllerProbe = SpotifyPlaybackController & {
  pressTab(): boolean
  pressEnter(): boolean
}

const controller: SpotifyControllerProbe = {
  findWindow: vi.fn(() => 7),
  getForegroundTarget: vi.fn(() => target),
  getProcessAgeMs: vi.fn(() => 20_000),
  show: vi.fn(() => true),
  activate: vi.fn(() => true),
  focusSpotifySearch: vi.fn(() => true),
  selectAllText: vi.fn(() => true),
  typeUnicodeText: vi.fn(() => true),
  playSpotifySelectedResult: vi.fn(() => true),
  pressTab: vi.fn(() => true),
  pressEnter: vi.fn(() => true)
}

function element(
  ref: string,
  name: string,
  patterns: DesktopElement['patterns'] = ['invoke']
): DesktopElement {
  return {
    ref,
    role: 'Button',
    name,
    enabled: true,
    offscreen: false,
    bounds: { x: 0, y: 0, width: 100, height: 30 },
    patterns
  }
}

function snapshot(elements: DesktopElement[]): DesktopWindowSnapshot {
  return {
    windowTitle: 'Spotify Premium',
    processName: 'Spotify.exe',
    capturedAt: Date.now(),
    treeVersion: 'tree',
    truncated: false,
    elements
  }
}

let currentTime = 0

function execute(parameters: unknown): Promise<PolicyResult> {
  const isArtist =
    typeof parameters === 'object' &&
    parameters !== null &&
    'intent' in parameters &&
    parameters.intent === 'artist'
  const inspectDesktopWindow = isArtist
    ? vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          message: 'Results.',
          data: snapshot([element('artist-ref', 'Bruno Mars, Artist')])
        })
        .mockResolvedValueOnce({
          ok: true,
          message: 'Artist page.',
          data: snapshot([element('heading-ref', 'Bruno Mars', []), element('play-ref', 'Play')])
        })
    : vi.fn(async () => ({
        ok: true as const,
        message: 'Results.',
        data: snapshot([element('track-ref', 'Bruno Mars')])
      }))

  return createCapabilityRuntime({
    spotifyController: controller,
    spotifyDelay: vi.fn(async (milliseconds: number) => {
      currentTime += milliseconds
    }),
    spotifyNow: () => currentTime,
    spotifyInspectDesktopWindow: inspectDesktopWindow,
    spotifyPerformDesktopAction: vi.fn(async (action, ref) => ({
      ok: true as const,
      message: 'Activated.',
      data: { name: ref, role: 'Button', action }
    })),
    spotifyReadMediaSession: vi.fn(async () => ({
      ok: true as const,
      message: 'Playing.',
      data: {
        sourceApplication: 'Spotify.exe',
        playbackStatus: 'playing' as const,
        title: isArtist ? '24K Magic' : 'Bruno Mars',
        artist: 'Bruno Mars'
      }
    })),
    spotifyInspectVisually: vi.fn(async () => ({
      ok: false as const,
      code: 'VISION_UNAVAILABLE',
      message: 'Unavailable.',
      recoverable: true
    })),
    spotifySettings: () => ({
      spotifyClientId: '',
      spotifyPlaybackMode: 'desktop',
      musicFallbackEnabled: false
    })
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
    vi.mocked(controller.playSpotifySelectedResult).mockReturnValue(true)
  })

  it('uses a twenty-second capability budget', () => {
    expect(createCapabilityRegistry().get('spotify.playSearch')?.timeoutMs).toBe(20_000)
    expect(createCapabilityRegistry().get('music.playSearch')?.timeoutMs).toBe(20_000)
  })

  it('executes a validated plain-text track query with verified desktop data', async () => {
    await expect(execute({ query: 'Bruno Mars' })).resolves.toMatchObject({
      status: 'executed',
      result: {
        ok: true,
        data: {
          application: 'spotify',
          query: 'Bruno Mars',
          method: 'desktop',
          verification: 'playing'
        }
      }
    })
    expect(controller.pressTab).not.toHaveBeenCalled()
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })

  it('accepts artist intent and validates verified Artist Play data', async () => {
    await expect(execute({ query: 'Bruno Mars', intent: 'artist' })).resolves.toMatchObject({
      status: 'executed',
      result: {
        ok: true,
        data: {
          method: 'desktop-artist',
          verification: 'playing',
          title: '24K Magic',
          artist: 'Bruno Mars'
        }
      }
    })
    expect(controller.pressTab).not.toHaveBeenCalled()
    expect(controller.pressEnter).not.toHaveBeenCalled()
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
