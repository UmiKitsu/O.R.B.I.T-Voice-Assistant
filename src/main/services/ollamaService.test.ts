import { afterEach, describe, expect, it, vi } from 'vitest'
import { structuredChat } from './ollamaService'

describe('structuredChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['wrong role', { message: { role: 'user', content: 'Hello' } }],
    ['missing message', { response: 'Hello' }],
    ['empty content', { message: { role: 'assistant', content: '   ' } }],
    ['non-string content', { message: { role: 'assistant', content: 42 } }]
  ])('rejects an Ollama response with %s', async (_case, body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    )

    await expect(structuredChat([], {})).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_INVALID_RESPONSE'
    })
  })

  it('rejects malformed JSON and unsuccessful HTTP responses', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('not-json', { status: 200 }))
      .mockResolvedValueOnce(new Response('failed', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(structuredChat([], {})).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_INVALID_RESPONSE'
    })
    await expect(structuredChat([], {})).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_CHAT_FAILED'
    })
  })
  it('sends a non-thinking, non-streaming request with the supplied JSON schema', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: '{"kind":"conversation","response":"Hi"}' }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', fetchMock)
    const format = { type: 'object', additionalProperties: false }

    await expect(
      structuredChat([{ role: 'user', content: 'Hello' }], format)
    ).resolves.toMatchObject({ ok: true })

    const request = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: 'qwen3:8b',
      think: false,
      stream: false,
      format
    })
  })
})
