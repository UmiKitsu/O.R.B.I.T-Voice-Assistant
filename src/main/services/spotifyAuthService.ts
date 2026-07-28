import { safeStorage, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ActionResult, SpotifyConnectionStatus } from '../../shared/types'

export const SPOTIFY_REDIRECT_URI = 'http://127.0.0.1:43821/spotify/callback'
const SPOTIFY_CALLBACK_HOST = '127.0.0.1'
const SPOTIFY_CALLBACK_PORT = 43821
const SPOTIFY_CALLBACK_PATH = '/spotify/callback'
const SPOTIFY_AUTH_TIMEOUT_MS = 120_000
const SPOTIFY_TOKEN_REFRESH_MARGIN_MS = 60_000
const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state'
].join(' ')

export type SpotifyAuthFetch = typeof fetch
export type SpotifyBrowserOpener = (url: string) => Promise<void>

type StoredSpotifyAuthorization = {
  version: 1
  clientId: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  displayName?: string
  product?: string
}

type SpotifyTokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token?: string
  scope?: string
}

type SpotifyProfile = {
  displayName?: string
  product?: string
}

type CallbackListener = {
  waitForCode: Promise<string>
  close: () => void
}

let authorizationPath: string | undefined
let cachedAuthorization: StoredSpotifyAuthorization | null | undefined
let connectionInProgress = false

function base64Url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function createSpotifyPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64))
  const challenge = base64Url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function isValidSpotifyClientId(value: string): boolean {
  return /^[A-Za-z0-9]{16,100}$/u.test(value.trim())
}

function parseStoredAuthorization(value: unknown): StoredSpotifyAuthorization | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== 1 ||
    typeof candidate.clientId !== 'string' ||
    !isValidSpotifyClientId(candidate.clientId) ||
    typeof candidate.accessToken !== 'string' ||
    candidate.accessToken.length === 0 ||
    typeof candidate.refreshToken !== 'string' ||
    candidate.refreshToken.length === 0 ||
    typeof candidate.expiresAt !== 'number' ||
    !Number.isFinite(candidate.expiresAt)
  ) {
    return null
  }

  return {
    version: 1,
    clientId: candidate.clientId,
    accessToken: candidate.accessToken,
    refreshToken: candidate.refreshToken,
    expiresAt: candidate.expiresAt,
    ...(typeof candidate.displayName === 'string' && candidate.displayName.length <= 200
      ? { displayName: candidate.displayName }
      : {}),
    ...(typeof candidate.product === 'string' && candidate.product.length <= 50
      ? { product: candidate.product }
      : {})
  }
}

function requireAuthorizationPath(): string {
  if (!authorizationPath) throw new Error('Spotify authorization storage is not initialized.')
  return authorizationPath
}

async function readStoredAuthorization(): Promise<StoredSpotifyAuthorization | null> {
  if (cachedAuthorization !== undefined) return cachedAuthorization
  if (!authorizationPath || !safeStorage.isEncryptionAvailable()) {
    cachedAuthorization = null
    return null
  }

  try {
    const encrypted = Buffer.from(await readFile(authorizationPath, 'utf8'), 'base64')
    const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as unknown
    cachedAuthorization = parseStoredAuthorization(parsed)
  } catch {
    cachedAuthorization = null
  }
  return cachedAuthorization
}

async function writeStoredAuthorization(value: StoredSpotifyAuthorization): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is unavailable.')
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64')
  await writeFile(requireAuthorizationPath(), encrypted, 'utf8')
  cachedAuthorization = value
}

async function clearStoredAuthorization(): Promise<void> {
  cachedAuthorization = null
  if (!authorizationPath) return
  await rm(authorizationPath, { force: true })
}

export function initializeSpotifyAuthService(userDataPath: string): void {
  authorizationPath = join(userDataPath, 'spotify-authorization.dat')
  cachedAuthorization = undefined
}

export async function getSpotifyConnectionStatus(
  clientId: string
): Promise<SpotifyConnectionStatus> {
  const normalizedClientId = clientId.trim()
  const configured = isValidSpotifyClientId(normalizedClientId)
  const stored = configured ? await readStoredAuthorization() : null
  const connected = Boolean(stored && stored.clientId === normalizedClientId)

  return {
    configured,
    connected,
    redirectUri: SPOTIFY_REDIRECT_URI,
    ...(connected && stored?.displayName ? { displayName: stored.displayName } : {}),
    ...(connected && stored?.product ? { product: stored.product } : {})
  }
}

