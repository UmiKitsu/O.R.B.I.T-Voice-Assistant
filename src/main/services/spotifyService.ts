import type {
  ActionResult,
  DesktopElement,
  DesktopWindowSnapshot,
  MediaSessionState
} from '../../shared/types'
import { detectProtectedTarget, type ForegroundTarget } from '../security/protectedTargets'
import {
  launchResolvedApplication,
  resolveApplication,
  type ApplicationLauncher
} from './applicationDiscoveryService'
import { openExternalUrl, type ExternalUrlOpener } from './browserService'
import { inspectActiveDesktopWindow, performDesktopElementAction } from './desktopAutomationService'
import { inspectForegroundVisually, type VisualInspection } from './desktopVisionService'
import { sendWindowsMediaKey, type MediaKeySender } from './mediaControlService'
import { logOperationalEvent } from './loggerService'
import { getMediaPlaybackState } from './mediaSessionService'
import { clearScreenAwarenessPhase, setScreenAwarenessPhase } from './screenAwarenessService'
import { getSettings } from './settingsService'
import { isValidSpotifyClientId } from './spotifyAuthService'
import { launchResolvedSpotifyTrackUri, type SpotifyTrackUriOpener } from './spotifyTrackUriService'
import {
  getSpotifyPlaybackState,
  resolveSpotifyTrack,
  type SpotifyPlaybackStateData,
  type SpotifyResolvedTrack,
  type SpotifyWebApiDependencies,
  type SpotifyWebPlaybackData
} from './spotifyWebApiService'
import { windowsController, type WindowController } from './windowInputService'

const WINDOW_TIMEOUT_MS = 10_000
const WINDOW_POLL_MS = 250
const MIN_NEW_PROCESS_AGE_MS = 8_000
const REQUIRED_STABLE_WINDOW_SAMPLES = 4
const QUICK_SEARCH_OPEN_DELAY_MS = 250
const SEARCH_RESULTS_DELAY_MS = 750
const SHORTCUT_PLAYBACK_CHECK_DELAY_MS = 350
const SHORTCUT_PLAYBACK_CHECK_TIMEOUT_MS = 2_000
const UI_AUTOMATION_FALLBACK_TIMEOUT_MS = 8_000
const ARTIST_PAGE_CONTROL_TIMEOUT_MS = 5_000
const DESKTOP_PLAYBACK_TIMEOUT_MS = 8_000
const DESKTOP_PLAYBACK_POLL_MS = 250
const URI_TITLE_TIMEOUT_MS = 10_000
const URI_TITLE_POLL_MS = 400
const URI_PLAY_RECHECK_DELAY_MS = 750

export type SpotifyPlaybackIntent = 'track' | 'artist'

export type SpotifyDesktopPlaybackData = {
  application: 'spotify'
  query: string
  method: 'desktop'
  verification: 'playing' | 'started'
  title?: string
  artist?: string
}

export type SpotifyDesktopArtistPlaybackData = {
  application: 'spotify'
  query: string
  method: 'desktop-artist'
  verification: 'playing' | 'started'
  title?: string
  artist?: string
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
  | SpotifyDesktopArtistPlaybackData
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
> & {
  playSpotifySelectedResult(): boolean
}

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
  inspectDesktopWindow?: (signal: AbortSignal) => Promise<ActionResult<DesktopWindowSnapshot>>
  performDesktopAction?: (
    action: 'invoke' | 'select',
    elementRef: string,
    signal: AbortSignal
  ) => Promise<ActionResult<{ name: string; role: string; action: string }>>
  readMediaSession?: (
    sourceApplication: string,
    signal: AbortSignal
  ) => Promise<ActionResult<MediaSessionState>>
  inspectVisually?: (goal: string, signal: AbortSignal) => Promise<ActionResult<VisualInspection>>
  setScreenPhase?: typeof setScreenAwarenessPhase
  clearScreenPhase?: typeof clearScreenAwarenessPhase
  webApi?: SpotifyWebApiDependencies
  settings?: () => {
    spotifyClientId: string
    spotifyPlaybackMode: 'desktop' | 'web-api'
    musicFallbackEnabled: boolean
  }
}

type SpotifyWindowReadiness =
  { status: 'ready'; windowHandle: number } | { status: 'cancelled' } | { status: 'timed-out' }

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

type SpotifyPlaybackStage = 'readiness' | 'search-entry' | 'activation' | 'verification'
type SpotifyPlaybackStageOutcome = 'succeeded' | 'failed' | 'unconfirmed'

function logSpotifyPlaybackStage(
  stage: SpotifyPlaybackStage,
  startedAt: number,
  now: () => number,
  outcome: SpotifyPlaybackStageOutcome
): void {
  logOperationalEvent({
    event: 'spotify.playback-stage',
    stage,
    outcome,
    durationMs: Math.max(0, Math.round(now() - startedAt))
  })
}

function normalizeSpotifyText(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim()
}

type ActionFailure = {
  ok: false
  code: string
  message: string
  recoverable: boolean
}

type SpotifyControlSelection = {
  element: DesktopElement
  action: 'invoke' | 'select'
}

type ScoredSpotifyControl = SpotifyControlSelection & { score: number }

