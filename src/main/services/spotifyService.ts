import type { ActionResult } from '../../shared/types'
import { detectProtectedTarget, type ForegroundTarget } from '../security/protectedTargets'
import {
  launchResolvedApplication,
  resolveApplication,
  type ApplicationLauncher
} from './applicationDiscoveryService'
import { openExternalUrl, type ExternalUrlOpener } from './browserService'
import { getSettings } from './settingsService'
import type {
  SpotifyWebApiDependencies,
  SpotifyWebPlaybackData
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

export type SpotifyPlaybackIntent = 'track' | 'artist'

export type SpotifyDesktopPlaybackData = {
  application: 'spotify'
  query: string
  method: 'desktop'
}

export type YouTubePlaybackData = {
  application: 'youtube'
  query: string
  method: 'browser-search' | 'spotify-fallback'
}

export type MusicPlaybackData =
  | SpotifyWebPlaybackData
  | SpotifyDesktopPlaybackData
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

function matchesRequestedPlayback(title: string, query: string): boolean {
  const normalizedTitle = title.toLocaleLowerCase()
  const queryTokens = query
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter((token) => token.length >= 3)
  return queryTokens.length > 0 && queryTokens.some((token) => normalizedTitle.includes(token))
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

function cancelledResult(): ActionResult<SpotifyDesktopPlaybackData> {
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
