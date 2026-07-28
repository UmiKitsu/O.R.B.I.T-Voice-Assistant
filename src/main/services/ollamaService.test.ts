import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  resetOllamaServiceForTests,
  structuredChat,
  structuredChatWithExactModel,
  structuredVisionChat
} from './ollamaService'

const PRIMARY_MODEL = 'qwen3.5:9b-q4_K_M'
const FALLBACK_MODEL = 'qwen3:8b'
const VISION_MODEL = 'qwen3-vl:4b'

function tagsResponse(models = [PRIMARY_MODEL, FALLBACK_MODEL]): Response {
  return Response.json({ models: models.map((name) => ({ name })) })
}

function streamResponse(lines: unknown[]): Response {
  return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
    status: 200,
    headers: { 'Content-Type': 'application/x-ndjson' }
  })
}

function validStream(content = '{"kind":"conversation","response":"Hi"}'): Response {
  const midpoint = Math.floor(content.length / 2)
  return streamResponse([
    { message: { role: 'assistant', content: content.slice(0, midpoint) }, done: false },
    {
      message: { role: 'assistant', content: content.slice(midpoint) },
      done: true,
      load_duration: 2_000_000,
      prompt_eval_duration: 3_000_000,
      eval_duration: 4_000_000,
      total_duration: 9_000_000
    }
  ])
}

function installFetch(
  chatResponse: Response,
  models = [PRIMARY_MODEL, FALLBACK_MODEL]
): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input)
    if (url.endsWith('/api/tags')) return tagsResponse(models)
    if (url.endsWith('/api/chat')) return chatResponse
    throw new Error(`Unexpected Ollama URL: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('structuredChat streaming', () => {
  afterEach(() => {
    resetOllamaServiceForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    ['wrong role', { message: { role: 'user', content: 'Hello' }, done: true }],
    ['missing message', { response: 'Hello', done: true }],
    ['empty content', { message: { role: 'assistant', content: '   ' }, done: true }],
    ['non-string content', { message: { role: 'assistant', content: 42 }, done: true }]
  ])('rejects an NDJSON response with %s', async (_case, line) => {
    installFetch(streamResponse([line]))

    await expect(structuredChat([], {})).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_INVALID_RESPONSE'
    })
  })

  it('rejects malformed NDJSON and unsuccessful HTTP responses', async () => {
    const responses = [
      new Response('not-json\n', { status: 200 }),
      new Response('failed', { status: 500 })
    ]
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) return tagsResponse()
      const response = responses.shift()
      if (!response) throw new Error('No mocked chat response remains.')
      return response
    })
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

  it('streams non-thinking JSON with bounded context and a fifteen-minute keep-alive', async () => {
    const fetchMock = installFetch(validStream())
    const format = { type: 'object', additionalProperties: false }

    await expect(
      structuredChat([{ role: 'user', content: 'Hello' }], format)
    ).resolves.toMatchObject({
      ok: true,
      data: { response: '{"kind":"conversation","response":"Hi"}' }
    })

    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/chat'))
    const body = JSON.parse(String(chatCall?.[1]?.body))
    expect(body).toMatchObject({
      model: PRIMARY_MODEL,
      think: false,
      stream: true,
      keep_alive: '15m',
      format: 'json',
      options: {
        num_ctx: 8_192,
        num_predict: 512,
        temperature: 0.1
      }
    })
  })

  it('uses the installed qwen3:8b performance fallback when the configured model is absent', async () => {
    const fetchMock = installFetch(validStream(), [FALLBACK_MODEL])

    await expect(structuredChat([], {})).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining(FALLBACK_MODEL)
    })
    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/chat'))
    expect(JSON.parse(String(chatCall?.[1]?.body)).model).toBe(FALLBACK_MODEL)
  })

  it('uses an exact requested model without allowing configured-model substitution', async () => {
    const fetchMock = installFetch(validStream(), [PRIMARY_MODEL, FALLBACK_MODEL])

    await expect(structuredChatWithExactModel([], {}, FALLBACK_MODEL)).resolves.toMatchObject({
      ok: true
    })

    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/chat'))
    expect(JSON.parse(String(chatCall?.[1]?.body))).toMatchObject({
      model: FALLBACK_MODEL,
      think: false,
      format: 'json'
    })
  })

  it('reports an unavailable exact model instead of substituting another model', async () => {
    const fetchMock = installFetch(validStream(), [PRIMARY_MODEL])

    await expect(structuredChatWithExactModel([], {}, FALLBACK_MODEL)).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_MODEL_MISSING'
    })
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/chat'))).toBe(false)
  })

  it('reports a 30-second inactivity timeout for a stalled stream', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) return tagsResponse()
      return new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'))
            })
          }
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const pending = structuredChat([], {})
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_IDLE_TIMEOUT'
    })
  })

  it('keeps vision lazy with a separate three-minute lifetime and bounded request', async () => {
    const progress = vi.fn()
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) {
        return tagsResponse([PRIMARY_MODEL, FALLBACK_MODEL, VISION_MODEL])
      }
      if (url.endsWith('/api/chat')) {
        return Response.json({
          message: {
            role: 'assistant',
            content: '',
            thinking: '{"summary":"Window","targets":[]}'
          }
        })
      }
      throw new Error(`Unexpected Ollama URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      structuredVisionChat('Find the play button', 'aGVsbG8=', VISION_MODEL, undefined, progress)
    ).resolves.toMatchObject({
      ok: true,
      data: { response: '{"summary":"Window","targets":[]}' }
    })

    const chatCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/chat'))
    const body = JSON.parse(String(chatCall?.[1]?.body))
    expect(body).toMatchObject({
      model: VISION_MODEL,
      think: false,
      stream: false,
      keep_alive: '3m',
      format: 'json',
      options: { num_ctx: 4096, num_predict: 256, temperature: 0.05 }
    })
    expect(body.messages).toHaveLength(2)
    expect(body.messages[1].images).toEqual(['aGVsbG8='])
    expect(progress.mock.calls.map(([value]) => value.phase)).toEqual([
      'loading',
      'generating',
      'validating'
    ])
  })

  it('reports a missing exact vision model without falling back to a text model', async () => {
    const fetchMock = installFetch(validStream(), [PRIMARY_MODEL, FALLBACK_MODEL])

    await expect(
      structuredVisionChat('Inspect this window', 'aGVsbG8=', VISION_MODEL)
    ).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_MODEL_MISSING'
    })
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/chat'))).toBe(false)
  })

  it('rejects malformed non-streaming vision output', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/tags')) return tagsResponse([VISION_MODEL])
      if (url.endsWith('/api/chat')) {
        return Response.json({ message: { role: 'assistant', content: 42 } })
      }
      throw new Error(`Unexpected Ollama URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      structuredVisionChat('Inspect this window', 'aGVsbG8=', VISION_MODEL)
    ).resolves.toMatchObject({
      ok: false,
      code: 'OLLAMA_INVALID_RESPONSE'
    })
  })
})