function actionableControl(element: DesktopElement): SpotifyControlSelection | null {
  if (!element.enabled || element.offscreen || !element.name.trim()) return null
  if (element.patterns.includes('invoke')) return { element, action: 'invoke' }
  if (element.patterns.includes('select')) return { element, action: 'select' }
  return null
}

function selectUniqueHighestScore(
  controls: ScoredSpotifyControl[],
  missingCode: string,
  missingMessage: string,
  ambiguousCode: string,
  ambiguousMessage: string
): ActionResult<SpotifyControlSelection> {
  if (controls.length === 0) {
    return { ok: false, code: missingCode, message: missingMessage, recoverable: true }
  }
  const highestScore = Math.max(...controls.map((control) => control.score))
  const best = controls.filter((control) => control.score === highestScore)
  if (best.length !== 1) {
    return { ok: false, code: ambiguousCode, message: ambiguousMessage, recoverable: true }
  }
  return { ok: true, message: 'Found one safe Spotify control.', data: best[0] }
}

function hasAccessibleMetadataSuffix(name: string, query: string): boolean {
  const withoutAction = name.replace(/^\s*(?:play|open|select)\s+/iu, '')
  for (const separator of [',', '•', '·', '—', '–', '|']) {
    const separatorIndex = withoutAction.indexOf(separator)
    if (separatorIndex <= 0) continue
    if (
      normalizeSpotifyText(withoutAction.slice(0, separatorIndex)) === normalizeSpotifyText(query)
    ) {
      return true
    }
  }
  return false
}

function findTrackResultControl(
  snapshot: DesktopWindowSnapshot,
  query: string
): ActionResult<SpotifyControlSelection> {
  const normalizedQuery = normalizeSpotifyText(query)
  const scored = snapshot.elements.flatMap((element): ScoredSpotifyControl[] => {
    const actionable = actionableControl(element)
    if (!actionable) return []
    const normalizedName = normalizeSpotifyText(element.name)
    const withoutAction = normalizedName.replace(/^(?:play|open|select)\s+/u, '')
    let score = 0
    if (normalizedName === normalizedQuery) score = 100
    else if (withoutAction === normalizedQuery) score = 98
    else if (
      withoutAction.startsWith(`${normalizedQuery} by `) ||
      withoutAction.startsWith(`${normalizedQuery} song `) ||
      withoutAction.startsWith(`${normalizedQuery} track `)
    ) {
      score = 94
    } else if (hasAccessibleMetadataSuffix(element.name, query)) {
      score = 92
    }
    return score >= 90 ? [{ ...actionable, score }] : []
  })
  return selectUniqueHighestScore(
    scored,
    'SPOTIFY_TRACK_CONTROL_NOT_FOUND',
    `I could not identify a visible Spotify result matching ${query}.`,
    'SPOTIFY_TRACK_CONTROL_AMBIGUOUS',
    `Spotify exposed more than one equally strong result for ${query}, so I did not guess.`
  )
}

function findArtistResultControl(
  snapshot: DesktopWindowSnapshot,
  artist: string
): ActionResult<SpotifyControlSelection> {
  const normalizedArtist = normalizeSpotifyText(artist)
  const scored = snapshot.elements.flatMap((element): ScoredSpotifyControl[] => {
    const actionable = actionableControl(element)
    if (!actionable) return []
    const normalizedName = normalizeSpotifyText(element.name)
    if (/^(?:play|pause)\b/u.test(normalizedName)) return []
    let score = 0
    if (normalizedName === normalizedArtist) score = 100
    else if (
      normalizedName === `${normalizedArtist} artist` ||
      normalizedName === `artist ${normalizedArtist}`
    ) {
      score = 98
    } else if (
      normalizedName.startsWith(`${normalizedArtist} `) &&
      normalizedName.includes(' artist')
    ) {
      score = 94
    }
    return score >= 90 ? [{ ...actionable, score }] : []
  })
  return selectUniqueHighestScore(
    scored,
    'SPOTIFY_ARTIST_CONTROL_NOT_FOUND',
    `I could not identify a visible Spotify artist result matching ${artist}.`,
    'SPOTIFY_ARTIST_CONTROL_AMBIGUOUS',
    `Spotify exposed more than one equally strong artist result for ${artist}, so I did not guess.`
  )
}

function findArtistPlayControl(
  snapshot: DesktopWindowSnapshot,
  artist: string
): ActionResult<SpotifyControlSelection> {
  const normalizedArtist = normalizeSpotifyText(artist)
  const artistIsVisible = snapshot.elements.some((element) => {
    if (element.offscreen || !element.name.trim()) return false
    const name = normalizeSpotifyText(element.name)
    return name === normalizedArtist || name === `${normalizedArtist} artist`
  })
  if (!artistIsVisible) {
    return {
      ok: false,
      code: 'SPOTIFY_ARTIST_PAGE_NOT_VERIFIED',
      message: `Spotify opened a page, but Orbit could not verify that it belongs to ${artist}.`,
      recoverable: true
    }
  }

  const scored = snapshot.elements.flatMap((element): ScoredSpotifyControl[] => {
    const actionable = actionableControl(element)
    if (!actionable) return []
    const normalizedName = normalizeSpotifyText(element.name)
    let score = 0
    if (normalizedName === 'play') score = 100
    else if (
      normalizedName === `play ${normalizedArtist}` ||
      normalizedName === `${normalizedArtist} play`
    ) {
      score = 96
    }
    return score >= 90 ? [{ ...actionable, score }] : []
  })
  return selectUniqueHighestScore(
    scored,
    'SPOTIFY_ARTIST_PLAY_CONTROL_NOT_FOUND',
    `I opened ${artist} on Spotify, but I could not identify its visible Play control.`,
    'SPOTIFY_ARTIST_PLAY_CONTROL_AMBIGUOUS',
    `Spotify exposed more than one equally strong Play control for ${artist}, so I did not guess.`
  )
}

