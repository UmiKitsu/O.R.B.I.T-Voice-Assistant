import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSpotifyPkcePair,
  getSpotifyAccessToken,
  isValidSpotifyClientId,
  setSpotifyAuthorizationForTests
} from './spotifyAuthService'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
  },
  shell: { openExternal: vi.fn(async () => undefined) }
}))

afterEach(() => {
  setSpotifyAuthorizationForTests(undefined, undefined)
})

describe('Spotify PKCE and token storage', () => {
  it('creates a PKCE verifier and matching SHA-256 challenge shape', () => {
    const first = createSpotifyPkcePair()
    const second = createSpotifyPkcePair()

    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(first.challenge).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(first.verifier).not.toBe(second.verifier)
    expect(first.challenge).not.toBe(second.challenge)
  })

  it('validates Spotify client IDs without accepting spaces or executable text', () => {
    expect(isValidSpotifyClientId('1234567890abcdef1234567890abcdef')).toBe(true)
    expect(isValidSpotifyClientId('short')).toBe(false)
    expect(isValidSpotifyClientId('1234567890abcdef powershell')).toBe(false)
  })

  it('returns a cached access token without a network refresh while it is valid', async () => {
    const fetcher = vi.fn()
    setSpotifyAuthorizationForTests(undefined, {
      version: 1,
      clientId: '1234567890abcdef1234567890abcdef',
      accessToken: 'cached-access',
      refreshToken: 'refresh-token',
      expiresAt: 100_000
    })

    await expect(
      getSpotifyAccessToken(
        '1234567890abcdef1234567890abcdef',
        false,
        fetcher as typeof fetch,
        () => 1_000
      )
    ).resolves.toEqual({
      ok: true,
      message: 'Spotify access is ready.',
      data: { accessToken: 'cached-access' }
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('requires a reconnect when no authorization matches the configured client', async () => {
    setSpotifyAuthorizationForTests(undefined, null)

    await expect(
      getSpotifyAccessToken('1234567890abcdef1234567890abcdef')
    ).resolves.toMatchObject({
      ok: false,
      code: 'SPOTIFY_NOT_CONNECTED'
    })
  })
})
