import { z } from 'zod'
import type { ActionResult, MediaSessionState } from '../../shared/types'
import {
  controlMediaSession,
  getMediaPlaybackState,
  getMediaSessions,
  mediaSessionStateSchema
} from '../services/mediaSessionService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const sourceSchema = z.object({ sourceApplication: z.string().trim().max(120) }).strict()
const sessionsResultSchema = z
  .object({ sessions: z.array(mediaSessionStateSchema).max(50) })
  .strict()

export function registerMediaSessionCapabilities(registry: CapabilityRegistry): void {
  const list: CapabilityDefinition<
    Record<string, never>,
    ActionResult<{ sessions: MediaSessionState[] }>
  > = {
    name: 'media.getSessions',
    risk: 'automatic',
    timeoutMs: 20_000,
    execute: async (_parameters, signal) => getMediaSessions(signal)
  }
  registry.register(list, z.object({}).strict(), actionResultSchema(sessionsResultSchema))

  const state: CapabilityDefinition<
    z.infer<typeof sourceSchema>,
    ActionResult<MediaSessionState>
  > = {
    name: 'media.getPlaybackState',
    risk: 'automatic',
    timeoutMs: 20_000,
    execute: async ({ sourceApplication }, signal) =>
      getMediaPlaybackState(sourceApplication, signal)
  }
  registry.register(state, sourceSchema, actionResultSchema(mediaSessionStateSchema))

  for (const action of ['play', 'pause', 'nextTrack', 'previousTrack'] as const) {
    const definition: CapabilityDefinition<
      z.infer<typeof sourceSchema>,
      ActionResult<MediaSessionState>
    > = {
      name: `media.${action}`,
      risk: 'automatic',
      timeoutMs: 20_000,
      execute: async ({ sourceApplication }, signal) =>
        controlMediaSession(action, sourceApplication, signal)
    }
    registry.register(definition, sourceSchema, actionResultSchema(mediaSessionStateSchema))
  }
}
