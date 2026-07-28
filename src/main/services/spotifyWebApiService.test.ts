import { describe, expect, it, vi } from 'vitest'
import type { ActionResult } from '../../shared/types'
import { playSpotifyWithWebApi } from './spotifyWebApiService'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function queuedFetcher(responses: Response[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    void input
    void init
    return Promise.resolve(responses.shift() ?? new Response(null, { status: 500 }))
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

describe('Spotify Web API playback', () => {
  it('searches, starts the exact track, and verifies current playback', async () => {
    const responses = [
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK',
              name: 'Locked Out of Heaven',
              artists: [{ name: 'Bruno Mars' }]
            }
          ]
        }
      }),
      jsonResponse({
        devices: [
          {
            id: 'desktop-device',
            is_active: true,
            is_restricted: false,
            name: 'This Computer',
            type: 'Computer'
          }
        ]
      }),
      new Response(null, { status: 204 }),
      jsonResponse({
        is_playing: true,
        item: { uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK' }
      })
    ]
    const fetcher = queuedFetcher(responses)

    await expect(
      playSpotifyWithWebApi(
        'Locked Out of Heaven Bruno Mars',
        'client-id-1234567890',
        new AbortController().signal,
        {
          fetcher,
          getAccessToken: tokenProvider(),
          delay: vi.fn(async () => undefined)
        }
      )
    ).resolves.toEqual({
      ok: true,
      message: 'Playing Locked Out of Heaven by Bruno Mars on Spotify.',
      data: {
        application: 'spotify',
        query: 'Locked Out of Heaven Bruno Mars',
        title: 'Locked Out of Heaven',
        artist: 'Bruno Mars',
        method: 'web-api'
      }
    })

    const mockFetcher = vi.mocked(fetcher)
    expect(mockFetcher).toHaveBeenCalledTimes(4)
    expect(String(mockFetcher.mock.calls[0]?.[0])).toContain(
      'https://api.spotify.com/v1/search?'
    )
    expect(String(mockFetcher.mock.calls[1]?.[0])).toBe(
      'https://api.spotify.com/v1/me/player/devices'
    )
    expect(String(mockFetcher.mock.calls[2]?.[0])).toContain(
      'https://api.spotify.com/v1/me/player/play?device_id=desktop-device'
    )
  })

  it('reports that Spotify must be opened when no playback device exists', async () => {
    const fetcher = queuedFetcher([
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:track:2TpxZ7JUBn3uw46aR7qd6V',
              name: 'Test Song',
              artists: [{ name: 'Test Artist' }]
            }
          ]
        }
      }),
      jsonResponse({ devices: [] })
    ])

    await expect(
      playSpotifyWithWebApi(
        'Test Song',
        'client-id-1234567890',
        new AbortController().signal,
        {
          fetcher,
          getAccessToken: tokenProvider(),
          delay: vi.fn(async () => undefined)
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'SPOTIFY_NO_DEVICE',
      message: expect.stringContaining('Open Spotify once')
    })
  })

  it('turns a forbidden playback response into a Premium-friendly error', async () => {
    const fetcher = queuedFetcher([
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:track:2TpxZ7JUBn3uw46aR7qd6V',
              name: 'Test Song',
              artists: [{ name: 'Test Artist' }]
            }
          ]
        }
      }),
      jsonResponse({
        devices: [
          {
            id: 'desktop-device',
            is_active: true,
            is_restricted: false,
            name: 'This Computer',
            type: 'Computer'
          }
        ]
      }),
      new Response(null, { status: 403 })
    ])

    await expect(
      playSpotifyWithWebApi(
        'Test Song',
        'client-id-1234567890',
        new AbortController().signal,
        {
          fetcher,
          getAccessToken: tokenProvider(),
          delay: vi.fn(async () => undefined)
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'SPOTIFY_PREMIUM_REQUIRED',
      message: expect.stringContaining('Premium')
    })
  })

  it('refreshes once after an unauthorized Spotify response', async () => {
    const fetcher = queuedFetcher([
      new Response(null, { status: 401 }),
      jsonResponse({
        tracks: {
          items: [
            {
              uri: 'spotify:track:2TpxZ7JUBn3uw46aR7qd6V',
              name: 'Test Song',
              artists: [{ name: 'Test Artist' }]
            }
          ]
        }
      }),
      jsonResponse({
        devices: [
          {
            id: 'desktop-device',
            is_active: true,
            is_restricted: false,
            name: 'This Computer',
            type: 'Computer'
          }
        ]
      }),
      new Response(null, { status: 204 }),
      jsonResponse({
        is_playing: true,
        item: { uri: 'spotify:track:2TpxZ7JUBn3uw46aR7qd6V' }
      })
    ])
    const getAccessToken = tokenProvider()

    await expect(
      playSpotifyWithWebApi(
        'Test Song',
        'client-id-1234567890',
        new AbortController().signal,
        {
          fetcher,
          getAccessToken,
          delay: vi.fn(async () => undefined)
        }
      )
    ).resolves.toMatchObject({ ok: true, data: { method: 'web-api' } })
    expect(getAccessToken).toHaveBeenCalledWith('client-id-1234567890', true, fetcher)
  })
})
