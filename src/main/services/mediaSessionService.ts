import { z } from 'zod'
import type { ActionResult, MediaSessionState } from '../../shared/types'
import {
  runFixedWindowsOperation,
  type WindowsFixedOperationId
} from './windowsFixedOperationRunner'

export const mediaSessionStateSchema = z
  .object({
    sourceApplication: z.string().min(1).max(200),
    playbackStatus: z.enum(['closed', 'opened', 'changing', 'stopped', 'playing', 'paused']),
    title: z.string().max(300).optional(),
    artist: z.string().max(300).optional(),
    albumTitle: z.string().max(300).optional(),
    positionSeconds: z.number().nonnegative().optional(),
    durationSeconds: z.number().nonnegative().optional()
  })
  .strict()
const sessionsSchema = z.object({ sessions: z.array(mediaSessionStateSchema).max(50) }).strict()
const mediaActionSchema = z
  .object({ accepted: z.literal(true), state: mediaSessionStateSchema })
  .strict()

type MediaOperationRunner = typeof runFixedWindowsOperation

function describeState(state: MediaSessionState): string {
  const track = state.title
    ? `${state.title}${state.artist ? ` by ${state.artist}` : ''}`
    : 'the active media session'
  return `${track} is ${state.playbackStatus}.`
}

export async function getMediaSessions(
  signal: AbortSignal,
  runner: MediaOperationRunner = runFixedWindowsOperation
): Promise<ActionResult<{ sessions: MediaSessionState[] }>> {
  const result = await runner('media.getSessions', {}, sessionsSchema, signal)
  if (!result.ok || !result.data) return result
  return {
    ok: true,
    message:
      result.data.sessions.length === 0
        ? 'No Windows media sessions are available.'
        : `Found ${result.data.sessions.length} Windows media session${result.data.sessions.length === 1 ? '' : 's'}.`,
    data: result.data
  }
}

export async function getMediaPlaybackState(
  sourceApplication: string,
  signal: AbortSignal,
  runner: MediaOperationRunner = runFixedWindowsOperation
): Promise<ActionResult<MediaSessionState>> {
  const result = await runner(
    'media.getPlaybackState',
    { sourceApplication },
    mediaSessionStateSchema,
    signal
  )
  if (!result.ok || !result.data) return result
  return { ok: true, message: describeState(result.data), data: result.data }
}

export async function controlMediaSession(
  action: 'play' | 'pause' | 'nextTrack' | 'previousTrack',
  sourceApplication: string,
  signal: AbortSignal,
  runner: MediaOperationRunner = runFixedWindowsOperation
): Promise<ActionResult<MediaSessionState>> {
  const operationId = `media.${action}` as WindowsFixedOperationId
  const result = await runner(operationId, { sourceApplication }, mediaActionSchema, signal)
  if (!result.ok || !result.data) return result as ActionResult<MediaSessionState>
  const state = result.data.state
  const verified =
    (action === 'play' && state.playbackStatus === 'playing') ||
    (action === 'pause' && state.playbackStatus === 'paused')
  const message =
    action === 'play' || action === 'pause'
      ? verified
        ? describeState(state)
        : `The media application accepted the ${action} request; its reported state is ${state.playbackStatus}.`
      : `The media application accepted the ${action === 'nextTrack' ? 'next' : 'previous'} request. ${describeState(state)}`
  return { ok: true, message, data: state }
}
