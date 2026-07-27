import { afterEach, describe, expect, it, vi } from 'vitest'
import { structuredChat } from './ollamaService'

describe('structuredChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
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