function spotifySnapshotFailure(snapshot: DesktopWindowSnapshot): ActionFailure | null {
  if (snapshot.processName.toLocaleLowerCase() !== 'spotify.exe') {
    return {
      ok: false,
      code: 'SPOTIFY_TARGET_CHANGED',
      message: 'I stopped because Spotify was no longer the inspected application.',
      recoverable: true
    }
  }
  if (snapshot.truncated) {
    return {
      ok: false,
      code: 'SPOTIFY_SCREEN_SNAPSHOT_TRUNCATED',
      message: 'Spotify exposed an incomplete control snapshot, so Orbit did not guess.',
      recoverable: true
    }
  }
  return null
}

function mediaMatchesTrack(state: MediaSessionState, query: string): boolean {
  const requested = query.match(/^(.*?)(?:\s+by\s+(.+))?$/iu)
  const requestedTitle = normalizeSpotifyText(requested?.[1] ?? query)
  const requestedArtist = normalizeSpotifyText(requested?.[2] ?? '')
  const titleMatches = Boolean(state.title && normalizeSpotifyText(state.title) === requestedTitle)
  const artistMatches =
    !requestedArtist ||
    Boolean(state.artist && normalizeSpotifyText(state.artist).includes(requestedArtist))
  return titleMatches && artistMatches
}

function mediaMatchesArtist(state: MediaSessionState, artist: string): boolean {
  const requestedArtist = normalizeSpotifyText(artist)
  const detectedArtist = normalizeSpotifyText(state.artist ?? '')
  return Boolean(state.title?.trim() && detectedArtist.includes(requestedArtist))
}

function playbackNotVerifiedMessage(
  query: string,
  intent: SpotifyPlaybackIntent,
  state?: MediaSessionState,
  lastFailure?: ActionResult<MediaSessionState>
): string {
  if (lastFailure && !state) {
    return `Spotify did not expose a verifiable Windows media session for ${query}. ${lastFailure.message}`
  }
  if (!state) return `Spotify did not expose a Windows media session for ${query}.`
  if (state.playbackStatus !== 'playing') {
    return `Spotify reported ${state.playbackStatus} instead of playing for ${query}.`
  }
  const detected = state.title
    ? `${state.title}${state.artist ? ` by ${state.artist}` : ''}`
    : 'different media'
  return intent === 'artist'
    ? `Spotify reported ${detected}, which did not match artist ${query}.`
    : `Spotify reported ${detected}, which did not match ${query}.`
}

async function addVisualDiagnosis(
  message: string,
  goal: string,
  signal: AbortSignal,
  inspectVisually: SpotifyPlaybackDependencies['inspectVisually']
): Promise<string> {
  if (!inspectVisually || signal.aborted) return message
  const diagnosis = await inspectVisually(goal, signal)
  if (!diagnosis.ok || !diagnosis.data?.summary) return message
  return `${message} Visible Spotify state: ${diagnosis.data.summary}`
}

function shouldStopSpotifyFallback(code: string | undefined): boolean {
  return Boolean(
    code &&
    (code === 'SCREEN_AWARENESS_DISABLED' ||
      code === 'SPOTIFY_PLAYBACK_NOT_VERIFIED' ||
      code === 'SPOTIFY_SCREEN_SNAPSHOT_TRUNCATED' ||
      code === 'SPOTIFY_SCREEN_AWARENESS_FAILED' ||
      code === 'SPOTIFY_CONTROL_ACTIVATION_FAILED' ||
      code === 'SPOTIFY_TARGET_CHANGED' ||
      code.startsWith('SPOTIFY_TRACK_CONTROL_') ||
      code.startsWith('SPOTIFY_ARTIST_') ||
      code.startsWith('DESKTOP_'))
  )
}

function mapScreenInspectionFailure<T>(failure: ActionFailure): ActionResult<T> {
  if (
    failure.code === 'ACTION_CANCELLED' ||
    failure.code === 'SCREEN_AWARENESS_DISABLED' ||
    failure.code === 'SPOTIFY_TARGET_CHANGED'
  ) {
    return failure
  }
  return {
    ok: false,
    code: 'SPOTIFY_SCREEN_AWARENESS_FAILED',
    message: failure.message,
    recoverable: true
  }
}

