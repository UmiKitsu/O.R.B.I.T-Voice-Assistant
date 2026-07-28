import type { ActionResult } from '../../shared/types'
import { getSpotifyAccessToken, type SpotifyAuthFetch } from './spotifyAuthService'

export type SpotifyWebPlaybackData = {
  application: 'spotify'
  query: string
  title: string
  artist: string
  method: 'web-api'
}

type SpotifyTrack = {
  uri: string
  name: string
  artist: string
}

type SpotifyDevice = {
  id: string
  isActive: boolean
  isRestricted: boolean
  name: string
  type: string
}

type AccessTokenProvider = (
  clientId: string,
  forceRefresh: boolean,
  fetcher: SpotifyAuthFetch
) => Promise<ActionResult<{ accessToken: string }>>

export type SpotifyWebApiDependencies = {
  fetcher?: SpotifyAuthFetch
  getAccessToken?: AccessTokenProvider
  delay?: (milliseconds: number) => Promise<void>
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function scoreTrack(track: SpotifyTrack, query: string): number {
  const normalizedQuery = normalize(query)
  const combined = normalize(`${track.name} ${track.artist}`)
  const tokens = normalizedQuery.split(/\s+/u).filter(Boolean)
  let score = combined === normalizedQuery ? 100 : 0
  if (normalize(track.name) === normalizedQuery) score += 80
  if (combined.startsWith(normalizedQuery)) score += 40
  score += tokens.filter((token) => combined.includes(token)).length * 10
  return score
}

function parseTracks(value: unknown): SpotifyTrack[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const tracks = (value as Record<string, unknown>).tracks
  if (typeof tracks !== 'object' || tracks === null || Array.isArray(tracks)) return []
  const items = (tracks as Record<string, unknown>).items
  if (!Array.isArray(items)) return []

  return items.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const track = item as Record<string, unknown>
    if (typeof track.uri !== 'string' || typeof track.name !== 'string') return []
    const artists = Array.isArray(track.artists) ? track.artists : []
    const artistNames = artists.flatMap((artist) => {
      if (typeof artist !== 'object' || artist === null || Array.isArray(artist)) return []
      const name = (artist as Record<string, unknown>).name
      return typeof name === 'string' ? [name] : []
    })
    return artistNames.length > 0
      ? [{ uri: track.uri, name: track.name, artist: artistNames.join(', ') }]
      : []
  })
}

function parseDevices(value: unknown): SpotifyDevice[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const devices = (value as Record<string, unknown>).devices
  if (!Array.isArray(devices)) return []

  return devices.flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const device = item as Record<string, unknown>
    if (
      typeof device.id !== 'string' ||
      device.id.length === 0 ||
      typeof device.is_active !== 'boolean' ||
      typeof device.is_restricted !== 'boolean' ||
      typeof device.name !== 'string' ||
      typeof device.type !== 'string'
    ) {
      return []
    }
    return [
      {
        id: device.id,
        isActive: device.is_active,
        isRestricted: device.is_restricted,
        name: device.name,
        type: device.type
      }
    ]
  })
}

function parsePlayback(value: unknown): { uri?: string; isPlaying: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { isPlaying: false }
  }
  const playback = value as Record<string, unknown>
  const item = playback.item
  const uri =
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? (item as Record<string, unknown>).uri
      : undefined
  return {
    ...(typeof uri === 'string' ? { uri } : {}),
    isPlaying: playback.is_playing === true
  }
}

function responseFailure(response: Response, action: string): ActionResult {
  if (response.status === 401) {
    return {
      ok: false,
      code: 'SPOTIFY_RECONNECT_REQUIRED',
      message: 'Spotify access expired. Reconnect Spotify in Orbit settings.',
      recoverable: true
    }
  }
  if (response.status === 403) {
    return {
      ok: false,
      code: 'SPOTIFY_PREMIUM_REQUIRED',
      message: 'Spotify refused direct playback. A Premium account and playback permission are required.',
      recoverable: true
    }
  }
  if (response.status === 429) {
    return {
      ok: false,
      code: 'SPOTIFY_RATE_LIMITED',
      message: 'Spotify is receiving too many requests. Try again shortly.',
      recoverable: true
    }
  }
  return {
    ok: false,
    code: 'SPOTIFY_API_FAILED',
    message: `Spotify could not ${action}.`,
    recoverable: true
  }
}

