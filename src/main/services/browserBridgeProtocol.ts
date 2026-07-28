import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { BrowserCommandResult } from '../../shared/types'

export const BROWSER_PROTOCOL_VERSION = 2 as const
export const BROWSER_MAX_MESSAGE_BYTES = 64 * 1024
export const BROWSER_REQUEST_TTL_MS = 60_000
export const BROWSER_AUTH_CLOCK_SKEW_MS = 30_000

export const registeredBrowserCapabilities = [
  'browser.openUrl',
  'browser.searchWeb',
  'browser.searchYouTube',
  'browser.newTab',
  'browser.closeTab',
  'browser.switchTab',
  'browser.goBack',
  'browser.goForward',
  'browser.reload',
  'browser.scroll',
  'youtube.playSearch',
  'youtube.play',
  'youtube.pause',
  'youtube.next',
  'youtube.previous',
  'youtube.playPause',
  'youtube.seekBy',
  'youtube.setVolume',
  'youtube.mute',
  'youtube.unmute',
  'youtube.fullscreen',
  'youtube.getPlaybackState',
  'browser.readVisiblePage',
  'browser.clickSafe',
  'browser.typeSafeText',
  'browser.selectOption',
  'browser.submitConsequential'
] as const

export type RegisteredBrowserCapability = (typeof registeredBrowserCapabilities)[number]

const browserCapabilitySchema = z.enum(registeredBrowserCapabilities)

export const browserCommandEnvelopeSchema = z
  .object({
    type: z.literal('command'),
    version: z.literal(BROWSER_PROTOCOL_VERSION),
    requestId: z.uuid(),
    sequence: z.number().int().positive(),
    capability: browserCapabilitySchema,
    parameters: z.record(z.string(), z.unknown()),
    deadline: z.number().int().positive(),
    mac: z.string().regex(/^[a-f0-9]{64}$/i)
  })
  .strict()

const browserCommandSuccessSchema = z
  .object({
    ok: z.literal(true),
    message: z.string().trim().min(1).max(1_000),
    data: z.unknown().optional()
  })
  .strict()

const browserCommandFailureSchema = z
  .object({
    ok: z.literal(false),
    code: z.string().trim().min(1).max(100),
    message: z.string().trim().min(1).max(1_000),
    recoverable: z.boolean()
  })
  .strict()

export const browserCommandResponseSchema = z
  .object({
    type: z.literal('command_result'),
    version: z.literal(BROWSER_PROTOCOL_VERSION),
    requestId: z.uuid(),
    sequence: z.number().int().positive(),
    result: z.discriminatedUnion('ok', [browserCommandSuccessSchema, browserCommandFailureSchema]),
    mac: z.string().regex(/^[a-f0-9]{64}$/i)
  })
  .strict()

export const pairRequestSchema = z
  .object({
    type: z.literal('pair'),
    version: z.literal(BROWSER_PROTOCOL_VERSION),
    code: z.string().regex(/^\d{6}$/),
    extensionOrigin: z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/),
    extensionVersion: z.string().trim().min(1).max(50)
  })
  .strict()

export const authHelloSchema = z
  .object({
    type: z.literal('auth_hello'),
    version: z.literal(BROWSER_PROTOCOL_VERSION),
    extensionOrigin: z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/),
    extensionVersion: z.string().trim().min(1).max(50),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    timestamp: z.number().int().positive(),
    mac: z.string().regex(/^[a-f0-9]{64}$/i)
  })
  .strict()

export const authAckSchema = z
  .object({
    type: z.literal('auth_ack'),
    version: z.literal(BROWSER_PROTOCOL_VERSION),
    clientNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    serverNonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    mac: z.string().regex(/^[a-f0-9]{64}$/i)
  })
  .strict()

function isExactHttpOriginPattern(value: string): boolean {
  if (!value.endsWith('/*')) return false
  const origin = value.slice(0, -2)
  try {
    const url = new URL(origin)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hostname.includes('*') &&
      url.origin === origin
    )
  } catch {
    return false
  }
}

export const extensionStatusSchema = z
  .object({
    type: z.literal('extension_status'),
    version: z.literal(BROWSER_PROTOCOL_VERSION),
    grantedOrigins: z
      .array(
        z
          .string()
          .trim()
          .min(6)
          .max(500)
          .refine(isExactHttpOriginPattern, 'An exact HTTP(S) origin grant is required.')
      )
      .max(200),
    activeTabOrigin: z.string().url().optional()
  })
  .strict()

export type BrowserCommandEnvelope = z.infer<typeof browserCommandEnvelopeSchema>
export type BrowserCommandResponse = z.infer<typeof browserCommandResponseSchema>

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalizeJson(nested)])
  )
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value))
}

export function createBrowserMac(secret: Buffer, purpose: string, payload: unknown): string {
  return createHmac('sha256', secret)
    .update(`${purpose}\n${stableJson(payload)}`, 'utf8')
    .digest('hex')
}

export function verifyBrowserMac(
  secret: Buffer,
  purpose: string,
  payload: unknown,
  receivedMac: string
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(receivedMac)) return false
  const expected = Buffer.from(createBrowserMac(secret, purpose, payload), 'hex')
  const received = Buffer.from(receivedMac, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export function commandMacPayload(
  envelope: Omit<BrowserCommandEnvelope, 'mac'>
): Omit<BrowserCommandEnvelope, 'mac'> {
  return envelope
}

export function responseMacPayload(response: {
  version: 2
  requestId: string
  sequence: number
  result: BrowserCommandResult<unknown>
}): typeof response {
  return response
}

export function isFreshTimestamp(timestamp: number, now = Date.now()): boolean {
  return Math.abs(now - timestamp) <= BROWSER_AUTH_CLOCK_SKEW_MS
}

export function isMonotonicSequence(next: number, previous: number): boolean {
  return Number.isInteger(next) && next > 0 && Number.isInteger(previous) && previous >= 0 && next > previous
}