function mapControlActivationFailure<T>(failure: ActionFailure): ActionResult<T> {
  if (
    failure.code === 'ACTION_CANCELLED' ||
    failure.code === 'SPOTIFY_TARGET_CHANGED' ||
    failure.code.startsWith('DESKTOP_')
  ) {
    return failure
  }
  return {
    ok: false,
    code: 'SPOTIFY_CONTROL_ACTIVATION_FAILED',
    message: failure.message,
    recoverable: true
  }
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

function targetChangedResult<T = SpotifyDesktopPlaybackData>(message: string): ActionResult<T> {
  return {
    ok: false,
    code: 'SPOTIFY_TARGET_CHANGED',
    message,
    recoverable: true
  }
}

async function verifySpotifyDesktopPlayback(
  query: string,
  intent: SpotifyPlaybackIntent,
  windowHandle: number,
  signal: AbortSignal,
  controller: SpotifyPlaybackController,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number,
  readMediaSession: NonNullable<SpotifyPlaybackDependencies['readMediaSession']>
): Promise<ActionResult<MediaSessionState>> {
  const deadline = now() + DESKTOP_PLAYBACK_TIMEOUT_MS
  let lastState: MediaSessionState | undefined
  let lastFailure: ActionResult<MediaSessionState> | undefined

  while (now() < deadline) {
    if (signal.aborted) return cancelledResult()
    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult(
        'I stopped Spotify playback verification because Spotify lost safe focus.'
      )
    }

    try {
      const result = await readMediaSession('spotify', signal)
      if (result.ok && result.data) {
        lastState = result.data
        lastFailure = undefined
        const requestMatches =
          intent === 'artist'
            ? mediaMatchesArtist(result.data, query)
            : mediaMatchesTrack(result.data, query)
        const spotifySession = normalizeSpotifyText(result.data.sourceApplication).includes(
          'spotify'
        )
        if (result.data.playbackStatus === 'playing' && spotifySession && requestMatches) {
          return result
        }
      } else {
        lastFailure = result
      }
    } catch (error) {
      lastFailure = {
        ok: false,
        code: 'MEDIA_SESSION_READ_FAILED',
        message:
          error instanceof Error ? error.message : 'Windows media session inspection failed.',
        recoverable: true
      }
    }

    await wait(DESKTOP_PLAYBACK_POLL_MS)
  }

  return {
    ok: false,
    code: 'SPOTIFY_PLAYBACK_NOT_VERIFIED',
    message: playbackNotVerifiedMessage(query, intent, lastState, lastFailure),
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
  const controller = dependencies.controller ?? (windowsController as SpotifyPlaybackController)
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

type SpotifyDesktopSearchSession = {
  controller: SpotifyPlaybackController
  wait: (milliseconds: number) => Promise<void>
  now: () => number
  windowHandle: number
}

async function prepareSpotifyDesktopSearch(
  query: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies
): Promise<ActionResult<SpotifyDesktopSearchSession>> {
  const controller = dependencies.controller ?? (windowsController as SpotifyPlaybackController)
  const wait = dependencies.delay ?? delay
  const now = dependencies.now ?? Date.now
  const readinessStartedAt = now()
  let readinessSucceeded = false
  let readiness: SpotifyWindowReadiness

  try {
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
      readiness = await waitForStableSpotifyWindow(controller, signal, wait, now)
    } else {
      const processAgeMs = controller.getProcessAgeMs(existingWindow)
      const sameWindowStillExists = controller.findWindow('spotify') === existingWindow
      const matureWindow = processAgeMs === null || processAgeMs >= MIN_NEW_PROCESS_AGE_MS
      readiness =
        sameWindowStillExists && matureWindow
          ? { status: 'ready', windowHandle: existingWindow }
          : await waitForStableSpotifyWindow(controller, signal, wait, now)
    }

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
    readinessSucceeded = true

    const searchStartedAt = now()
    let searchSucceeded = false
    try {
      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult(
          'I stopped before opening Spotify Quick Search because focus changed.'
        )
      }
      if (!controller.focusSpotifySearch()) {
        return {
          ok: false,
          code: 'SPOTIFY_SEARCH_FAILED',
          message: 'I could not open Spotify Quick Search.',
          recoverable: true
        }
      }
      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult(
          'I stopped after opening Spotify Quick Search because focus changed.'
        )
      }

      await wait(QUICK_SEARCH_OPEN_DELAY_MS)
      if (signal.aborted) return cancelledResult()
      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult(
          'I stopped because Spotify was no longer the active safe target.'
        )
      }

      if (!controller.selectAllText()) {
        return {
          ok: false,
          code: 'SPOTIFY_SEARCH_FAILED',
          message: 'I could not replace the current Spotify search.',
          recoverable: true
        }
      }
      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult(
          'I stopped after selecting the Spotify search text because focus changed.'
        )
      }

      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult(
          'I stopped before entering the Spotify search because focus changed.'
        )
      }
      if (!controller.typeUnicodeText(query)) {
        return {
          ok: false,
          code: 'SPOTIFY_SEARCH_FAILED',
          message: 'I could not enter the Spotify search.',
          recoverable: true
        }
      }
      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult(
          'I stopped after entering the Spotify search because focus changed.'
        )
      }

      await wait(SEARCH_RESULTS_DELAY_MS)
      if (signal.aborted) return cancelledResult()
      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult('I left the search visible because the active target changed.')
      }

      searchSucceeded = true
      return {
        ok: true,
        message: 'Spotify search results are ready.',
        data: { controller, wait, now, windowHandle }
      }
    } finally {
      logSpotifyPlaybackStage(
        'search-entry',
        searchStartedAt,
        now,
        searchSucceeded ? 'succeeded' : 'failed'
      )
    }
  } finally {
    logSpotifyPlaybackStage(
      'readiness',
      readinessStartedAt,
      now,
      readinessSucceeded ? 'succeeded' : 'failed'
    )
  }
}

