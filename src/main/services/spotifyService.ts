import type { ActionResult } from '../../shared/types'
import { detectProtectedTarget, type ForegroundTarget } from '../security/protectedTargets'
import {
  launchResolvedApplication,
  resolveApplication,
  type ApplicationLauncher
} from './applicationDiscoveryService'
import { openExternalUrl, type ExternalUrlOpener } from './browserService'
import { sendWindowsMediaKey, type MediaKeySender } from './mediaControlService'
import { getSettings } from './settingsService'
import { isValidSpotifyClientId } from './spotifyAuthService'
import {
  launchResolvedSpotifyTrackUri,
  type SpotifyTrackUriOpener
} from './spotifyTrackUriService'
import {
  getSpotifyPlaybackState,
  resolveSpotifyTrack,
  type SpotifyPlaybackStateData,
  type SpotifyResolvedTrack,
  type SpotifyWebApiDependencies,
  type SpotifyWebPlaybackData
} from './spotifyWebApiService'
import { windowsController, type WindowController } from './windowInputService'

const WINDOW_TIMEOUT_MS = 15_000
const WINDOW_POLL_MS = 250
const MIN_NEW_PROCESS_AGE_MS = 8_000
const REQUIRED_STABLE_WINDOW_SAMPLES = 4
const QUICK_SEARCH_OPEN_DELAY_MS = 500
const SEARCH_RESULTS_DELAY_MS = 1_500
const RESULT_NAVIGATION_DELAY_MS = 150
const POST_SELECTION_DELAY_MS = 1_500
const URI_TITLE_TIMEOUT_MS = 10_000
const URI_TITLE_POLL_MS = 400
const URI_PLAY_RECHECK_DELAY_MS = 750

export type SpotifyPlaybackIntent = 'track' | 'artist'

export type SpotifyDesktopPlaybackData = {
  application: 'spotify'
  query: string
  method: 'desktop'
}

export type SpotifyDesktopUriPlaybackData = {
  application: 'spotify'
  query: string
  title: string
  artist: string
  method: 'desktop-uri'
  verification: 'playing' | 'selected'
}

export type YouTubePlaybackData = {
  application: 'youtube'
  query: string
  method: 'browser-search' | 'spotify-fallback'
}

export type MusicPlaybackData =
  | SpotifyWebPlaybackData
  | SpotifyDesktopPlaybackData
  | SpotifyDesktopUriPlaybackData
  | YouTubePlaybackData

export type SpotifyPlaybackController = Pick<
  WindowController,
  | 'findWindow'
  | 'getForegroundTarget'
  | 'getProcessAgeMs'
  | 'show'
  | 'activate'
  | 'focusSpotifySearch'
  | 'selectAllText'
  | 'typeUnicodeText'
  | 'chooseSpotifyTopResult'
  | 'pressEnter'
>

export type SpotifyPlaybackDependencies = {
  controller?: SpotifyPlaybackController
  launcher?: ApplicationLauncher
  delay?: (milliseconds: number) => Promise<void>
  now?: () => number
  openExternalUrl?: ExternalUrlOpener
  trackUriOpener?: SpotifyTrackUriOpener
  sendMediaKey?: MediaKeySender
  resolveTrack?: (
    query: string,
    intent: SpotifyPlaybackIntent,
    clientId: string,
    signal: AbortSignal
  ) => Promise<ActionResult<SpotifyResolvedTrack>>
  readPlaybackState?: (
    clientId: string,
    signal: AbortSignal
  ) => Promise<ActionResult<SpotifyPlaybackStateData>>
  webApi?: SpotifyWebApiDependencies
  settings?: () => {
    spotifyClientId: string
    spotifyPlaybackMode: 'desktop' | 'web-api'
    musicFallbackEnabled: boolean
  }
}

