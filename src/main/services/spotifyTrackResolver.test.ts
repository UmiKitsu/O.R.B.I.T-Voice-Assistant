import { describe, expect, it, vi } from 'vitest'
import type { ActionResult } from '../../shared/types'
import { resolveSpotifyTrack } from './spotifyWebApiService'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function tokenProvider(): (
  clientId: string,
  forceRefresh: boolean,
  fetcher: typeof fetch
) => Promise<ActionResult<{ accessToken: string }>> {
  return vi.fn(async () => ({
    ok: true as const,
    message: 'Token ready.',
    data: { accessToken: 'access-token' }
  }))
}

const clientId = 'client-id-1234567890'

describe('Spotify exact-track resolver', () => {
  it('keeps relevance scoring for track requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:track:2TpxZ7JUBn3uw46aR7qd6V',
              name: 'Just the Way You Are - Karaoke',
              artists: [{ name: 'Karaoke All Stars' }]
            },
            {
              uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK',
              name: 'Just the Way You Are',
              artists: [{ name: 'Bruno Mars' }]
            }
          ]
        }
      })
    )

    await expect(
      resolveSpotifyTrack(
        'Just the Way You Are Bruno Mars',
        'track',
        clientId,
        new AbortController().signal,
        { fetcher, getAccessToken: tokenProvider() }
      )
    ).resolves.toEqual({
      ok: true,
      message: 'Resolved Just the Way You Are by Bruno Mars.',
      data: {
        uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK',
        title: 'Just the Way You Are',
        artist: 'Bruno Mars'
      }
    })
  })

  it('uses the artist field filter and selects the first exact-artist track', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:track:2TpxZ7JUBn3uw46aR7qd6V',
              name: 'Mars',
              artists: [{ name: 'Other Artist' }]
            },
            {
              uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK',
              name: '24K Magic',
              artists: [{ name: 'Bruno Mars' }]
            },
            {
              uri: 'spotify:track:3cHyrEgdyYRjgJKSOiOtcS',
              name: 'Grenade',
              artists: [{ name: 'Bruno Mars' }]
            }
          ]
        }
      })
    )

    await expect(
      resolveSpotifyTrack(
        'Bruno Mars',
        'artist',
        clientId,
        new AbortController().signal,
        { fetcher, getAccessToken: tokenProvider() }
      )
    ).resolves.toMatchObject({
      ok: true,
      data: {
        uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK',
        title: '24K Magic',
        artist: 'Bruno Mars'
      }
    })

    const searchUrl = new URL(String(vi.mocked(fetcher).mock.calls[0]?.[0]))
    expect(searchUrl.searchParams.get('q')).toBe('artist:Bruno Mars')
    expect(searchUrl.searchParams.get('type')).toBe('track')
  })

  it('returns an authorization failure without calling Spotify Search', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const getAccessToken = vi.fn(async () => ({
      ok: false as const,
      code: 'SPOTIFY_RECONNECT_REQUIRED',
      message: 'Reconnect Spotify.',
      recoverable: true
    }))

    await expect(
      resolveSpotifyTrack('Test Song', 'track', clientId, new AbortController().signal, {
        fetcher,
        getAccessToken
      })
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_RECONNECT_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and malformed Spotify track IDs', async () => {
    const malformedJsonFetcher = vi.fn<typeof fetch>(async () =>
      new Response('{not-json', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    await expect(
      resolveSpotifyTrack('Test Song', 'track', clientId, new AbortController().signal, {
        fetcher: malformedJsonFetcher,
        getAccessToken: tokenProvider()
      })
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_MALFORMED_RESPONSE' })

    const malformedTrackFetcher = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:album:7a3LWj5xSFhFRYmztS8wgK',
              name: 'Test Song',
              artists: [{ name: 'Test Artist' }]
            }
          ]
        }
      })
    )
    await expect(
      resolveSpotifyTrack('Test Song', 'track', clientId, new AbortController().signal, {
        fetcher: malformedTrackFetcher,
        getAccessToken: tokenProvider()
      })
    ).resolves.toMatchObject({ ok: false, code: 'SPOTIFY_MALFORMED_RESPONSE' })
  })

  it('honors cancellation before requesting authorization or search', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetcher = vi.fn<typeof fetch>()
    const getAccessToken = tokenProvider()

    await expect(
      resolveSpotifyTrack('Test Song', 'track', clientId, controller.signal, {
        fetcher,
        getAccessToken
      })
    ).resolves.toMatchObject({ ok: false, code: 'ACTION_CANCELLED' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(getAccessToken).not.toHaveBeenCalled()
  })
})