async function playSpotifyDesktopTrackWithScreenAwareness(
  query: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {},
  preparedSession?: SpotifyDesktopSearchSession
): Promise<ActionResult<SpotifyDesktopPlaybackData>> {
  const prepared = preparedSession
    ? ({ ok: true, message: 'Spotify search results are ready.', data: preparedSession } as const)
    : await prepareSpotifyDesktopSearch(query, signal, dependencies)
  if (!prepared.ok) return prepared
  if (!prepared.data) {
    return {
      ok: false,
      code: 'SPOTIFY_SEARCH_FAILED',
      message: 'Spotify search preparation did not return a usable session.',
      recoverable: true
    }
  }
  const { controller, wait, now, windowHandle } = prepared.data
  const inspectDesktop =
    dependencies.inspectDesktopWindow ??
    ((inspectionSignal: AbortSignal) =>
      inspectActiveDesktopWindow(inspectionSignal, controller as WindowController))
  const performAction =
    dependencies.performDesktopAction ??
    ((action: 'invoke' | 'select', elementRef: string, actionSignal: AbortSignal) =>
      performDesktopElementAction(action, { elementRef }, actionSignal, {
        controller: controller as WindowController
      }))
  const readMediaSession = dependencies.readMediaSession ?? getMediaPlaybackState
  const inspectVisually = dependencies.inspectVisually ?? inspectForegroundVisually
  const setPhase = dependencies.setScreenPhase ?? setScreenAwarenessPhase
  const clearPhase = dependencies.clearScreenPhase ?? clearScreenAwarenessPhase

  try {
    setPhase('inspecting', 'Inspecting Spotify results.')
    const inspected = await inspectDesktop(signal)
    if (!inspected.ok) return mapScreenInspectionFailure<SpotifyDesktopPlaybackData>(inspected)
    if (!inspected.data) {
      return {
        ok: false,
        code: 'SPOTIFY_SCREEN_AWARENESS_FAILED',
        message: 'Spotify screen awareness returned no control snapshot.',
        recoverable: true
      }
    }
    const snapshotFailure = spotifySnapshotFailure(inspected.data)
    if (snapshotFailure) {
      return {
        ...snapshotFailure,
        message: await addVisualDiagnosis(
          snapshotFailure.message,
          `Explain the visible Spotify search results for ${query}. Do not click anything.`,
          signal,
          inspectVisually
        )
      }
    }

    const selection = findTrackResultControl(inspected.data, query)
    if (!selection.ok) {
      return {
        ok: false,
        code: selection.code,
        recoverable: selection.recoverable,
        message: await addVisualDiagnosis(
          selection.message,
          `Explain whether Spotify visibly shows a track result for ${query}. Do not click anything.`,
          signal,
          inspectVisually
        )
      }
    }
    if (!selection.data) {
      return {
        ok: false,
        code: 'SPOTIFY_TRACK_CONTROL_NOT_FOUND',
        message: `I could not identify a usable Spotify result for ${query}.`,
        recoverable: true
      }
    }

    if (signal.aborted) return cancelledResult()
    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult('I left the Spotify results visible because focus changed.')
    }
    setPhase('inspecting', `Opening ${query}.`)
    const activated = await performAction(selection.data.action, selection.data.element.ref, signal)
    if (!activated.ok) return mapControlActivationFailure<SpotifyDesktopPlaybackData>(activated)

    setPhase('analyzing', 'Verifying Spotify playback.')
    const verified = await verifySpotifyDesktopPlayback(
      query,
      'track',
      windowHandle,
      signal,
      controller,
      wait,
      now,
      readMediaSession
    )
    if (!verified.ok || !verified.data) return verified as ActionResult<SpotifyDesktopPlaybackData>
    const title = verified.data.title
    const artist = verified.data.artist
    return {
      ok: true,
      message: `Playing ${title ?? query}${artist ? ` by ${artist}` : ''} on Spotify.`,
      data: {
        application: 'spotify',
        query,
        method: 'desktop',
        verification: 'playing',
        ...(title ? { title } : {}),
        ...(artist ? { artist } : {})
      }
    }
  } finally {
    clearPhase()
  }
}

