import { shell } from 'electron'
import type { ActionResult } from '../../shared/types'
import { isValidSpotifyTrackUri, type SpotifyResolvedTrack } from './spotifyWebApiService'

export type SpotifyTrackUriOpener = (uri: string) => Promise<void>

function isPlainNonEmptyText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 500 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint > 0x1f && codePoint !== 0x7f
    })
  )
}

export function isValidResolvedSpotifyTrack(value: unknown): value is SpotifyResolvedTrack {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const keys = Object.keys(candidate).sort()
  if (keys.join(',') !== 'artist,title,uri') return false
  return (
    isValidSpotifyTrackUri(candidate.uri) &&
    isPlainNonEmptyText(candidate.title) &&
    isPlainNonEmptyText(candidate.artist)
  )
}

export async function launchResolvedSpotifyTrackUri(
  track: unknown,
  opener: SpotifyTrackUriOpener = (uri) => shell.openExternal(uri)
): Promise<ActionResult<{ uri: string }>> {
  if (!isValidResolvedSpotifyTrack(track)) {
    return {
      ok: false,
      code: 'INVALID_SPOTIFY_TRACK_REFERENCE',
      message: 'Spotify returned an invalid track reference.',
      recoverable: true
    }
  }

  try {
    await opener(track.uri)
    return {
      ok: true,
      message: `Opening ${track.title} by ${track.artist} in Spotify.`,
      data: { uri: track.uri }
    }
  } catch {
    return {
      ok: false,
      code: 'SPOTIFY_PROTOCOL_OPEN_FAILED',
      message: 'Windows could not open that track in the Spotify desktop application.',
      recoverable: true
    }
  }
}
