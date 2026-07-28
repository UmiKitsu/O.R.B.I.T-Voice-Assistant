import { z } from 'zod'
import type { ActionResult, ChatMessage } from '../../shared/types'
import { structuredChatWithExactModel } from './ollamaService'
import type { SpotifyPlaybackIntent } from './spotifyService'

const classificationSchema = z
  .object({
    intent: z.enum(['track', 'artist'])
  })
  .strict()

const CLASSIFIER_MODEL = 'qwen3:8b'

type StructuredChat = (
  messages: ChatMessage[],
  format: Record<string, unknown>,
  model: string,
  signal?: AbortSignal
) => Promise<ActionResult<{ response: string }>>

export type SpotifyIntentClassifierDependencies = {
  chat?: StructuredChat
}

export async function classifySpotifyPlaybackIntent(
  query: string,
  signal?: AbortSignal,
  dependencies: SpotifyIntentClassifierDependencies = {}
): Promise<SpotifyPlaybackIntent> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Classify the exact Spotify query as either an artist name or a track title. Return only {"intent":"artist"} or {"intent":"track"}. Never rewrite the query, add a capability, or produce executable input. Examples: "Bruno Mars" is artist; "Locked Out of Heaven" is track.'
    },
    { role: 'user', content: query }
  ]

  try {
    const result = await (dependencies.chat ?? structuredChatWithExactModel)(
      messages,
      z.toJSONSchema(classificationSchema),
      CLASSIFIER_MODEL,
      signal
    )
    if (!result.ok) return 'track'

    const parsedJson: unknown = JSON.parse(result.data?.response ?? '')
    const parsed = classificationSchema.safeParse(parsedJson)
    return parsed.success ? parsed.data.intent : 'track'
  } catch {
    return 'track'
  }
}