async function playSpotifyDesktopArtistWithScreenAwareness(
  artist: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {},
  preparedSession?: SpotifyDesktopSearchSession
): Promise<ActionResult<SpotifyDesktopArtistPlaybackData>> {
  const prepared = preparedSession
    ? ({ ok: true, message: 'Spotify search results are ready.', data: preparedSession } as const)
    : await prepareSpotifyDesktopSearch(artist, signal, dependencies)
  if (!prepared.ok) return prepared
  if (!prepared.data) {
    return {
      ok: false,
      code: 'SPOTIFY_SEARCH_FAILED',
      message: 'Spotify search preparation did not return a usable session.',
      recoverable: true
    }
  }
  const { controller, wait, now, windowHandle } = prepared.data
  const inspectDesktop =
    dependencies.inspectDesktopWindow ??
    ((inspectionSignal: AbortSignal) =>
      inspectActiveDesktopWindow(inspectionSignal, controller as WindowController))
  const performAction =
    dependencies.performDesktopAction ??
    ((action: 'invoke' | 'select', elementRef: string, actionSignal: AbortSignal) =>
      performDesktopElementAction(action, { elementRef }, actionSignal, {
        controller: controller as WindowController
      }))
  const readMediaSession = dependencies.readMediaSession ?? getMediaPlaybackState
  const inspectVisually = dependencies.inspectVisually ?? inspectForegroundVisually
  const setPhase = dependencies.setScreenPhase ?? setScreenAwarenessPhase
  const clearPhase = dependencies.clearScreenPhase ?? clearScreenAwarenessPhase

  try {
    setPhase('inspecting', 'Inspecting Spotify results.')
    const resultsInspection = await inspectDesktop(signal)
    if (!resultsInspection.ok) {
      return mapScreenInspectionFailure<SpotifyDesktopArtistPlaybackData>(resultsInspection)
    }
    if (!resultsInspection.data) {
      return {
        ok: false,
        code: 'SPOTIFY_SCREEN_AWARENESS_FAILED',
        message: 'Spotify screen awareness returned no artist-results snapshot.',
        recoverable: true
      }
    }
    const resultsSnapshotFailure = spotifySnapshotFailure(resultsInspection.data)
    if (resultsSnapshotFailure) {
      return {
        ...resultsSnapshotFailure,
        message: await addVisualDiagnosis(
          resultsSnapshotFailure.message,
          `Explain the visible Spotify artist results for ${artist}. Do not click anything.`,
          signal,
          inspectVisually
        )
      }
    }
    const artistSelection = findArtistResultControl(resultsInspection.data, artist)
    if (!artistSelection.ok) {
      return {
        ok: false,
        code: artistSelection.code,
        recoverable: artistSelection.recoverable,
        message: await addVisualDiagnosis(
          artistSelection.message,
          `Explain whether Spotify visibly shows the artist ${artist}. Do not click anything.`,
          signal,
          inspectVisually
        )
      }
    }
    if (!artistSelection.data) {
      return {
        ok: false,
        code: 'SPOTIFY_ARTIST_CONTROL_NOT_FOUND',
        message: `I could not identify a usable Spotify artist result for ${artist}.`,
        recoverable: true
      }
    }

    if (signal.aborted) return cancelledResult()
    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult('I left the Spotify artist results visible because focus changed.')
    }
    setPhase('inspecting', `Opening ${artist}.`)
    const openedArtist = await performAction(
      artistSelection.data.action,
      artistSelection.data.element.ref,
      signal
    )
    if (!openedArtist.ok) {
      return mapControlActivationFailure<SpotifyDesktopArtistPlaybackData>(openedArtist)
    }

    const pageDeadline = now() + ARTIST_PAGE_CONTROL_TIMEOUT_MS
    let playSelection: SpotifyControlSelection | undefined
    let pageFailure: ActionFailure | undefined
    while (now() < pageDeadline) {
      if (signal.aborted) return cancelledResult()
      if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
        return targetChangedResult('I stopped before Artist Play because Spotify lost safe focus.')
      }
      setPhase('inspecting', `Inspecting ${artist} on Spotify.`)
      const pageInspection = await inspectDesktop(signal)
      if (!pageInspection.ok) {
        return mapScreenInspectionFailure<SpotifyDesktopArtistPlaybackData>(pageInspection)
      }
      if (!pageInspection.data) {
        return {
          ok: false,
          code: 'SPOTIFY_SCREEN_AWARENESS_FAILED',
          message: 'Spotify screen awareness returned no artist-page snapshot.',
          recoverable: true
        }
      }
      const pageSnapshotFailure = spotifySnapshotFailure(pageInspection.data)
      if (pageSnapshotFailure) return pageSnapshotFailure
      const candidate = findArtistPlayControl(pageInspection.data, artist)
      if (candidate.ok) {
        if (candidate.data) {
          playSelection = candidate.data
          break
        }
      } else {
        pageFailure = candidate
        if (candidate.code === 'SPOTIFY_ARTIST_PLAY_CONTROL_AMBIGUOUS') break
      }
      await wait(DESKTOP_PLAYBACK_POLL_MS)
    }

    if (!playSelection) {
      const failure =
        pageFailure ??
        ({
          ok: false,
          code: 'SPOTIFY_ARTIST_PLAY_CONTROL_NOT_FOUND',
          message: `I opened ${artist} on Spotify, but its Play control did not become available.`,
          recoverable: true
        } satisfies ActionFailure)
      return {
        ...failure,
        message: await addVisualDiagnosis(
          failure.message,
          `Explain the visible Spotify artist page for ${artist} and whether a Play control is present. Do not click anything.`,
          signal,
          inspectVisually
        )
      }
    }

    if (signal.aborted) return cancelledResult()
    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult('I stopped before activating Artist Play because focus changed.')
    }
    setPhase('inspecting', `Starting music by ${artist}.`)
    const activated = await performAction(playSelection.action, playSelection.element.ref, signal)
    if (!activated.ok) {
      return mapControlActivationFailure<SpotifyDesktopArtistPlaybackData>(activated)
    }

    setPhase('analyzing', 'Verifying Spotify playback.')
    const verified = await verifySpotifyDesktopPlayback(
      artist,
      'artist',
      windowHandle,
      signal,
      controller,
      wait,
      now,
      readMediaSession
    )
    if (!verified.ok || !verified.data) {
      return verified as ActionResult<SpotifyDesktopArtistPlaybackData>
    }
    const title = verified.data.title
    const detectedArtist = verified.data.artist
    return {
      ok: true,
      message: `Playing ${title ?? 'music'}${detectedArtist ? ` by ${detectedArtist}` : ` by ${artist}`} on Spotify.`,
      data: {
        application: 'spotify',
        query: artist,
        method: 'desktop-artist',
        verification: 'playing',
        ...(title ? { title } : {}),
        ...(detectedArtist ? { artist: detectedArtist } : {})
      }
    }
  } finally {
    clearPhase()
  }
}

