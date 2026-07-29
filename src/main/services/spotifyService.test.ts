import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopElement,
  DesktopWindowSnapshot,
  MediaSessionState,
  ScreenAwarenessPhase,
  ScreenAwarenessStatus
} from '../../shared/types'
import type { ForegroundTarget } from '../security/protectedTargets'
import {
  playSpotifyDesktopArtist,
  playSpotifyDesktopTopResult,
  playSpotifyResolvedTrackUri,
  playSpotifyTopResult,
  type SpotifyPlaybackController,
  type SpotifyPlaybackDependencies
} from './spotifyService'

const resolvedTrack = {
  uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK',
  title: 'Locked Out of Heaven',
  artist: 'Bruno Mars'
}

const safeSpotifyTarget: ForegroundTarget = {
  windowHandle: 42,
  title: 'Spotify Premium',
  className: 'Chrome_WidgetWin_0',
  processName: 'Spotify.exe',
  focusedClassName: 'Chrome_RenderWidgetHostHWND',
  isPasswordField: false
}

const otherTarget: ForegroundTarget = {
  ...safeSpotifyTarget,
  windowHandle: 99,
  title: 'Other app',
  processName: 'chrome.exe'
}

type SpotifyControllerProbe = SpotifyPlaybackController & {
  pressTab(): boolean
  pressEnter(): boolean
}

const controller: SpotifyControllerProbe = {
  findWindow: vi.fn(() => 42),
  getForegroundTarget: vi.fn(() => safeSpotifyTarget),
  getProcessAgeMs: vi.fn(() => 20_000),
  show: vi.fn(() => true),
  activate: vi.fn(() => true),
  focusSpotifySearch: vi.fn(() => true),
  selectAllText: vi.fn(() => true),
  typeUnicodeText: vi.fn(() => true),
  pressTab: vi.fn(() => true),
  pressEnter: vi.fn(() => true)
}

function clock(): {
  now: () => number
  delay: ReturnType<typeof vi.fn<(milliseconds: number) => Promise<void>>>
  delays: number[]
} {
  let current = 0
  const delays: number[] = []
  return {
    now: () => current,
    delay: vi.fn(async (milliseconds: number) => {
      delays.push(milliseconds)
      current += milliseconds
    }),
    delays
  }
}

function element(
  ref: string,
  name: string,
  patterns: DesktopElement['patterns'] = ['invoke'],
  overrides: Partial<DesktopElement> = {}
): DesktopElement {
  return {
    ref,
    role: 'Button',
    name,
    enabled: true,
    offscreen: false,
    bounds: { x: 10, y: 10, width: 100, height: 30 },
    patterns,
    ...overrides
  }
}

function snapshot(
  elements: DesktopElement[],
  overrides: Partial<DesktopWindowSnapshot> = {}
): DesktopWindowSnapshot {
  return {
    windowTitle: 'Spotify Premium',
    processName: 'Spotify.exe',
    capturedAt: Date.now(),
    treeVersion: 'tree-version',
    truncated: false,
    elements,
    ...overrides
  }
}

function playingState(title = 'Locked Out of Heaven', artist = 'Bruno Mars'): MediaSessionState {
  return {
    sourceApplication: 'Spotify.exe',
    playbackStatus: 'playing',
    title,
    artist
  }
}

function status(phase: ScreenAwarenessPhase, message: string): ScreenAwarenessStatus {
  return {
    enabled: true,
    phase,
    uiAutomationReady: true,
    visionReady: true,
    visionModel: 'qwen2.5vl:7b',
    visionWarm: true,
    processor: 'gpu',
    message
  }
}

function screenAwareDependencies(
  timing: ReturnType<typeof clock>,
  overrides: SpotifyPlaybackDependencies = {}
): SpotifyPlaybackDependencies {
  return {
    controller,
    delay: timing.delay,
    now: timing.now,
    inspectDesktopWindow: vi.fn(async () => ({
      ok: true as const,
      message: 'Inspected Spotify.',
      data: snapshot([element('track-ref', 'Locked Out of Heaven')])
    })),
    performDesktopAction: vi.fn(async (action) => ({
      ok: true as const,
      message: 'Activated Spotify control.',
      data: { name: 'Spotify result', role: 'Button', action }
    })),
    readMediaSession: vi.fn(async () => ({
      ok: true as const,
      message: 'Playing.',
      data: playingState()
    })),
    inspectVisually: vi.fn(async () => ({
      ok: false as const,
      code: 'VISION_UNAVAILABLE',
      message: 'Vision is unavailable.',
      recoverable: true
    })),
    setScreenPhase: vi.fn((phase, message) => status(phase, message)),
    clearScreenPhase: vi.fn(() => status('ready', 'Ready.')),
    ...overrides
  }
}

