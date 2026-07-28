import { describe, expect, it, vi } from 'vitest'
import type { ActionResult, ChatMessage } from '../../shared/types'
import { classifySpotifyPlaybackIntent } from './spotifyIntentClassifier'

function successfulResponse(response: string): ActionResult<{ response: string }> {
  return {
    ok: true as const,
    message: 'Orbit responded.',
    data: { response }
  }
}

describe('Spotify playback intent classifier', () => {
  it.each([
    ['Bruno Mars', '{"intent":"artist"}', 'artist'],
    ['Locked Out of Heaven', '{"intent":"track"}', 'track']
  ] as const)('classifies %s without rewriting the query', async (query, response, expected) => {
    const chat = vi.fn(
      async (
        messages: ChatMessage[],
        format: Record<string, unknown>,
        model: string,
        signal?: AbortSignal
      ): Promise<ActionResult<{ response: string }>> => {
        void messages
        void format
        void model
        void signal
        return successfulResponse(response)
      }
    )

    await expect(classifySpotifyPlaybackIntent(query, undefined, { chat })).resolves.toBe(expected)

    const messages = chat.mock.calls[0]?.[0]
    expect(messages?.at(-1)).toEqual({ role: 'user', content: query })
    expect(messages?.[0]?.content).toContain('Never rewrite the query')
    expect(chat.mock.calls[0]?.[2]).toBe('qwen3:8b')
  })

  it.each([
    'not-json',
    '{}',
    '{"intent":"album"}',
    '{"intent":"artist","query":"rewritten"}'
  ])('falls back to track for invalid output: %s', async (response) => {
    const chat = vi.fn(async () => successfulResponse(response))
    await expect(classifySpotifyPlaybackIntent('Bruno Mars', undefined, { chat })).resolves.toBe(
      'track'
    )
  })

  it.each([
    {
      ok: false as const,
      code: 'OLLAMA_IDLE_TIMEOUT',
      message: 'Timed out.',
      recoverable: true
    },
    {
      ok: false as const,
      code: 'OLLAMA_NETWORK_ERROR',
      message: 'Unavailable.',
      recoverable: true
    }
  ])('falls back to track when local classification is unavailable', async (result) => {
    const chat = vi.fn(async () => result)
    await expect(classifySpotifyPlaybackIntent('Bruno Mars', undefined, { chat })).resolves.toBe(
      'track'
    )
  })

  it('falls back to track if the classifier throws', async () => {
    const chat = vi.fn(async () => {
      throw new Error('Ollama stopped')
    })
    await expect(classifySpotifyPlaybackIntent('Bruno Mars', undefined, { chat })).resolves.toBe(
      'track'
    )
  })
})
