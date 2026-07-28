import { describe, expect, it, vi } from 'vitest'
import {
  isValidResolvedSpotifyTrack,
  launchResolvedSpotifyTrackUri
} from './spotifyTrackUriService'

const validTrack = {
  uri: 'spotify:track:7a3LWj5xSFhFRYmztS8wgK',
  title: 'Locked Out of Heaven',
  artist: 'Bruno Mars'
}

describe('Spotify track URI launch boundary', () => {
  it('passes only the exact validated URI to the external protocol opener', async () => {
    const opener = vi.fn(async () => undefined)

    await expect(launchResolvedSpotifyTrackUri(validTrack, opener)).resolves.toEqual({
      ok: true,
      message: 'Opening Locked Out of Heaven by Bruno Mars in Spotify.',
      data: { uri: validTrack.uri }
    })

    expect(opener).toHaveBeenCalledOnce()
    expect(opener).toHaveBeenCalledWith(validTrack.uri)
  })

  it.each([
    'spotify:album:7a3LWj5xSFhFRYmztS8wgK',
    'spotify:artist:7a3LWj5xSFhFRYmztS8wgK',
    'https://open.spotify.com/track/7a3LWj5xSFhFRYmztS8wgK',
    ' spotify:track:7a3LWj5xSFhFRYmztS8wgK',
    'spotify:track:7a3LWj5xSFhFRYmztS8wgK ',
    'spotify:track:7a3LWj5xSFhFRYmztS8wgK?si=test',
    'spotify:track:short',
    'spotify:track:7a3LWj5xSFhFRYmztS8wg!',
    'powershell.exe spotify:track:7a3LWj5xSFhFRYmztS8wgK'
  ])('rejects a non-track or malformed URI: %s', async (uri) => {
    const opener = vi.fn(async () => undefined)

    await expect(
      launchResolvedSpotifyTrackUri({ ...validTrack, uri }, opener)
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_SPOTIFY_TRACK_REFERENCE'
    })
    expect(opener).not.toHaveBeenCalled()
  })

  it('rejects extra executable fields instead of accepting a command-shaped object', () => {
    expect(
      isValidResolvedSpotifyTrack({
        ...validTrack,
        command: 'cmd.exe /c start spotify'
      })
    ).toBe(false)
  })

  it('reports a missing or failed Spotify protocol handler', async () => {
    const opener = vi.fn(async () => {
      throw new Error('No handler')
    })

    await expect(launchResolvedSpotifyTrackUri(validTrack, opener)).resolves.toMatchObject({
      ok: false,
      code: 'SPOTIFY_PROTOCOL_OPEN_FAILED'
    })
    expect(opener).toHaveBeenCalledWith(validTrack.uri)
  })
})
