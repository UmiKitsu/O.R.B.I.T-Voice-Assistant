import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import {
  openYouTubeMusicSearch,
  playSpotifyTopResult,
  type MusicPlaybackData,
  type SpotifyPlaybackDependencies
} from '../services/spotifyService'
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
    'The music query must contain only plain text.'
  )

const parametersSchema = z.object({ query: musicQuerySchema }).strict()
const dataSchema = z.union([
  z
    .object({
      application: z.literal('spotify'),
      query: z.string(),
      method: z.literal('desktop')
    })
    .strict(),
  z
    .object({
      application: z.literal('spotify'),
      query: z.string(),
      title: z.string(),
      artist: z.string(),
      method: z.literal('web-api')
    })
    .strict(),
  z
    .object({
      application: z.literal('youtube'),
      query: z.string(),
      method: z.enum(['browser-search', 'spotify-fallback'])
    })
    .strict()
])

type Parameters = z.infer<typeof parametersSchema>

export type SpotifyCapabilityDependencies = SpotifyPlaybackDependencies

function definition(
  name: string,
  execute: CapabilityDefinition<Parameters, ActionResult<MusicPlaybackData>>['execute']
): CapabilityDefinition<Parameters, ActionResult<MusicPlaybackData>> {
  return {
    name,
    risk: 'automatic',
    timeoutMs: 30_000,
    execute
  }
}

export function registerSpotifyCapabilities(
  registry: CapabilityRegistry,
  dependencies: SpotifyCapabilityDependencies = {}
): void {
  registry.register(
    definition('spotify.playSearch', ({ query }, signal) =>
      playSpotifyTopResult(query, signal, dependencies)
    ),
    parametersSchema,
    actionResultSchema(dataSchema)
  )

  registry.register(
    definition('youtube.playSearch', async ({ query }, signal) => {
      if (signal.aborted) {
        return {
          ok: false,
          code: 'ACTION_CANCELLED',
          message: 'The request was cancelled.',
          recoverable: true
        }
      }
      return openYouTubeMusicSearch(query, dependencies.openExternalUrl)
    }),
    parametersSchema,
    actionResultSchema(dataSchema)
  )

  registry.register(
    definition('music.playSearch', ({ query }, signal) =>
      playSpotifyTopResult(query, signal, dependencies)
    ),
    parametersSchema,
    actionResultSchema(dataSchema)
  )
}