type SpotifySelectedResultVerification = {
  verification: 'playing' | 'started'
  title?: string
  artist?: string
}

type TimedMediaSessionRead =
  | { status: 'completed'; result: ActionResult<MediaSessionState> }
  | { status: 'timed-out' | 'failed' | 'cancelled' }

function readSpotifyMediaSessionOnce(
  signal: AbortSignal,
  readMediaSession: NonNullable<SpotifyPlaybackDependencies['readMediaSession']>
): Promise<TimedMediaSessionRead> {
  if (signal.aborted) return Promise.resolve({ status: 'cancelled' })

  return new Promise((resolve) => {
    const readController = new AbortController()
    let settled = false
    const finish = (result: TimedMediaSessionRead): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abortFromRequest)
      resolve(result)
    }
    const abortFromRequest = (): void => {
      readController.abort()
      finish({ status: 'cancelled' })
    }
    const timeout = setTimeout(() => {
      readController.abort()
      finish({ status: 'timed-out' })
    }, SHORTCUT_PLAYBACK_CHECK_TIMEOUT_MS)

    signal.addEventListener('abort', abortFromRequest, { once: true })
    Promise.resolve(readMediaSession('spotify', readController.signal)).then(
      (result) => finish({ status: 'completed', result }),
      () => finish({ status: 'failed' })
    )
  })
}

async function verifySpotifySelectedResultOnce(
  query: string,
  intent: SpotifyPlaybackIntent,
  session: SpotifyDesktopSearchSession,
  signal: AbortSignal,
  readMediaSession: NonNullable<SpotifyPlaybackDependencies['readMediaSession']>
): Promise<ActionResult<SpotifySelectedResultVerification>> {
  const { controller, wait, now, windowHandle } = session
  const verificationStartedAt = now()
  let outcome: SpotifyPlaybackStageOutcome = 'failed'

  try {
    await wait(SHORTCUT_PLAYBACK_CHECK_DELAY_MS)
    if (signal.aborted) return cancelledResult()
    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult(
        'I stopped Spotify playback verification because Spotify lost safe focus.'
      )
    }

    const read = await readSpotifyMediaSessionOnce(signal, readMediaSession)
    if (read.status === 'cancelled') return cancelledResult()
    if (read.status === 'completed' && read.result.ok && read.result.data) {
      const state = read.result.data
      const requestMatches =
        intent === 'artist' ? mediaMatchesArtist(state, query) : mediaMatchesTrack(state, query)
      const spotifySession = normalizeSpotifyText(state.sourceApplication).includes('spotify')
      if (state.playbackStatus === 'playing' && spotifySession && requestMatches) {
        outcome = 'succeeded'
        return {
          ok: true,
          message: 'Windows confirmed matching Spotify playback.',
          data: {
            verification: 'playing',
            ...(state.title ? { title: state.title } : {}),
            ...(state.artist ? { artist: state.artist } : {})
          }
        }
      }
    }

    outcome = 'unconfirmed'
    return {
      ok: true,
      message:
        'Spotify accepted the selected-result shortcut, but Windows did not confirm playback.',
      data: { verification: 'started' }
    }
  } finally {
    logSpotifyPlaybackStage('verification', verificationStartedAt, now, outcome)
  }
}

function runBoundedSpotifyUiFallback<T>(
  signal: AbortSignal,
  operation: (fallbackSignal: AbortSignal) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  if (signal.aborted) return Promise.resolve(cancelledResult<T>())

  return new Promise((resolve) => {
    const fallbackController = new AbortController()
    let settled = false
    const finish = (result: ActionResult<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abortFromRequest)
      resolve(result)
    }
    const abortFromRequest = (): void => {
      fallbackController.abort()
      finish(cancelledResult<T>())
    }
    const timeout = setTimeout(() => {
      fallbackController.abort()
      finish({
        ok: false,
        code: 'SPOTIFY_UI_FALLBACK_TIMEOUT',
        message: 'Spotify screen-aware fallback did not finish within eight seconds.',
        recoverable: true
      })
    }, UI_AUTOMATION_FALLBACK_TIMEOUT_MS)

    signal.addEventListener('abort', abortFromRequest, { once: true })
    Promise.resolve(operation(fallbackController.signal)).then(finish, () =>
      finish({
        ok: false,
        code: 'SPOTIFY_SCREEN_AWARENESS_FAILED',
        message: 'Spotify screen-aware fallback failed.',
        recoverable: true
      })
    )
  })
}