type SpotifyWindowReadiness =
  | { status: 'ready'; windowHandle: number }
  | { status: 'cancelled' }
  | { status: 'timed-out' }

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function normalizeSpotifyText(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

function matchesRequestedPlayback(title: string, query: string): boolean {
  const normalizedTitle = normalizeSpotifyText(title)
  const queryTokens = normalizeSpotifyText(query)
    .split(/\s+/u)
    .filter((token) => token.length >= 3)
  return queryTokens.length > 0 && queryTokens.some((token) => normalizedTitle.includes(token))
}

function matchesResolvedTrackTitle(title: string, track: SpotifyResolvedTrack): boolean {
  const normalizedWindowTitle = normalizeSpotifyText(title)
  const normalizedTrackTitle = normalizeSpotifyText(track.title)
  const artistNames = track.artist
    .split(/,|&|\bfeat\.?\b|\bfeaturing\b/iu)
    .map(normalizeSpotifyText)
    .filter(Boolean)
  return (
    normalizedTrackTitle.length > 0 &&
    normalizedWindowTitle.includes(normalizedTrackTitle) &&
    artistNames.some((artist) => normalizedWindowTitle.includes(artist))
  )
}

function isSafeSpotifyTarget(
  target: ForegroundTarget | null,
  expectedWindowHandle: number
): target is ForegroundTarget {
  return Boolean(
    target &&
      target.windowHandle === expectedWindowHandle &&
      target.processName.toLocaleLowerCase() === 'spotify.exe' &&
      !detectProtectedTarget(target).protected
  )
}

function cancelledResult<T = SpotifyDesktopPlaybackData>(): ActionResult<T> {
  return {
    ok: false,
    code: 'ACTION_CANCELLED',
    message: 'The request was cancelled.',
    recoverable: true
  }
}

function targetChangedResult(message: string): ActionResult<SpotifyDesktopPlaybackData> {
  return {
    ok: false,
    code: 'SPOTIFY_TARGET_CHANGED',
    message,
    recoverable: true
  }
}

async function waitForStableSpotifyWindow(
  controller: SpotifyPlaybackController,
  signal: AbortSignal,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number
): Promise<SpotifyWindowReadiness> {
  const deadline = now() + WINDOW_TIMEOUT_MS
  let stableWindowHandle: number | null = null
  let stableSamples = 0

  while (now() < deadline) {
    if (signal.aborted) return { status: 'cancelled' }

    const currentWindowHandle = controller.findWindow('spotify')
    if (!currentWindowHandle) {
      stableWindowHandle = null
      stableSamples = 0
    } else {
      const processAgeMs = controller.getProcessAgeMs(currentWindowHandle)
      const processIsReady = processAgeMs === null || processAgeMs >= MIN_NEW_PROCESS_AGE_MS

      if (!processIsReady) {
        stableWindowHandle = null
        stableSamples = 0
      } else if (currentWindowHandle === stableWindowHandle) {
        stableSamples += 1
      } else {
        stableWindowHandle = currentWindowHandle
        stableSamples = 1
      }

      if (stableSamples >= REQUIRED_STABLE_WINDOW_SAMPLES && stableWindowHandle) {
        return { status: 'ready', windowHandle: stableWindowHandle }
      }
    }

    await wait(WINDOW_POLL_MS)
  }

  return signal.aborted ? { status: 'cancelled' } : { status: 'timed-out' }
}

export async function openYouTubeMusicSearch(
  query: string,
  opener?: ExternalUrlOpener,
  method: YouTubePlaybackData['method'] = 'browser-search'
): Promise<ActionResult<YouTubePlaybackData>> {
  const searchQuery = `${query} official audio`
  const result = await openExternalUrl(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`,
    opener
  )
  if (!result.ok) return result
  return {
    ok: true,
    message:
      method === 'spotify-fallback'
        ? `I could not start ${query} on Spotify, so I opened YouTube results instead.`
        : `Opening YouTube results for ${query}.`,
    data: { application: 'youtube', query, method }
  }
}

export async function playSpotifyResolvedTrackUri(
  query: string,
  track: SpotifyResolvedTrack,
  clientId: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {}
): Promise<ActionResult<SpotifyDesktopUriPlaybackData>> {
  const controller = dependencies.controller ?? windowsController
  const wait = dependencies.delay ?? delay
  const now = dependencies.now ?? Date.now
  const opened = await launchResolvedSpotifyTrackUri(track, dependencies.trackUriOpener)
  if (!opened.ok) return opened
  if (signal.aborted) return cancelledResult()

  const readiness = await waitForStableSpotifyWindow(controller, signal, wait, now)
  if (readiness.status === 'cancelled') return cancelledResult()
  if (readiness.status === 'timed-out') {
    return {
      ok: false,
      code: 'SPOTIFY_WINDOW_TIMEOUT',
      message: 'Spotify opened the track, but its main window was not ready in time.',
      recoverable: true
    }
  }

  const { windowHandle } = readiness
  controller.show(windowHandle, 'restore')
  if (!controller.activate(windowHandle)) {
    return {
      ok: false,
      code: 'SPOTIFY_FOCUS_FAILED',
      message: 'Spotify opened the track, but Orbit could not safely focus its window.',
      recoverable: true
    }
  }

  const titleDeadline = now() + URI_TITLE_TIMEOUT_MS
  let titleMatched = false
  while (now() < titleDeadline) {
    if (signal.aborted) return cancelledResult()
    const target = controller.getForegroundTarget()
    if (!isSafeSpotifyTarget(target, windowHandle)) {
      return {
        ok: false,
        code: 'SPOTIFY_TARGET_CHANGED',
        message: 'Orbit stopped exact-track verification because Spotify lost focus.',
        recoverable: true
      }
    }
    if (matchesResolvedTrackTitle(target.title, track)) {
      titleMatched = true
      break
    }
    await wait(URI_TITLE_POLL_MS)
  }

  if (!titleMatched) {
    return {
      ok: false,
      code: 'SPOTIFY_TITLE_NOT_VERIFIED',
      message: `Spotify opened, but Orbit could not verify ${track.title} by ${track.artist}.`,
      recoverable: true
    }
  }

  const readPlaybackState =
    dependencies.readPlaybackState ??
    ((spotifyClientId: string, playbackSignal: AbortSignal) =>
      getSpotifyPlaybackState(spotifyClientId, playbackSignal, dependencies.webApi))
  const firstPlayback = await readPlaybackState(clientId, signal)
  if (!firstPlayback.ok) return firstPlayback
  if (!firstPlayback.data || !firstPlayback.data.available) {
    return {
      ok: true,
      message: `Opened ${track.title} by ${track.artist} in Spotify.`,
      data: {
        application: 'spotify',
        query,
        title: track.title,
        artist: track.artist,
        method: 'desktop-uri',
        verification: 'selected'
      }
    }
  }

  if (firstPlayback.data.uri !== track.uri) {
    return {
      ok: false,
      code: 'SPOTIFY_URI_NOT_VERIFIED',
      message: `Spotify opened, but Orbit could not confirm the exact track ${track.title}.`,
      recoverable: true
    }
  }

  if (firstPlayback.data.isPlaying) {
    return {
      ok: true,
      message: `Playing ${track.title} by ${track.artist} on Spotify.`,
      data: {
        application: 'spotify',
        query,
        title: track.title,
        artist: track.artist,
        method: 'desktop-uri',
        verification: 'playing'
      }
    }
  }

  const sendMediaKey = dependencies.sendMediaKey ?? sendWindowsMediaKey
  try {
    if (!sendMediaKey('playPause')) {
      return {
        ok: true,
        message: `Selected ${track.title} by ${track.artist} in Spotify, but playback is paused.`,
        data: {
          application: 'spotify',
          query,
          title: track.title,
          artist: track.artist,
          method: 'desktop-uri',
          verification: 'selected'
        }
      }
    }
  } catch {
    return {
      ok: true,
      message: `Selected ${track.title} by ${track.artist} in Spotify, but playback is paused.`,
      data: {
        application: 'spotify',
        query,
        title: track.title,
        artist: track.artist,
        method: 'desktop-uri',
        verification: 'selected'
      }
    }
  }

  await wait(URI_PLAY_RECHECK_DELAY_MS)
  if (signal.aborted) return cancelledResult()
  const secondPlayback = await readPlaybackState(clientId, signal)
  if (!secondPlayback.ok) return secondPlayback
  if (
    secondPlayback.data?.available &&
    secondPlayback.data.uri === track.uri &&
    secondPlayback.data.isPlaying
  ) {
    return {
      ok: true,
      message: `Playing ${track.title} by ${track.artist} on Spotify.`,
      data: {
        application: 'spotify',
        query,
        title: track.title,
        artist: track.artist,
        method: 'desktop-uri',
        verification: 'playing'
      }
    }
  }
  if (secondPlayback.data?.available && secondPlayback.data.uri !== track.uri) {
    return {
      ok: false,
      code: 'SPOTIFY_URI_NOT_VERIFIED',
      message: `Spotify changed tracks before Orbit could verify ${track.title}.`,
      recoverable: true
    }
  }

  return {
    ok: true,
    message: `Selected ${track.title} by ${track.artist} in Spotify, but playback is paused.`,
    data: {
      application: 'spotify',
      query,
      title: track.title,
      artist: track.artist,
      method: 'desktop-uri',
      verification: 'selected'
    }
  }
}

export async function playSpotifyDesktopTopResult(
  query: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {},
  intent: SpotifyPlaybackIntent = 'track'
): Promise<ActionResult<SpotifyDesktopPlaybackData>> {
  const controller = dependencies.controller ?? windowsController
  const wait = dependencies.delay ?? delay
  const now = dependencies.now ?? Date.now
  const existingWindow = controller.findWindow('spotify')

  if (!existingWindow) {
    const spotify = resolveApplication('spotify')
    if (!spotify) {
      return {
        ok: false,
        code: 'SPOTIFY_NOT_FOUND',
        message: 'I could not find the Spotify desktop application.',
        recoverable: true
      }
    }
    try {
      await (dependencies.launcher ?? launchResolvedApplication)(spotify)
    } catch {
      return {
        ok: false,
        code: 'SPOTIFY_LAUNCH_FAILED',
        message: 'Spotify could not be opened.',
        recoverable: true
      }
    }
  }

  const readiness = await waitForStableSpotifyWindow(controller, signal, wait, now)
  if (readiness.status === 'cancelled') return cancelledResult()
  if (readiness.status === 'timed-out') {
    return {
      ok: false,
      code: 'SPOTIFY_WINDOW_TIMEOUT',
      message: 'Spotify opened, but its main window was not ready in time.',
      recoverable: true
    }
  }

  const { windowHandle } = readiness
  if (signal.aborted) return cancelledResult()

  controller.show(windowHandle, 'restore')
  if (!controller.activate(windowHandle)) {
    return {
      ok: false,
      code: 'SPOTIFY_FOCUS_FAILED',
      message: 'I could not safely focus Spotify.',
      recoverable: true
    }
  }

  if (signal.aborted) return cancelledResult()
  if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
    return targetChangedResult('I stopped because Spotify was no longer the active safe target.')
  }

  if (!controller.focusSpotifySearch()) {
    return {
      ok: false,
      code: 'SPOTIFY_SEARCH_FAILED',
      message: 'I could not open Spotify Quick Search.',
      recoverable: true
    }
  }

  await wait(QUICK_SEARCH_OPEN_DELAY_MS)
  if (signal.aborted) return cancelledResult()
  if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
    return targetChangedResult('I stopped because Spotify was no longer the active safe target.')
  }

  if (!controller.selectAllText() || !controller.typeUnicodeText(query)) {
    return {
      ok: false,
      code: 'SPOTIFY_SEARCH_FAILED',
      message: 'I could not enter the Spotify search.',
      recoverable: true
    }
  }

  await wait(SEARCH_RESULTS_DELAY_MS)
  if (signal.aborted) return cancelledResult()
  if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
    return targetChangedResult('I left the search visible because the active target changed.')
  }

  const navigationSteps = intent === 'artist' ? 2 : 1
  for (let step = 0; step < navigationSteps; step += 1) {
    if (!controller.chooseSpotifyTopResult()) {
      return {
        ok: false,
        code: 'SPOTIFY_RESULT_SELECTION_FAILED',
        message:
          intent === 'artist' && step > 0
            ? `I found ${query} on Spotify, but I could not select the first track result.`
            : `I found ${query} on Spotify, but I could not select the result.`,
        recoverable: true
      }
    }

    await wait(RESULT_NAVIGATION_DELAY_MS)
    if (signal.aborted) return cancelledResult()
    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult('I left the search visible because the active target changed.')
    }
  }

  if (!controller.pressEnter()) {
    return {
      ok: false,
      code: 'SPOTIFY_RESULT_SELECTION_FAILED',
      message: `I found ${query} on Spotify, but I could not start the result.`,
      recoverable: true
    }
  }

  await wait(POST_SELECTION_DELAY_MS)
  if (signal.aborted) return cancelledResult()

  const after = controller.getForegroundTarget()
  if (!isSafeSpotifyTarget(after, windowHandle)) {
    return targetChangedResult(
      'Spotify lost focus before Orbit could finish starting the selected result.'
    )
  }

  const titleMatched = intent === 'track' && matchesRequestedPlayback(after.title, query)
  return {
    ok: true,
    message: titleMatched
      ? `Playing ${query} on Spotify.`
      : `Started the first Spotify track result for ${query} in the Spotify app.`,
    data: { application: 'spotify', query, method: 'desktop' }
  }
}

export async function playSpotifyTopResult(
  query: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {},
  intent: SpotifyPlaybackIntent = 'track'
): Promise<ActionResult<MusicPlaybackData>> {
  const settings = dependencies.settings?.() ?? getSettings()

  if (isValidSpotifyClientId(settings.spotifyClientId)) {
    const resolveTrack =
      dependencies.resolveTrack ??
      ((trackQuery: string, trackIntent: SpotifyPlaybackIntent, clientId: string, trackSignal: AbortSignal) =>
        resolveSpotifyTrack(trackQuery, trackIntent, clientId, trackSignal, dependencies.webApi))
    const resolved = await resolveTrack(query, intent, settings.spotifyClientId, signal)
    if (signal.aborted) return cancelledResult()
    if (resolved.ok && resolved.data) {
      const uriResult = await playSpotifyResolvedTrackUri(
        query,
        resolved.data,
        settings.spotifyClientId,
        signal,
        dependencies
      )
      if (uriResult.ok) return uriResult
      if (signal.aborted || uriResult.code === 'ACTION_CANCELLED') return uriResult
    }
  }

  const desktopResult = await playSpotifyDesktopTopResult(query, signal, dependencies, intent)
  if (desktopResult.ok) return desktopResult

  if (settings.musicFallbackEnabled && !signal.aborted) {
    const fallback = await openYouTubeMusicSearch(
      query,
      dependencies.openExternalUrl,
      'spotify-fallback'
    )
    if (fallback.ok) return fallback
  }

  return desktopResult
}