function writeCallbackPage(server: Server, response: import('node:http').ServerResponse, ok: boolean): void {
  response.statusCode = ok ? 200 : 400
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Orbit Spotify</title></head><body style="font-family:system-ui;padding:2rem;background:#0b1220;color:#edf3ff"><h1>${ok ? 'Spotify connected' : 'Spotify connection failed'}</h1><p>${ok ? 'You can close this tab and return to Orbit.' : 'Return to Orbit and try connecting again.'}</p></body></html>`)
  setImmediate(() => server.close())
}

async function createCallbackListener(expectedState: string): Promise<CallbackListener> {
  let settled = false
  let resolveCode: (code: string) => void
  let rejectCode: (error: Error) => void

  const waitForCode = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const server = createServer((request, response) => {
    if (!request.url) {
      writeCallbackPage(server, response, false)
      if (!settled) {
        settled = true
        rejectCode(new Error('Spotify returned an invalid callback.'))
      }
      return
    }

    const callback = new URL(request.url, SPOTIFY_REDIRECT_URI)
    if (callback.pathname !== SPOTIFY_CALLBACK_PATH) {
      response.statusCode = 404
      response.end('Not found')
      return
    }

    const state = callback.searchParams.get('state')
    const code = callback.searchParams.get('code')
    const error = callback.searchParams.get('error')
    const valid = state === expectedState && Boolean(code) && !error
    writeCallbackPage(server, response, valid)

    if (settled) return
    settled = true
    if (error) {
      rejectCode(new Error(error === 'access_denied' ? 'Spotify access was denied.' : 'Spotify authorization failed.'))
    } else if (state !== expectedState) {
      rejectCode(new Error('Spotify returned an invalid authorization state.'))
    } else if (!code) {
      rejectCode(new Error('Spotify did not return an authorization code.'))
    } else {
      resolveCode(code)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(SPOTIFY_CALLBACK_PORT, SPOTIFY_CALLBACK_HOST, () => resolve())
  })

  return {
    waitForCode,
    close: () => {
      if (!settled) {
        settled = true
        rejectCode(new Error('Spotify authorization was cancelled.'))
      }
      server.close()
    }
  }
}

function parseTokenResponse(value: unknown): SpotifyTokenResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.access_token !== 'string' ||
    candidate.access_token.length === 0 ||
    typeof candidate.token_type !== 'string' ||
    typeof candidate.expires_in !== 'number' ||
    !Number.isFinite(candidate.expires_in) ||
    candidate.expires_in <= 0
  ) {
    return null
  }
  return {
    access_token: candidate.access_token,
    token_type: candidate.token_type,
    expires_in: candidate.expires_in,
    ...(typeof candidate.refresh_token === 'string' && candidate.refresh_token.length > 0
      ? { refresh_token: candidate.refresh_token }
      : {}),
    ...(typeof candidate.scope === 'string' ? { scope: candidate.scope } : {})
  }
}

async function requestToken(
  body: URLSearchParams,
  fetcher: SpotifyAuthFetch
): Promise<SpotifyTokenResponse | null> {
  const response = await fetcher('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) return null
  return parseTokenResponse((await response.json()) as unknown)
}

async function fetchSpotifyProfile(
  accessToken: string,
  fetcher: SpotifyAuthFetch
): Promise<SpotifyProfile> {
  try {
    const response = await fetcher('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!response.ok) return {}
    const value = (await response.json()) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const profile = value as Record<string, unknown>
    return {
      ...(typeof profile.display_name === 'string' && profile.display_name.length <= 200
        ? { displayName: profile.display_name }
        : {}),
      ...(typeof profile.product === 'string' && profile.product.length <= 50
        ? { product: profile.product }
        : {})
    }
  } catch {
    return {}
  }
}

export async function connectSpotify(
  clientId: string,
  dependencies: {
    fetcher?: SpotifyAuthFetch
    openBrowser?: SpotifyBrowserOpener
    now?: () => number
  } = {}
): Promise<ActionResult<SpotifyConnectionStatus>> {
  const normalizedClientId = clientId.trim()
  if (!isValidSpotifyClientId(normalizedClientId)) {
    return {
      ok: false,
      code: 'SPOTIFY_CLIENT_ID_REQUIRED',
      message: 'Enter the Spotify app Client ID before connecting.',
      recoverable: true
    }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      ok: false,
      code: 'SPOTIFY_SECURE_STORAGE_UNAVAILABLE',
      message: 'Windows secure storage is unavailable, so Orbit cannot safely store Spotify access.',
      recoverable: true
    }
  }
  if (connectionInProgress) {
    return {
      ok: false,
      code: 'SPOTIFY_CONNECTION_IN_PROGRESS',
      message: 'A Spotify connection is already waiting for authorization.',
      recoverable: true
    }
  }

  connectionInProgress = true
  const fetcher = dependencies.fetcher ?? fetch
  const openBrowser = dependencies.openBrowser ?? ((url: string) => shell.openExternal(url))
  const now = dependencies.now ?? Date.now
  const { verifier, challenge } = createSpotifyPkcePair()
  const state = base64Url(randomBytes(24))
  let listener: CallbackListener | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    try {
      listener = await createCallbackListener(state)
    } catch {
      return {
        ok: false,
        code: 'SPOTIFY_CALLBACK_UNAVAILABLE',
        message: `Orbit could not open its Spotify callback on ${SPOTIFY_REDIRECT_URI}. Close another app using port ${SPOTIFY_CALLBACK_PORT} and try again.`,
        recoverable: true
      }
    }

    const authorizationUrl = new URL('https://accounts.spotify.com/authorize')
    authorizationUrl.search = new URLSearchParams({
      client_id: normalizedClientId,
      response_type: 'code',
      redirect_uri: SPOTIFY_REDIRECT_URI,
      scope: SPOTIFY_SCOPES,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge
    }).toString()

    await openBrowser(authorizationUrl.toString())
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Spotify authorization timed out.')), SPOTIFY_AUTH_TIMEOUT_MS)
    })
    const code = await Promise.race([listener.waitForCode, timeoutPromise])
    const token = await requestToken(
      new URLSearchParams({
        client_id: normalizedClientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        code_verifier: verifier
      }),
      fetcher
    )
    if (!token?.refresh_token) {
      return {
        ok: false,
        code: 'SPOTIFY_TOKEN_EXCHANGE_FAILED',
        message: 'Spotify authorization completed, but Orbit could not obtain reusable playback access.',
        recoverable: true
      }
    }

    const profile = await fetchSpotifyProfile(token.access_token, fetcher)
    await writeStoredAuthorization({
      version: 1,
      clientId: normalizedClientId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: now() + token.expires_in * 1_000,
      ...profile
    })
    const status = await getSpotifyConnectionStatus(normalizedClientId)
    return {
      ok: true,
      message: status.displayName
        ? `Spotify connected as ${status.displayName}.`
        : 'Spotify connected.',
      data: status
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Spotify authorization failed.'
    return {
      ok: false,
      code: message.includes('timed out') ? 'SPOTIFY_AUTH_TIMEOUT' : 'SPOTIFY_AUTH_FAILED',
      message,
      recoverable: true
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    listener?.close()
    connectionInProgress = false
  }
}

export async function disconnectSpotify(clientId: string): Promise<SpotifyConnectionStatus> {
  await clearStoredAuthorization()
  return getSpotifyConnectionStatus(clientId)
}

export async function getSpotifyAccessToken(
  clientId: string,
  forceRefresh = false,
  fetcher: SpotifyAuthFetch = fetch,
  now: () => number = Date.now
): Promise<ActionResult<{ accessToken: string }>> {
  const normalizedClientId = clientId.trim()
  const stored = await readStoredAuthorization()
  if (!stored || stored.clientId !== normalizedClientId) {
    return {
      ok: false,
      code: 'SPOTIFY_NOT_CONNECTED',
      message: 'Connect Spotify in Orbit settings before using direct playback.',
      recoverable: true
    }
  }

  if (!forceRefresh && stored.expiresAt > now() + SPOTIFY_TOKEN_REFRESH_MARGIN_MS) {
    return {
      ok: true,
      message: 'Spotify access is ready.',
      data: { accessToken: stored.accessToken }
    }
  }

  const refreshed = await requestToken(
    new URLSearchParams({
      client_id: normalizedClientId,
      grant_type: 'refresh_token',
      refresh_token: stored.refreshToken
    }),
    fetcher
  )
  if (!refreshed) {
    await clearStoredAuthorization()
    return {
      ok: false,
      code: 'SPOTIFY_RECONNECT_REQUIRED',
      message: 'Spotify access expired. Reconnect Spotify in Orbit settings.',
      recoverable: true
    }
  }

  const next: StoredSpotifyAuthorization = {
    ...stored,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? stored.refreshToken,
    expiresAt: now() + refreshed.expires_in * 1_000
  }
  await writeStoredAuthorization(next)
  return {
    ok: true,
    message: 'Spotify access refreshed.',
    data: { accessToken: next.accessToken }
  }
}

export function setSpotifyAuthorizationForTests(
  path: string | undefined,
  authorization: StoredSpotifyAuthorization | null | undefined
): void {
  authorizationPath = path
  cachedAuthorization = authorization
  connectionInProgress = false
}
