import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForegroundTarget } from '../security/protectedTargets'
import {
  playSpotifyDesktopTopResult,
  playSpotifyResolvedTrackUri,
  playSpotifyTopResult,
  type SpotifyPlaybackController
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

const controller: SpotifyPlaybackController = {
  findWindow: vi.fn(() => 42),
  getForegroundTarget: vi.fn(() => safeSpotifyTarget),
  getProcessAgeMs: vi.fn(() => 20_000),
  show: vi.fn(() => true),
  activate: vi.fn(() => true),
  focusSpotifySearch: vi.fn(() => true),
  selectAllText: vi.fn(() => true),
  typeUnicodeText: vi.fn(() => true),
  chooseSpotifyTopResult: vi.fn(() => true),
  pressEnter: vi.fn(() => true)
}

function clock(): {
  now: () => number
  delay: (milliseconds: number) => Promise<void>
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

describe('Spotify playback service', () => {
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
    vi.mocked(controller.chooseSpotifyTopResult).mockReturnValue(true)
    vi.mocked(controller.pressEnter).mockReturnValue(true)
  })

  it('waits for a stable cold-start window and a process age of at least eight seconds', async () => {
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

    await expect(
      playSpotifyDesktopTopResult('Locked Out of Heaven', new AbortController().signal, {
        controller,
        launcher,
        delay: timing.delay,
        now: timing.now
      })
    ).resolves.toMatchObject({ ok: true })

    expect(launcher).toHaveBeenCalledOnce()
    expect(controller.show).toHaveBeenCalledWith(42, 'restore')
    expect(controller.activate).toHaveBeenCalledWith(42)
    expect(controller.getProcessAgeMs).toHaveBeenCalledTimes(7)
  })

  it('reacquires Spotify when the startup window handle is replaced', async () => {
    const timing = clock()
    vi.mocked(controller.findWindow)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(11)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)

    await playSpotifyDesktopTopResult('Bruno Mars', new AbortController().signal, {
      controller,
      delay: timing.delay,
      now: timing.now
    })

    expect(controller.show).toHaveBeenCalledWith(42, 'restore')
    expect(controller.activate).toHaveBeenCalledWith(42)
  })

  it('opens Quick Search before selecting existing text or typing the query', async () => {
    const timing = clock()
    vi.mocked(timing.delay).mockImplementation(async (milliseconds: number) => {
      if (milliseconds === 500) {
        expect(controller.focusSpotifySearch).toHaveBeenCalledOnce()
        expect(controller.selectAllText).not.toHaveBeenCalled()
        expect(controller.typeUnicodeText).not.toHaveBeenCalled()
      }
      timing.delays.push(milliseconds)
    })

    await playSpotifyDesktopTopResult('Locked Out of Heaven', new AbortController().signal, {
      controller,
      delay: timing.delay,
      now: () => 0
    })

    expect(controller.selectAllText).toHaveBeenCalledBefore(
      vi.mocked(controller.typeUnicodeText)
    )
    expect(controller.typeUnicodeText).toHaveBeenCalledWith('Locked Out of Heaven')
  })

  it('paces result loading and selection, then reports title-supported playback', async () => {
    const timing = clock()
    vi.mocked(controller.getForegroundTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce({
        ...safeSpotifyTarget,
        title: 'Locked Out of Heaven - Bruno Mars'
      })

    await expect(
      playSpotifyDesktopTopResult('Locked Out of Heaven', new AbortController().signal, {
        controller,
        delay: timing.delay,
        now: timing.now
      })
    ).resolves.toEqual({
      ok: true,
      message: 'Playing Locked Out of Heaven on Spotify.',
      data: { application: 'spotify', query: 'Locked Out of Heaven', method: 'desktop' }
    })

    expect(timing.delays).toEqual([250, 250, 250, 500, 1_500, 150, 1_500])
    expect(controller.chooseSpotifyTopResult).toHaveBeenCalledOnce()
    expect(controller.pressEnter).toHaveBeenCalledOnce()
  })

  it('paces past the artist profile and activates the first track result', async () => {
    let current = 0
    const events: string[] = []
    const pacedDelay = vi.fn(async (milliseconds: number) => {
      events.push(`delay:${milliseconds}`)
      current += milliseconds
    })
    vi.mocked(controller.chooseSpotifyTopResult).mockImplementation(() => {
      events.push('navigate')
      return true
    })
    vi.mocked(controller.pressEnter).mockImplementation(() => {
      events.push('enter')
      return true
    })

    await playSpotifyDesktopTopResult(
      'Bruno Mars',
      new AbortController().signal,
      { controller, delay: pacedDelay, now: () => current },
      'artist'
    )

    expect(events).toEqual([
      'delay:250',
      'delay:250',
      'delay:250',
      'delay:500',
      'delay:1500',
      'navigate',
      'delay:150',
      'navigate',
      'delay:150',
      'enter',
      'delay:1500'
    ])
    expect(controller.chooseSpotifyTopResult).toHaveBeenCalledTimes(2)
    expect(controller.pressEnter).toHaveBeenCalledOnce()
  })

  it('does not treat an artist page title as verified playback', async () => {
    const timing = clock()
    vi.mocked(controller.getForegroundTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce({
        ...safeSpotifyTarget,
        title: 'Bruno Mars | Spotify'
      })

    await expect(
      playSpotifyDesktopTopResult(
        'Bruno Mars',
        new AbortController().signal,
        { controller, delay: timing.delay, now: timing.now },
        'artist'
      )
    ).resolves.toMatchObject({
      ok: true,
      message: 'Started the first Spotify track result for Bruno Mars in the Spotify app.'
    })
  })

  it('uses the first option for a track request and avoids an unverified playing claim', async () => {
    const timing = clock()

    await expect(
      playSpotifyDesktopTopResult(
        'Bruno Mars',
        new AbortController().signal,
        { controller, delay: timing.delay, now: timing.now },
        'track'
      )
    ).resolves.toEqual({
      ok: true,
      message: 'Started the first Spotify track result for Bruno Mars in the Spotify app.',
      data: { application: 'spotify', query: 'Bruno Mars', method: 'desktop' }
    })

    expect(controller.chooseSpotifyTopResult).toHaveBeenCalledOnce()
  })

  it('cancels during readiness polling without sending input', async () => {
    const timing = clock()
    const abortController = new AbortController()
    vi.mocked(controller.findWindow).mockReturnValue(42)
    vi.mocked(controller.getProcessAgeMs).mockReturnValue(1_000)
    vi.mocked(timing.delay).mockImplementation(async (milliseconds: number) => {
      timing.delays.push(milliseconds)
      abortController.abort()
    })

    await expect(
      playSpotifyDesktopTopResult('Bruno Mars', abortController.signal, {
        controller,
        delay: timing.delay,
        now: timing.now
      })
    ).resolves.toMatchObject({ ok: false, code: 'ACTION_CANCELLED' })

    expect(controller.focusSpotifySearch).not.toHaveBeenCalled()
    expect(controller.typeUnicodeText).not.toHaveBeenCalled()
  })

  it('stops when the foreground changes while Quick Search is opening', async () => {
    const timing = clock()
    vi.mocked(controller.getForegroundTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce({
        ...safeSpotifyTarget,
        windowHandle: 99,
        title: 'Other app',
        processName: 'chrome.exe'
      })

    await expect(
      playSpotifyDesktopTopResult('Bruno Mars', new AbortController().signal, {
        controller,
        delay: timing.delay,
        now: timing.now
      })
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_TARGET_CHANGED' })

    expect(controller.selectAllText).not.toHaveBeenCalled()
    expect(controller.typeUnicodeText).not.toHaveBeenCalled()
  })

  it('stops artist navigation before the next key when Spotify loses focus', async () => {
    const timing = clock()
    vi.mocked(controller.getForegroundTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce(safeSpotifyTarget)
      .mockReturnValueOnce({
        ...safeSpotifyTarget,
        windowHandle: 99,
        title: 'Other app',
        processName: 'chrome.exe'
      })

    await expect(
      playSpotifyDesktopTopResult(
        'Bruno Mars',
        new AbortController().signal,
        { controller, delay: timing.delay, now: timing.now },
        'artist'
      )
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_TARGET_CHANGED' })

    expect(controller.chooseSpotifyTopResult).toHaveBeenCalledOnce()
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })

  it('stops artist navigation before the next key when cancelled', async () => {
    const timing = clock()
    const abortController = new AbortController()
    vi.mocked(timing.delay).mockImplementation(async (milliseconds: number) => {
      timing.delays.push(milliseconds)
      if (milliseconds === 150) abortController.abort()
    })

    await expect(
      playSpotifyDesktopTopResult(
        'Bruno Mars',
        abortController.signal,
        { controller, delay: timing.delay, now: () => 0 },
        'artist'
      )
    ).resolves.toMatchObject({ ok: false, code: 'ACTION_CANCELLED' })

    expect(controller.chooseSpotifyTopResult).toHaveBeenCalledOnce()
    expect(controller.pressEnter).not.toHaveBeenCalled()
  })

  it('times out when Spotify never reaches four stable window samples', async () => {
    const timing = clock()
    vi.mocked(controller.findWindow).mockImplementation(() =>
      Math.floor(timing.now() / 250) % 2 === 0 ? 11 : 42
    )

    await expect(
      playSpotifyDesktopTopResult('Bruno Mars', new AbortController().signal, {
        controller,
        delay: timing.delay,
        now: timing.now
      })
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_WINDOW_TIMEOUT' })

    expect(controller.focusSpotifySearch).not.toHaveBeenCalled()
  })

  it('opens and verifies an exact Spotify URI that is already playing', async () => {
    const timing = clock()
    const trackUriOpener = vi.fn(async () => undefined)
    const readPlaybackState = vi.fn(async () => ({
      ok: true as const,
      message: 'Playback ready.',
      data: { available: true, uri: resolvedTrack.uri, isPlaying: true }
    }))
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
          readPlaybackState
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
    expect(readPlaybackState).toHaveBeenCalledOnce()
  })

  it('sends one fixed Play key when the exact track is selected but paused', async () => {
    const timing = clock()
    const sendMediaKey = vi.fn(() => true)
    const readPlaybackState = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        message: 'Paused.',
        data: { available: true, uri: resolvedTrack.uri, isPlaying: false }
      })
      .mockResolvedValueOnce({
        ok: true,
        message: 'Playing.',
        data: { available: true, uri: resolvedTrack.uri, isPlaying: true }
      })
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
          readPlaybackState,
          sendMediaKey
        }
      )
    ).resolves.toMatchObject({
      ok: true,
      data: { method: 'desktop-uri', verification: 'playing' }
    })

    expect(sendMediaKey).toHaveBeenCalledOnce()
    expect(sendMediaKey).toHaveBeenCalledWith('playPause')
    expect(readPlaybackState).toHaveBeenCalledTimes(2)
  })

  it('reports exact selection without claiming playback when state access is unavailable', async () => {
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
    ).resolves.toEqual({
      ok: true,
      message: 'Opened Locked Out of Heaven by Bruno Mars in Spotify.',
      data: {
        application: 'spotify',
        query: 'Locked Out of Heaven',
        title: 'Locked Out of Heaven',
        artist: 'Bruno Mars',
        method: 'desktop-uri',
        verification: 'selected'
      }
    })
  })

  it('handles a cold Spotify protocol launch without using the application launcher', async () => {
    const timing = clock()
    const launcher = vi.fn(async () => undefined)
    const trackUriOpener = vi.fn(async () => undefined)
    vi.mocked(controller.findWindow)
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
      .mockReturnValueOnce(42)
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
          launcher,
          delay: timing.delay,
          now: timing.now,
          trackUriOpener,
          readPlaybackState: vi.fn(async () => ({
            ok: true as const,
            message: 'Playing.',
            data: { available: true, uri: resolvedTrack.uri, isPlaying: true }
          }))
        }
      )
    ).resolves.toMatchObject({ ok: true, data: { method: 'desktop-uri' } })

    expect(trackUriOpener).toHaveBeenCalledBefore(vi.mocked(controller.findWindow))
    expect(launcher).not.toHaveBeenCalled()
  })

  it('falls back to Quick Search when the Spotify protocol handler is unavailable', async () => {
    const timing = clock()
    const trackUriOpener = vi.fn(async () => {
      throw new Error('No protocol handler')
    })

    await expect(
      playSpotifyTopResult('Locked Out of Heaven', new AbortController().signal, {
        controller,
        delay: timing.delay,
        now: timing.now,
        trackUriOpener,
        resolveTrack: vi.fn(async () => ({
          ok: true as const,
          message: 'Resolved.',
          data: resolvedTrack
        })),
        settings: () => ({
          spotifyClientId: '1234567890abcdef1234567890abcdef',
          spotifyPlaybackMode: 'desktop',
          musicFallbackEnabled: false
        })
      })
    ).resolves.toMatchObject({
      ok: true,
      data: { application: 'spotify', method: 'desktop' }
    })

    expect(trackUriOpener).toHaveBeenCalledWith(resolvedTrack.uri)
    expect(controller.focusSpotifySearch).toHaveBeenCalledOnce()
    expect(controller.typeUnicodeText).toHaveBeenCalledWith('Locked Out of Heaven')
  })

  it('falls back to Quick Search when exact title verification fails', async () => {
    const timing = clock()

    await expect(
      playSpotifyTopResult('Locked Out of Heaven', new AbortController().signal, {
        controller,
        delay: timing.delay,
        now: timing.now,
        trackUriOpener: vi.fn(async () => undefined),
        resolveTrack: vi.fn(async () => ({
          ok: true as const,
          message: 'Resolved.',
          data: resolvedTrack
        })),
        readPlaybackState: vi.fn(),
        settings: () => ({
          spotifyClientId: '1234567890abcdef1234567890abcdef',
          spotifyPlaybackMode: 'desktop',
          musicFallbackEnabled: false
        })
      })
    ).resolves.toMatchObject({ ok: true, data: { method: 'desktop' } })

    expect(controller.focusSpotifySearch).toHaveBeenCalledOnce()
  })

  it('uses zero-setup Quick Search without invoking the resolver when OAuth is absent', async () => {
    const timing = clock()
    const resolveTrack = vi.fn()

    await expect(
      playSpotifyTopResult('Bruno Mars', new AbortController().signal, {
        controller,
        delay: timing.delay,
        now: timing.now,
        resolveTrack,
        settings: () => ({
          spotifyClientId: '',
          spotifyPlaybackMode: 'desktop',
          musicFallbackEnabled: false
        })
      })
    ).resolves.toMatchObject({ ok: true, data: { method: 'desktop' } })

    expect(resolveTrack).not.toHaveBeenCalled()
  })

  it('opens YouTube when Spotify desktop control fails and fallback is enabled', async () => {
    const timing = clock()
    const opener = vi.fn(async () => undefined)
    vi.mocked(controller.chooseSpotifyTopResult).mockReturnValue(false)

    await expect(
      playSpotifyTopResult('Bruno Mars', new AbortController().signal, {
        controller,
        delay: timing.delay,
        now: timing.now,
        openExternalUrl: opener,
        settings: () => ({
          spotifyClientId: '',
          spotifyPlaybackMode: 'desktop',
          musicFallbackEnabled: true
        })
      })
    ).resolves.toEqual({
      ok: true,
      message: 'I could not start Bruno Mars on Spotify, so I opened YouTube results instead.',
      data: { application: 'youtube', query: 'Bruno Mars', method: 'spotify-fallback' }
    })
    expect(opener).toHaveBeenCalledWith(
      'https://www.youtube.com/results?search_query=Bruno%20Mars%20official%20audio'
    )
  })
})