async function playSpotifyDesktopSelectedResult(
  query: string,
  intent: SpotifyPlaybackIntent,
  method: 'desktop' | 'desktop-artist',
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies,
  fallback: (
    fallbackSignal: AbortSignal,
    preparedSession: SpotifyDesktopSearchSession
  ) => Promise<ActionResult<SpotifyDesktopPlaybackData | SpotifyDesktopArtistPlaybackData>>
): Promise<ActionResult<SpotifyDesktopPlaybackData | SpotifyDesktopArtistPlaybackData>> {
  const prepared = await prepareSpotifyDesktopSearch(query, signal, dependencies)
  if (!prepared.ok) return prepared
  if (!prepared.data) {
    return {
      ok: false,
      code: 'SPOTIFY_SEARCH_FAILED',
      message: 'Spotify search preparation did not return a usable session.',
      recoverable: true
    }
  }

  const session = prepared.data
  const { controller, now, windowHandle } = session
  const activationStartedAt = now()
  let shortcutAccepted = false
  let activationOutcome: SpotifyPlaybackStageOutcome = 'failed'

  try {
    if (signal.aborted) return cancelledResult()
    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult(
        'I stopped before starting the Spotify result because focus changed.'
      )
    }

    try {
      shortcutAccepted = controller.playSpotifySelectedResult()
    } catch {
      shortcutAccepted = false
    }

    if (!isSafeSpotifyTarget(controller.getForegroundTarget(), windowHandle)) {
      return targetChangedResult('I stopped after the Spotify shortcut because focus changed.')
    }
    if (shortcutAccepted) activationOutcome = 'succeeded'
  } finally {
    logSpotifyPlaybackStage('activation', activationStartedAt, now, activationOutcome)
  }

  if (!shortcutAccepted) {
    const fallbackResult = await runBoundedSpotifyUiFallback(signal, (fallbackSignal) =>
      fallback(fallbackSignal, session)
    )
    if (!fallbackResult.ok && fallbackResult.code === 'SPOTIFY_UI_FALLBACK_TIMEOUT') {
      ;(dependencies.clearScreenPhase ?? clearScreenAwarenessPhase)()
    }
    return fallbackResult
  }

  const readMediaSession = dependencies.readMediaSession ?? getMediaPlaybackState
  const verified = await verifySpotifySelectedResultOnce(
    query,
    intent,
    session,
    signal,
    readMediaSession
  )
  if (!verified.ok || !verified.data) {
    return verified as ActionResult<SpotifyDesktopPlaybackData | SpotifyDesktopArtistPlaybackData>
  }

  const { verification, title, artist } = verified.data
  if (verification === 'playing') {
    return {
      ok: true,
      message: `Playing ${title ?? query}${artist ? ` by ${artist}` : ''} on Spotify.`,
      data: {
        application: 'spotify',
        query,
        method,
        verification,
        ...(title ? { title } : {}),
        ...(artist ? { artist } : {})
      }
    }
  }

  return {
    ok: true,
    message: `Started the top Spotify result for ${query}.`,
    data: {
      application: 'spotify',
      query,
      method,
      verification: 'started'
    }
  }
}

export async function playSpotifyDesktopTopResult(
  query: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {}
): Promise<ActionResult<SpotifyDesktopPlaybackData>> {
  return playSpotifyDesktopSelectedResult(
    query,
    'track',
    'desktop',
    signal,
    dependencies,
    (fallbackSignal, preparedSession) =>
      playSpotifyDesktopTrackWithScreenAwareness(
        query,
        fallbackSignal,
        dependencies,
        preparedSession
      )
  ) as Promise<ActionResult<SpotifyDesktopPlaybackData>>
}

export async function playSpotifyDesktopArtist(
  artist: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {}
): Promise<ActionResult<SpotifyDesktopArtistPlaybackData>> {
  return playSpotifyDesktopSelectedResult(
    artist,
    'artist',
    'desktop-artist',
    signal,
    dependencies,
    (fallbackSignal, preparedSession) =>
      playSpotifyDesktopArtistWithScreenAwareness(
        artist,
        fallbackSignal,
        dependencies,
        preparedSession
      )
  ) as Promise<ActionResult<SpotifyDesktopArtistPlaybackData>>
}

export async function playSpotifyTopResult(
  query: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {},
  intent: SpotifyPlaybackIntent = 'track'
): Promise<ActionResult<MusicPlaybackData>> {
  if (intent === 'artist') {
    return playSpotifyDesktopArtist(query, signal, dependencies)
  }

  const settings = dependencies.settings?.() ?? getSettings()

  if (isValidSpotifyClientId(settings.spotifyClientId)) {
    const resolveTrack =
      dependencies.resolveTrack ??
      ((
        trackQuery: string,
        trackIntent: SpotifyPlaybackIntent,
        clientId: string,
        trackSignal: AbortSignal
      ) => resolveSpotifyTrack(trackQuery, trackIntent, clientId, trackSignal, dependencies.webApi))
    const resolved = await resolveTrack(query, 'track', settings.spotifyClientId, signal)
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

  const desktopResult = await playSpotifyDesktopTopResult(query, signal, dependencies)
  if (desktopResult.ok) return desktopResult

  if (
    settings.musicFallbackEnabled &&
    !signal.aborted &&
    !shouldStopSpotifyFallback(desktopResult.code)
  ) {
    const fallback = await openYouTubeMusicSearch(
      query,
      dependencies.openExternalUrl,
      'spotify-fallback'
    )
    if (fallback.ok) return fallback
  }

  return desktopResult
}
