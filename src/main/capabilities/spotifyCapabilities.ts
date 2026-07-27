import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import type { ApplicationLauncher } from '../services/applicationDiscoveryService'
import { playSpotifyTopResult, type SpotifyPlaybackController } from '../services/spotifyService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const spotifyQuerySchema = z
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
    'The Spotify query must contain only plain text.'
  )

const parametersSchema = z.object({ query: spotifyQuerySchema }).strict()
const dataSchema = z.object({ application: z.literal('spotify'), query: z.string() }).strict()

type Parameters = z.infer<typeof parametersSchema>
type Data = z.infer<typeof dataSchema>

export type SpotifyCapabilityDependencies = {
  controller?: SpotifyPlaybackController
  launcher?: ApplicationLauncher
  delay?: (milliseconds: number) => Promise<void>
  now?: () => number
}

export function registerSpotifyCapabilities(
  registry: CapabilityRegistry,
  dependencies: SpotifyCapabilityDependencies = {}
): void {
  const definition: CapabilityDefinition<Parameters, ActionResult<Data>> = {
    name: 'spotify.playSearch',
    risk: 'automatic',
    timeoutMs: 15_000,
    execute: ({ query }, signal) => playSpotifyTopResult(query, signal, dependencies)
  }

  registry.register(definition, parametersSchema, actionResultSchema(dataSchema))
}