describe('screen-aware Spotify desktop playback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(controller.findWindow).mockReturnValue(42)
    vi.mocked(controller.getForegroundTarget).mockReturnValue(safeSpotifyTarget)
    vi.mocked(controller.getProcessAgeMs).mockReturnValue(20_000)
    vi.mocked(controller.show).mockReturnValue(true)
    vi.mocked(controller.activate).mockReturnValue(true)
    vi.mocked(controller.focusSpotifySearch).mockReturnValue(true)
    vi.mocked(controller.selectAllText).mockReturnValue(true)
    vi.mocked(controller.typeUnicodeText).mockReturnValue(true)
    vi.mocked(controller.pressTab).mockReturnValue(true)
    vi.mocked(controller.pressEnter).mockReturnValue(true)
  })

  it('waits for a stable cold-start window before inspecting Spotify', async () => {
    const timing = clock()
    const launcher = vi.fn(async () => undefined)
    vi.mocked(controller.findWindow)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
    vi.mocked(controller.getProcessAgeMs)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(6_000)
      .mockReturnValueOnce(7_999)
      .mockReturnValue(8_000)
    const dependencies = screenAwareDependencies(timing, { launcher })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: true, data: { verification: 'playing' } })

    expect(launcher).toHaveBeenCalledOnce()
    expect(controller.show).toHaveBeenCalledWith(42, 'restore')
    expect(controller.activate).toHaveBeenCalledWith(42)
    expect(dependencies.inspectDesktopWindow).toHaveBeenCalledOnce()
  })

  it('opens Quick Search before selecting text and typing the query', async () => {
    const timing = clock()
    const events: string[] = []
    vi.mocked(controller.focusSpotifySearch).mockImplementation(() => {
      events.push('quick-search')
      return true
    })
    vi.mocked(controller.selectAllText).mockImplementation(() => {
      events.push('select-all')
      return true
    })
    vi.mocked(controller.typeUnicodeText).mockImplementation(() => {
      events.push('type')
      return true
    })

    await playSpotifyDesktopTopResult(
      'Locked Out of Heaven',
      new AbortController().signal,
      screenAwareDependencies(timing)
    )

    expect(events).toEqual(['quick-search', 'select-all', 'type'])
  })

  it('invokes the exact normalized track result and reports verified media metadata', async () => {
    const timing = clock()
    const performDesktopAction = vi.fn(async (action, ref) => ({
      ok: true as const,
      message: 'Activated.',
      data: { name: ref, role: 'Button', action }
    }))
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => ({
        ok: true as const,
        message: 'Inspected.',
        data: snapshot([element('track-ref', 'locked-out OF heaven')])
      })),
      performDesktopAction
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toEqual({
      ok: true,
      message: 'Playing Locked Out of Heaven by Bruno Mars on Spotify.',
      data: {
        application: 'spotify',
        query: 'Locked Out of Heaven',
        method: 'desktop',
        verification: 'playing',
        title: 'Locked Out of Heaven',
        artist: 'Bruno Mars'
      }
    })

    expect(performDesktopAction).toHaveBeenCalledWith(
      'invoke',
      'track-ref',
      expect.any(AbortSignal)
    )
    expect(controller.pressTab).not.toHaveBeenCalled()
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })

  it('supports an alternative Spotify accessible track name without using keyboard navigation', async () => {
    const timing = clock()
    const performDesktopAction = vi.fn(async (action, ref) => ({
      ok: true as const,
      message: 'Activated.',
      data: { name: ref, role: 'Button', action }
    }))

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        screenAwareDependencies(timing, {
          inspectDesktopWindow: vi.fn(async () => ({
            ok: true as const,
            message: 'Inspected.',
            data: snapshot([element('alternate-ref', 'Play Locked Out of Heaven by Bruno Mars')])
          })),
          performDesktopAction
        })
      )
    ).resolves.toMatchObject({ ok: true, data: { verification: 'playing' } })

    expect(performDesktopAction).toHaveBeenCalledWith(
      'invoke',
      'alternate-ref',
      expect.any(AbortSignal)
    )
    expect(controller.pressTab).not.toHaveBeenCalled()
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })

  it('rejects low-confidence partial track names instead of guessing', async () => {
    const timing = clock()
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => ({
        ok: true as const,
        message: 'Inspected.',
        data: snapshot([element('partial-ref', 'Locked Out of Heaven Radio')])
      }))
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_TRACK_CONTROL_NOT_FOUND' })

    expect(dependencies.performDesktopAction).not.toHaveBeenCalled()
  })

  it('rejects ambiguous track matches', async () => {
    const timing = clock()
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => ({
        ok: true as const,
        message: 'Inspected.',
        data: snapshot([
          element('track-a', 'Locked Out of Heaven'),
          element('track-b', 'Locked Out of Heaven')
        ])
      }))
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_TRACK_CONTROL_AMBIGUOUS' })

    expect(dependencies.performDesktopAction).not.toHaveBeenCalled()
  })

  it('rejects disabled, offscreen, and non-actionable controls', async () => {
    const timing = clock()
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => ({
        ok: true as const,
        message: 'Inspected.',
        data: snapshot([
          element('disabled', 'Locked Out of Heaven', ['invoke'], { enabled: false }),
          element('offscreen', 'Locked Out of Heaven', ['invoke'], { offscreen: true }),
          element('value-only', 'Locked Out of Heaven', ['value'])
        ])
      }))
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_TRACK_CONTROL_NOT_FOUND' })
  })

  it('uses local visual inspection only to explain a missing control', async () => {
    const timing = clock()
    const inspectVisually = vi.fn(async () => ({
      ok: true as const,
      message: 'Analyzed Spotify.',
      data: {
        windowTitle: 'Spotify Premium',
        processName: 'Spotify.exe',
        capturedAt: Date.now(),
        summary: 'Spotify shows podcasts but no matching track result.',
        targets: []
      }
    }))
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => ({
        ok: true as const,
        message: 'Inspected.',
        data: snapshot([])
      })),
      inspectVisually
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'SPOTIFY_TRACK_CONTROL_NOT_FOUND',
      message: expect.stringContaining('Spotify shows podcasts but no matching track result.')
    })

    expect(inspectVisually).toHaveBeenCalledOnce()
    expect(dependencies.performDesktopAction).not.toHaveBeenCalled()
  })

  it('rejects truncated UI Automation snapshots', async () => {
    const timing = clock()
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => ({
        ok: true as const,
        message: 'Inspected.',
        data: snapshot([element('track-ref', 'Locked Out of Heaven')], { truncated: true })
      }))
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_SCREEN_SNAPSHOT_TRUNCATED' })
  })

  it('returns stale-reference failures without trying blind navigation', async () => {
    const timing = clock()
    const dependencies = screenAwareDependencies(timing, {
      performDesktopAction: vi.fn(async () => ({
        ok: false as const,
        code: 'DESKTOP_ELEMENT_STALE',
        message: 'The element expired.',
        recoverable: true
      }))
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: false, code: 'DESKTOP_ELEMENT_STALE' })

    expect(controller.pressTab).not.toHaveBeenCalled()
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })

  it('stops before activating a result when foreground focus changes', async () => {
    const timing = clock()
    let activeTarget = safeSpotifyTarget
    vi.mocked(controller.getForegroundTarget).mockImplementation(() => activeTarget)
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => {
        activeTarget = otherTarget
        return {
          ok: true as const,
          message: 'Inspected.',
          data: snapshot([element('track-ref', 'Locked Out of Heaven')])
        }
      })
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_TARGET_CHANGED' })

    expect(dependencies.performDesktopAction).not.toHaveBeenCalled()
  })

  it('cancels safely during control activation', async () => {
    const timing = clock()
    const abortController = new AbortController()
    const dependencies = screenAwareDependencies(timing, {
      performDesktopAction: vi.fn(async () => {
        abortController.abort()
        return {
          ok: false as const,
          code: 'ACTION_CANCELLED',
          message: 'Cancelled.',
          recoverable: true
        }
      })
    })

    await expect(
      playSpotifyDesktopTopResult('Locked Out of Heaven', abortController.signal, dependencies)
    ).resolves.toMatchObject({ ok: false, code: 'ACTION_CANCELLED' })

    expect(dependencies.readMediaSession).not.toHaveBeenCalled()
  })

  it('fails recoverably when screen awareness is disabled', async () => {
    const timing = clock()
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow: vi.fn(async () => ({
        ok: false as const,
        code: 'SCREEN_AWARENESS_DISABLED',
        message: 'Screen awareness is off.',
        recoverable: true
      }))
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        dependencies
      )
    ).resolves.toMatchObject({ ok: false, code: 'SCREEN_AWARENESS_DISABLED' })
  })

  it('polls until Windows reports the requested track as playing', async () => {
    const timing = clock()
    const readMediaSession = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'Paused.',
        data: { ...playingState(), playbackStatus: 'paused' as const }
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Wrong track.',
        data: playingState('Treasure', 'Bruno Mars')
      })
      .mockResolvedValueOnce({ ok: true, message: 'Playing.', data: playingState() })

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        screenAwareDependencies(timing, { readMediaSession })
      )
    ).resolves.toMatchObject({ ok: true, data: { title: 'Locked Out of Heaven' } })

    expect(readMediaSession).toHaveBeenCalledTimes(3)
  })

  it.each([
    {
      label: 'paused playback',
      result: {
        ok: true as const,
        message: 'Paused.',
        data: { ...playingState(), playbackStatus: 'paused' as const }
      }
    },
    {
      label: 'wrong media',
      result: {
        ok: true as const,
        message: 'Playing another track.',
        data: playingState('Treasure', 'Bruno Mars')
      }
    },
    {
      label: 'unavailable media session',
      result: {
        ok: false as const,
        code: 'MEDIA_SESSION_NOT_FOUND',
        message: 'No Spotify media session is available.',
        recoverable: true
      }
    }
  ])('never reports success for $label', async ({ result }) => {
    const timing = clock()
    const readMediaSession = vi.fn(async () => result)

    await expect(
      playSpotifyDesktopTopResult(
        'Locked Out of Heaven',
        new AbortController().signal,
        screenAwareDependencies(timing, { readMediaSession })
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_PLAYBACK_NOT_VERIFIED' })
  })

  it('selects the Bruno Mars artist, invokes the artist Play control, and verifies Spotify choice', async () => {
    const timing = clock()
    const inspectDesktopWindow = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'Results.',
        data: snapshot([element('artist-ref', 'Bruno Mars, Artist')])
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Artist page.',
        data: snapshot([
          element('artist-heading', 'Bruno Mars', [], { role: 'Heading' }),
          element('play-ref', 'Play')
        ])
      })
    const performDesktopAction = vi.fn(async (action, ref) => ({
      ok: true as const,
      message: 'Activated.',
      data: { name: ref, role: 'Button', action }
    }))
    const readMediaSession = vi.fn(async () => ({
      ok: true as const,
      message: 'Playing.',
      data: playingState('24K Magic', 'Bruno Mars')
    }))
    const dependencies = screenAwareDependencies(timing, {
      inspectDesktopWindow,
      performDesktopAction,
      readMediaSession
    })

    await expect(
      playSpotifyDesktopArtist('Bruno Mars', new AbortController().signal, dependencies)
    ).resolves.toEqual({
      ok: true,
      message: 'Playing 24K Magic by Bruno Mars on Spotify.',
      data: {
        application: 'spotify',
        query: 'Bruno Mars',
        method: 'desktop-artist',
        verification: 'playing',
        title: '24K Magic',
        artist: 'Bruno Mars'
      }
    })

    expect(performDesktopAction).toHaveBeenNthCalledWith(
      1,
      'invoke',
      'artist-ref',
      expect.any(AbortSignal)
    )
    expect(performDesktopAction).toHaveBeenNthCalledWith(
      2,
      'invoke',
      'play-ref',
      expect.any(AbortSignal)
    )
    expect(controller.pressTab).not.toHaveBeenCalled()
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })

  it('rejects an artist page whose accessible content belongs to another artist', async () => {
    const timing = clock()
    const inspectDesktopWindow = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'Results.',
        data: snapshot([element('artist-ref', 'Bruno Mars, Artist')])
      })
      .mockResolvedValue({
        ok: true,
        message: 'Artist page.',
        data: snapshot([
          element('wrong-heading', 'The Weeknd', [], { role: 'Heading' }),
          element('play-ref', 'Play')
        ])
      })

    await expect(
      playSpotifyDesktopArtist(
        'Bruno Mars',
        new AbortController().signal,
        screenAwareDependencies(timing, { inspectDesktopWindow })
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_ARTIST_PAGE_NOT_VERIFIED' })
  })

  it('rejects ambiguous artist Play controls', async () => {
    const timing = clock()
    const inspectDesktopWindow = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'Results.',
        data: snapshot([element('artist-ref', 'Bruno Mars')])
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Artist page.',
        data: snapshot([
          element('artist-heading', 'Bruno Mars', [], { role: 'Heading' }),
          element('play-a', 'Play'),
          element('play-b', 'Play')
        ])
      })

    await expect(
      playSpotifyDesktopArtist(
        'Bruno Mars',
        new AbortController().signal,
        screenAwareDependencies(timing, { inspectDesktopWindow })
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'SPOTIFY_ARTIST_PLAY_CONTROL_AMBIGUOUS'
    })
  })

  it('never reports artist success when Windows reports the wrong artist', async () => {
    const timing = clock()
    const inspectDesktopWindow = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'Results.',
        data: snapshot([element('artist-ref', 'Bruno Mars')])
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Artist page.',
        data: snapshot([
          element('artist-heading', 'Bruno Mars', [], { role: 'Heading' }),
          element('play-ref', 'Play')
        ])
      })

    await expect(
      playSpotifyDesktopArtist(
        'Bruno Mars',
        new AbortController().signal,
        screenAwareDependencies(timing, {
          inspectDesktopWindow,
          readMediaSession: vi.fn(async () => ({
            ok: true as const,
            message: 'Playing.',
            data: playingState('Blinding Lights', 'The Weeknd')
          }))
        })
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_PLAYBACK_NOT_VERIFIED' })
  })

  it('publishes descriptive phases and always clears them', async () => {
    const timing = clock()
    const phaseMessages: string[] = []
    const clearScreenPhase = vi.fn(() => status('ready', 'Ready.'))
    const inspectDesktopWindow = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'Results.',
        data: snapshot([element('artist-ref', 'Bruno Mars')])
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Artist page.',
        data: snapshot([
          element('artist-heading', 'Bruno Mars', [], { role: 'Heading' }),
          element('play-ref', 'Play')
        ])
      })

    await playSpotifyDesktopArtist(
      'Bruno Mars',
      new AbortController().signal,
      screenAwareDependencies(timing, {
        inspectDesktopWindow,
        setScreenPhase: vi.fn((phase, message) => {
          phaseMessages.push(message)
          return status(phase, message)
        }),
        clearScreenPhase,
        readMediaSession: vi.fn(async () => ({
          ok: true as const,
          message: 'Playing.',
          data: playingState('Treasure', 'Bruno Mars')
        }))
      })
    )

    expect(phaseMessages).toContain('Inspecting Spotify results.')
    expect(phaseMessages).toContain('Opening Bruno Mars.')
    expect(phaseMessages).toContain('Inspecting Bruno Mars on Spotify.')
    expect(phaseMessages).toContain('Verifying Spotify playback.')
    expect(clearScreenPhase).toHaveBeenCalledOnce()
  })

  it('clears the screen-awareness phase after failure', async () => {
    const timing = clock()
    const clearScreenPhase = vi.fn(() => status('ready', 'Ready.'))

    await playSpotifyDesktopTopResult(
      'Locked Out of Heaven',
      new AbortController().signal,
      screenAwareDependencies(timing, {
        inspectDesktopWindow: vi.fn(async () => ({
          ok: false as const,
          code: 'SCREEN_AWARENESS_DISABLED',
          message: 'Screen awareness is off.',
          recoverable: true
        })),
        clearScreenPhase
      })
    )

    expect(clearScreenPhase).toHaveBeenCalledOnce()
  })
})

