import { describe, expect, it, vi } from 'vitest'
import { controlMediaSession, getMediaPlaybackState, getMediaSessions } from './mediaSessionService'
import type { runFixedWindowsOperation } from './windowsFixedOperationRunner'

const spotifyState = {
  sourceApplication: 'Spotify.exe',
  playbackStatus: 'paused' as const,
  title: 'Die With A Smile',
  artist: 'Lady Gaga'
}

describe('Windows media-session service', () => {
  it('returns bounded verified session state without sending a media key', async () => {
    const runner = vi.fn(async () => ({
      ok: true as const,
      message: 'queried',
      data: { sessions: [spotifyState] }
    })) as unknown as typeof runFixedWindowsOperation

    await expect(getMediaSessions(new AbortController().signal, runner)).resolves.toMatchObject({
      ok: true,
      data: { sessions: [{ sourceApplication: 'Spotify.exe', playbackStatus: 'paused' }] }
    })
    expect(runner).toHaveBeenCalledWith(
      'media.getSessions',
      {},
      expect.anything(),
      expect.any(AbortSignal)
    )
  })

  it('reports the application playback state exactly as Windows returned it', async () => {
    const runner = vi.fn(async () => ({
      ok: true as const,
      message: 'queried',
      data: spotifyState
    })) as unknown as typeof runFixedWindowsOperation

    const result = await getMediaPlaybackState('spotify', new AbortController().signal, runner)
    expect(result).toMatchObject({ ok: true, message: 'Die With A Smile by Lady Gaga is paused.' })
  })

  it('does not claim playing when the provider accepted play but still reports changing', async () => {
    const runner = vi.fn(async () => ({
      ok: true as const,
      message: 'accepted',
      data: {
        accepted: true as const,
        state: { ...spotifyState, playbackStatus: 'changing' as const }
      }
    })) as unknown as typeof runFixedWindowsOperation

    const result = await controlMediaSession(
      'play',
      'spotify',
      new AbortController().signal,
      runner
    )
    expect(result).toMatchObject({ ok: true, data: { playbackStatus: 'changing' } })
    expect(result.message).toContain('reported state is changing')
    expect(result.message).not.toContain('is playing')
  })
})
