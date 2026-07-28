import { z } from 'zod'
import type { ActionResult, YouTubePlaybackState } from '../../shared/types'
import {
  executeBrowserCommand,
  getBrowserStatus
} from '../services/browserBridgeService'
import { openExternalUrl, type ExternalUrlOpener } from '../services/browserService'
import { getSettings } from '../services/settingsService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const musicQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (query) =>
      [...query].every((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint > 0x1f && codePoint !== 0x7f
      }),
    'The YouTube query must contain only plain text.'
  )

const queryParametersSchema = z.object({ query: musicQuerySchema }).strict()
const emptyParametersSchema = z.object({}).strict()
const seekParametersSchema = z
  .object({ seconds: z.number().int().min(-300).max(300).refine((value) => value !== 0) })
  .strict()
const volumeParametersSchema = z.object({ volume: z.number().int().min(0).max(100) }).strict()
const playbackStateSchema = z
  .object({
    controlledTabId: z.number().int().positive().optional(),
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
    title: z.string().max(500).optional(),
    url: z.string().url(),
    paused: z.boolean(),
    ended: z.boolean(),
    muted: z.boolean(),
    volume: z.number().min(0).max(100),
    currentTime: z.number().nonnegative(),
    duration: z.number().nonnegative().optional(),
    confirmedPlaying: z.boolean()
  })
  .strict()

function definition<TParameters>(
  name:
    | 'youtube.playSearch'
    | 'youtube.playPause'
    | 'youtube.seekBy'
    | 'youtube.setVolume'
    | 'youtube.mute'
    | 'youtube.unmute'
    | 'youtube.fullscreen'
    | 'youtube.getPlaybackState',
  execute: CapabilityDefinition<TParameters, ActionResult<YouTubePlaybackState>>['execute'],
  timeoutMs = 15_000
): CapabilityDefinition<TParameters, ActionResult<YouTubePlaybackState>> {
  return { name, risk: 'automatic', timeoutMs, execute }
}

function verifiedMessage(
  capability: string,
  state: YouTubePlaybackState,
  parameters: Record<string, unknown>
): string {
  switch (capability) {
    case 'youtube.playSearch':
      return `Playing ${state.title ?? 'the selected video'} on YouTube.`
    case 'youtube.playPause':
      return state.paused ? 'Paused the YouTube video.' : 'Resumed the YouTube video.'
    case 'youtube.seekBy':
      return Number(parameters.seconds) >= 0
        ? `Skipped forward ${parameters.seconds} seconds.`
        : `Skipped back ${Math.abs(Number(parameters.seconds))} seconds.`
    case 'youtube.setVolume':
      return `Set the YouTube video volume to ${parameters.volume} percent.`
    case 'youtube.mute':
      return 'Muted the YouTube video.'
    case 'youtube.unmute':
      return 'Unmuted the YouTube video.'
    case 'youtube.fullscreen':
      return 'Made the YouTube video fullscreen.'
    default:
      return state.paused ? 'The YouTube video is paused.' : 'The YouTube video is playing.'
  }
}

async function openUnverifiedYouTubeResults(
  query: string,
  opener?: ExternalUrlOpener
): Promise<ActionResult<YouTubePlaybackState>> {
  const opened = await openExternalUrl(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    opener
  )
  if (!opened.ok) return opened
  return {
    ok: false,
    code: 'BROWSER_EXTENSION_DISCONNECTED',
    message:
      'I opened YouTube results, but the Orbit Chrome extension is not connected, so I could not start or verify a video.',
    recoverable: true
  }
}

