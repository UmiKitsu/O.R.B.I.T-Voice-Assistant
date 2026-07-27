import type { ActionResult } from '../../shared/types'
import { detectProtectedTarget } from '../security/protectedTargets'
import {
  launchResolvedApplication,
  resolveApplication,
  type ApplicationLauncher
} from './applicationDiscoveryService'
import { windowsController, type WindowController } from './windowInputService'

const WINDOW_TIMEOUT_MS = 10_000
const WINDOW_POLL_MS = 250

export type SpotifyPlaybackController = Pick<
  WindowController,
  | 'findWindow'
  | 'getForegroundTarget'
  | 'show'
  | 'activate'
  | 'focusSpotifySearch'
  | 'typeUnicodeText'
  | 'chooseSpotifyTopResult'
  | 'pressEnter'
>

export type SpotifyPlaybackDependencies = {
  controller?: SpotifyPlaybackController
  launcher?: ApplicationLauncher
  delay?: (milliseconds: number) => Promise<void>
  now?: () => number
}

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

async function findSpotifyWindow(
  controller: SpotifyPlaybackController,
  wait: (milliseconds: number) => Promise<void>,
  now: () => number
): Promise<number | null> {
  const deadline = now() + WINDOW_TIMEOUT_MS
  do {
    const windowHandle = controller.findWindow('spotify')
    if (windowHandle) return windowHandle
    await wait(WINDOW_POLL_MS)
  } while (now() < deadline)
  return null
}

export async function playSpotifyTopResult(
  query: string,
  signal: AbortSignal,
  dependencies: SpotifyPlaybackDependencies = {}
): Promise<ActionResult<{ application: 'spotify'; query: string }>> {
  const controller = dependencies.controller ?? windowsController
  const wait = dependencies.delay ?? delay
  const now = dependencies.now ?? Date.now
  let windowHandle = controller.findWindow('spotify')

  if (!windowHandle) {
    const spotify = resolveApplication('spotify')
    if (!spotify) {
      return {
        ok: false,
        code: 'SPOTIFY_NOT_FOUND',
        message: 'I could not find the registered Spotify desktop application.',
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
    windowHandle = await findSpotifyWindow(controller, wait, now)
  }

  if (signal.aborted) {
    return {
      ok: false,
      code: 'ACTION_CANCELLED',
      message: 'The request was cancelled.',
      recoverable: true
    }
  }
  if (!windowHandle) {
    return {
      ok: false,
      code: 'SPOTIFY_WINDOW_TIMEOUT',
      message: 'Spotify opened, but its window was not ready in time.',
      recoverable: true
    }
  }

  controller.show(windowHandle, 'restore')
  if (!controller.activate(windowHandle)) {
    return {
      ok: false,
      code: 'SPOTIFY_FOCUS_FAILED',
      message: 'I could not safely focus Spotify.',
      recoverable: true
    }
  }
  await wait(200)

  const before = controller.getForegroundTarget()
  if (
    !before ||
    before.windowHandle !== windowHandle ||
    before.processName.toLocaleLowerCase() !== 'spotify.exe' ||
    detectProtectedTarget(before).protected
  ) {
    return {
      ok: false,
      code: 'SPOTIFY_TARGET_CHANGED',
      message: 'I stopped because Spotify was no longer the active safe target.',
      recoverable: true
    }
  }

  if (!controller.focusSpotifySearch() || !controller.typeUnicodeText(query)) {
    return {
      ok: false,
      code: 'SPOTIFY_SEARCH_FAILED',
      message: 'I could not enter the Spotify search.',
      recoverable: true
    }
  }
  await wait(750)

  const immediatelyBeforeSelection = controller.getForegroundTarget()
  if (
    !immediatelyBeforeSelection ||
    immediatelyBeforeSelection.windowHandle !== windowHandle ||
    immediatelyBeforeSelection.processName.toLocaleLowerCase() !== 'spotify.exe'
  ) {
    return {
      ok: false,
      code: 'SPOTIFY_TARGET_CHANGED',
      message: 'I left the search visible because the active target changed.',
      recoverable: true
    }
  }

  if (!controller.chooseSpotifyTopResult() || !controller.pressEnter()) {
    return {
      ok: false,
      code: 'SPOTIFY_RESULT_SELECTION_FAILED',
      message: `I found ${query} on Spotify, but I could not confirm playback.`,
      recoverable: true
    }
  }
  await wait(1_500)

  const after = controller.getForegroundTarget()
  if (
    !after ||
    after.windowHandle !== windowHandle ||
    after.processName.toLocaleLowerCase() !== 'spotify.exe' ||
    !matchesRequestedPlayback(after.title, query)
  ) {
    return {
      ok: false,
      code: 'SPOTIFY_PLAYBACK_NOT_CONFIRMED',
      message: `I found ${query} on Spotify, but I could not confirm playback.`,
      recoverable: true
    }
  }

  return {
    ok: true,
    message: `Playing the top Spotify result for ${query}.`,
    data: { application: 'spotify', query }
  }
}