async function authorizedFetch(
  url: string,
  init: RequestInit,
  clientId: string,
  signal: AbortSignal,
  dependencies: Required<Pick<SpotifyWebApiDependencies, 'fetcher' | 'getAccessToken'>>
): Promise<ActionResult<Response>> {
  const request = async (forceRefresh: boolean): Promise<ActionResult<Response>> => {
    const token = await dependencies.getAccessToken(clientId, forceRefresh, dependencies.fetcher)
    if (!token.ok) return token
    if (!token.data) {
      return {
        ok: false,
        code: 'SPOTIFY_TOKEN_MISSING',
        message: 'Spotify access could not be loaded.',
        recoverable: true
      }
    }
    try {
      const response = await dependencies.fetcher(url, {
        ...init,
        signal,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token.data.accessToken}`
        }
      })
      return { ok: true, message: 'Spotify responded.', data: response }
    } catch {
      return {
        ok: false,
        code: 'SPOTIFY_NETWORK_FAILED',
        message: 'Orbit could not reach Spotify.',
        recoverable: true
      }
    }
  }

  const first = await request(false)
  if (!first.ok) return first
  if (first.data?.status !== 401) return first
  return request(true)
}

export async function playSpotifyWithWebApi(
  query: string,
  clientId: string,
  signal: AbortSignal,
  dependencies: SpotifyWebApiDependencies = {}
): Promise<ActionResult<SpotifyWebPlaybackData>> {
  const fetcher = dependencies.fetcher ?? fetch
  const getAccessToken = dependencies.getAccessToken ?? getSpotifyAccessToken
  const delay = dependencies.delay ?? wait
  const authDependencies = { fetcher, getAccessToken }

  const searchUrl = new URL('https://api.spotify.com/v1/search')
  searchUrl.search = new URLSearchParams({ q: query, type: 'track', limit: '5' }).toString()
  const search = await authorizedFetch(
    searchUrl.toString(),
    { method: 'GET' },
    clientId,
    signal,
    authDependencies
  )
  if (!search.ok) return search
  if (!search.data) {
    return {
      ok: false,
      code: 'SPOTIFY_EMPTY_RESPONSE',
      message: 'Spotify returned an empty search response.',
      recoverable: true
    }
  }
  if (!search.data.ok) return responseFailure(search.data, 'search for that track')

  const tracks = parseTracks((await search.data.json()) as unknown)
  const track = tracks.sort((left, right) => scoreTrack(right, query) - scoreTrack(left, query))[0]
  if (!track) {
    return {
      ok: false,
      code: 'SPOTIFY_TRACK_NOT_FOUND',
      message: `Spotify could not find a track matching ${query}.`,
      recoverable: true
    }
  }

  const devicesResponse = await authorizedFetch(
    'https://api.spotify.com/v1/me/player/devices',
    { method: 'GET' },
    clientId,
    signal,
    authDependencies
  )
  if (!devicesResponse.ok) return devicesResponse
  if (!devicesResponse.data) {
    return {
      ok: false,
      code: 'SPOTIFY_EMPTY_RESPONSE',
      message: 'Spotify returned an empty device response.',
      recoverable: true
    }
  }
  if (!devicesResponse.data.ok) return responseFailure(devicesResponse.data, 'read playback devices')

  const devices = parseDevices((await devicesResponse.data.json()) as unknown).filter(
    (device) => !device.isRestricted
  )
  const device =
    devices.find((candidate) => candidate.isActive) ??
    devices.find((candidate) => candidate.type.toLocaleLowerCase() === 'computer') ??
    devices[0]
  if (!device) {
    return {
      ok: false,
      code: 'SPOTIFY_NO_DEVICE',
      message: 'Spotify is connected, but no controllable playback device is available. Open Spotify once and try again.',
      recoverable: true
    }
  }

  if (!device.isActive) {
    const transfer = await authorizedFetch(
      'https://api.spotify.com/v1/me/player',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_ids: [device.id], play: false })
      },
      clientId,
      signal,
      authDependencies
    )
    if (!transfer.ok) return transfer
    if (!transfer.data) {
      return {
        ok: false,
        code: 'SPOTIFY_EMPTY_RESPONSE',
        message: 'Spotify returned an empty transfer response.',
        recoverable: true
      }
    }
    if (!transfer.data.ok) return responseFailure(transfer.data, 'activate the selected device')
    await delay(500)
  }

  const playUrl = new URL('https://api.spotify.com/v1/me/player/play')
  playUrl.searchParams.set('device_id', device.id)
  const play = await authorizedFetch(
    playUrl.toString(),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [track.uri], position_ms: 0 })
    },
    clientId,
    signal,
    authDependencies
  )
  if (!play.ok) return play
  if (!play.data) {
    return {
      ok: false,
      code: 'SPOTIFY_EMPTY_RESPONSE',
      message: 'Spotify returned an empty playback response.',
      recoverable: true
    }
  }
  if (!play.data.ok) return responseFailure(play.data, 'start playback')

  for (const verificationDelay of [350, 550, 800, 1_000]) {
    if (signal.aborted) {
      return {
        ok: false,
        code: 'ACTION_CANCELLED',
        message: 'The request was cancelled.',
        recoverable: true
      }
    }
    await delay(verificationDelay)
    const playbackResponse = await authorizedFetch(
      'https://api.spotify.com/v1/me/player',
      { method: 'GET' },
      clientId,
      signal,
      authDependencies
    )
    if (!playbackResponse.ok) return playbackResponse
    if (!playbackResponse.data) {
      return {
        ok: false,
        code: 'SPOTIFY_EMPTY_RESPONSE',
        message: 'Spotify returned an empty verification response.',
        recoverable: true
      }
    }
    if (playbackResponse.data.status === 204) continue
    if (!playbackResponse.data.ok) return responseFailure(playbackResponse.data, 'verify playback')
    const playback = parsePlayback((await playbackResponse.data.json()) as unknown)
    if (playback.isPlaying && playback.uri === track.uri) {
      return {
        ok: true,
        message: `Playing ${track.name} by ${track.artist} on Spotify.`,
        data: {
          application: 'spotify',
          query,
          title: track.name,
          artist: track.artist,
          method: 'web-api'
        }
      }
    }
  }

  return {
    ok: false,
    code: 'SPOTIFY_PLAYBACK_NOT_CONFIRMED',
    message: `Spotify accepted ${track.name}, but Orbit could not confirm that playback started.`,
    recoverable: true
  }
}