describe('Spotify fallback and URI behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(controller.findWindow).mockReturnValue(42)
    vi.mocked(controller.getForegroundTarget).mockReturnValue(safeSpotifyTarget)
    vi.mocked(controller.getProcessAgeMs).mockReturnValue(20_000)
    vi.mocked(controller.show).mockReturnValue(true)
    vi.mocked(controller.activate).mockReturnValue(true)
    vi.mocked(controller.focusSpotifySearch).mockReturnValue(true)
    vi.mocked(controller.selectAllText).mockReturnValue(true)
    vi.mocked(controller.typeUnicodeText).mockReturnValue(true)
  })

  it('does not open YouTube when screen awareness cannot identify Spotify controls', async () => {
    const timing = clock()
    const opener = vi.fn(async () => undefined)

    await expect(
      playSpotifyTopResult('Locked Out of Heaven', new AbortController().signal, {
        ...screenAwareDependencies(timing, {
          inspectDesktopWindow: vi.fn(async () => ({
            ok: false as const,
            code: 'SCREEN_AWARENESS_DISABLED',
            message: 'Screen awareness is off.',
            recoverable: true
          }))
        }),
        openExternalUrl: opener,
        settings: () => ({
          spotifyClientId: '',
          spotifyPlaybackMode: 'desktop',
          musicFallbackEnabled: true
        })
      })
    ).resolves.toMatchObject({ ok: false, code: 'SCREEN_AWARENESS_DISABLED' })

    expect(opener).not.toHaveBeenCalled()
  })

  it('does not open YouTube when Spotify playback cannot be verified', async () => {
    const timing = clock()
    const opener = vi.fn(async () => undefined)

    await expect(
      playSpotifyTopResult('Locked Out of Heaven', new AbortController().signal, {
        ...screenAwareDependencies(timing, {
          readMediaSession: vi.fn(async () => ({
            ok: true as const,
            message: 'Paused.',
            data: { ...playingState(), playbackStatus: 'paused' as const }
          }))
        }),
        openExternalUrl: opener,
        settings: () => ({
          spotifyClientId: '',
          spotifyPlaybackMode: 'desktop',
          musicFallbackEnabled: true
        })
      })
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_PLAYBACK_NOT_VERIFIED' })

    expect(opener).not.toHaveBeenCalled()
  })

  it('keeps the existing YouTube fallback for unrelated Spotify search failures', async () => {
    const timing = clock()
    const opener = vi.fn(async () => undefined)
    vi.mocked(controller.focusSpotifySearch).mockReturnValue(false)

    await expect(
      playSpotifyTopResult('Locked Out of Heaven', new AbortController().signal, {
        ...screenAwareDependencies(timing),
        openExternalUrl: opener,
        settings: () => ({
          spotifyClientId: '',
          spotifyPlaybackMode: 'desktop',
          musicFallbackEnabled: true
        })
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { application: 'youtube', method: 'spotify-fallback' }
    })

    expect(opener).toHaveBeenCalledOnce()
  })

  it('opens and verifies an exact Spotify URI without using screen awareness', async () => {
    const timing = clock()
    const trackUriOpener = vi.fn(async () => undefined)
    vi.mocked(controller.getForegroundTarget).mockReturnValue({
      ...safeSpotifyTarget,
      title: 'Locked Out of Heaven - Bruno Mars'
    })

    await expect(
      playSpotifyResolvedTrackUri(
        'Locked Out of Heaven',
        resolvedTrack,
        'client-id-1234567890',
        new AbortController().signal,
        {
          controller,
          delay: timing.delay,
          now: timing.now,
          trackUriOpener,
          readPlaybackState: vi.fn(async () => ({
            ok: true as const,
            message: 'Playback ready.',
            data: { available: true, uri: resolvedTrack.uri, isPlaying: true }
          }))
        }
      )
    ).resolves.toEqual({
      ok: true,
      message: 'Playing Locked Out of Heaven by Bruno Mars on Spotify.',
      data: {
        application: 'spotify',
        query: 'Locked Out of Heaven',
        title: 'Locked Out of Heaven',
        artist: 'Bruno Mars',
        method: 'desktop-uri',
        verification: 'playing'
      }
    })

    expect(trackUriOpener).toHaveBeenCalledWith(resolvedTrack.uri)
  })

  it('keeps exact URI selection semantics when playback state is unavailable', async () => {
    const timing = clock()
    vi.mocked(controller.getForegroundTarget).mockReturnValue({
      ...safeSpotifyTarget,
      title: 'Locked Out of Heaven - Bruno Mars'
    })

    await expect(
      playSpotifyResolvedTrackUri(
        'Locked Out of Heaven',
        resolvedTrack,
        'client-id-1234567890',
        new AbortController().signal,
        {
          controller,
          delay: timing.delay,
          now: timing.now,
          trackUriOpener: vi.fn(async () => undefined),
          readPlaybackState: vi.fn(async () => ({
            ok: true as const,
            message: 'Unavailable.',
            data: { available: false, isPlaying: false }
          }))
        }
      )
    ).resolves.toMatchObject({
      ok: true,
      data: { method: 'desktop-uri', verification: 'selected' }
    })
  })
})