async function runYouTubeCommand(
  capability:
    | 'youtube.playPause'
    | 'youtube.seekBy'
    | 'youtube.setVolume'
    | 'youtube.mute'
    | 'youtube.unmute'
    | 'youtube.fullscreen'
    | 'youtube.getPlaybackState',
  parameters: Record<string, unknown>,
  signal: AbortSignal
): Promise<ActionResult<YouTubePlaybackState>> {
  const result = await executeBrowserCommand<YouTubePlaybackState>(
    capability,
    parameters,
    signal,
    15_000
  )
  if (!result.ok || !result.data) return result
  return { ...result, message: verifiedMessage(capability, result.data, parameters) }
}

export function registerYouTubeCapabilities(
  registry: CapabilityRegistry,
  opener?: ExternalUrlOpener
): void {
  registry.register(
    definition<z.infer<typeof queryParametersSchema>>(
      'youtube.playSearch',
      async ({ query }, signal) => {
        if (signal.aborted) {
          return {
            ok: false,
            code: 'ACTION_CANCELLED',
            message: 'The request was cancelled.',
            recoverable: true
          }
        }
        if (!getSettings().browserControlEnabled || !getBrowserStatus().connected) {
          return openUnverifiedYouTubeResults(query, opener)
        }

        const result = await executeBrowserCommand<YouTubePlaybackState>(
          'youtube.playSearch',
          { query },
          signal,
          30_000
        )
        if (!result.ok) {
          return result.code === 'BROWSER_EXTENSION_DISCONNECTED'
            ? openUnverifiedYouTubeResults(query, opener)
            : result
        }
        if (!result.data) return result
        if (!result.data.confirmedPlaying) {
          return {
            ok: false,
            code: 'YOUTUBE_PLAYBACK_NOT_VERIFIED',
            message: 'The YouTube video opened, but Orbit could not verify that it is playing.',
            recoverable: true
          }
        }
        return {
          ...result,
          message: verifiedMessage('youtube.playSearch', result.data, { query })
        }
      },
      35_000
    ),
    queryParametersSchema,
    actionResultSchema(playbackStateSchema)
  )

  registry.register(
    definition<z.infer<typeof emptyParametersSchema>>('youtube.playPause', (_parameters, signal) =>
      runYouTubeCommand('youtube.playPause', {}, signal)
    ),
    emptyParametersSchema,
    actionResultSchema(playbackStateSchema)
  )
  registry.register(
    definition<z.infer<typeof seekParametersSchema>>('youtube.seekBy', ({ seconds }, signal) =>
      runYouTubeCommand('youtube.seekBy', { seconds }, signal)
    ),
    seekParametersSchema,
    actionResultSchema(playbackStateSchema)
  )
  registry.register(
    definition<z.infer<typeof volumeParametersSchema>>(
      'youtube.setVolume',
      ({ volume }, signal) => runYouTubeCommand('youtube.setVolume', { volume }, signal)
    ),
    volumeParametersSchema,
    actionResultSchema(playbackStateSchema)
  )
  registry.register(
    definition<z.infer<typeof emptyParametersSchema>>('youtube.mute', (_parameters, signal) =>
      runYouTubeCommand('youtube.mute', {}, signal)
    ),
    emptyParametersSchema,
    actionResultSchema(playbackStateSchema)
  )
  registry.register(
    definition<z.infer<typeof emptyParametersSchema>>('youtube.unmute', (_parameters, signal) =>
      runYouTubeCommand('youtube.unmute', {}, signal)
    ),
    emptyParametersSchema,
    actionResultSchema(playbackStateSchema)
  )
  registry.register(
    definition<z.infer<typeof emptyParametersSchema>>('youtube.fullscreen', (_parameters, signal) =>
      runYouTubeCommand('youtube.fullscreen', {}, signal)
    ),
    emptyParametersSchema,
    actionResultSchema(playbackStateSchema)
  )
  registry.register(
    definition<z.infer<typeof emptyParametersSchema>>(
      'youtube.getPlaybackState',
      (_parameters, signal) => runYouTubeCommand('youtube.getPlaybackState', {}, signal)
    ),
    emptyParametersSchema,
    actionResultSchema(playbackStateSchema)
  )
}
