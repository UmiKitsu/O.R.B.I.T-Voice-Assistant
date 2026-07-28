import { describe, expect, it } from 'vitest'
import {
  BROWSER_PROTOCOL_VERSION,
  authHelloSchema,
  browserCommandEnvelopeSchema,
  createBrowserMac,
  extensionStatusSchema,
  isFreshTimestamp,
  isMonotonicSequence,
  stableJson,
  verifyBrowserMac
} from './browserBridgeProtocol'

const SECRET = Buffer.alloc(32, 7)

 describe('browser bridge protocol', () => {
  it('canonicalizes object keys before authentication', () => {
    expect(stableJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}')
  })

  it('authenticates exact payloads and rejects tampering', () => {
    const payload = {
      type: 'command' as const,
      version: BROWSER_PROTOCOL_VERSION,
      requestId: '38ca37a9-8d36-4e8a-a3e3-73d2676402cc',
      sequence: 1,
      capability: 'browser.reload' as const,
      parameters: {},
      deadline: 2_000_000_000_000
    }
    const mac = createBrowserMac(SECRET, 'command', payload)
    expect(verifyBrowserMac(SECRET, 'command', payload, mac)).toBe(true)
    expect(verifyBrowserMac(SECRET, 'command', { ...payload, sequence: 2 }, mac)).toBe(false)
    expect(verifyBrowserMac(Buffer.alloc(32, 8), 'command', payload, mac)).toBe(false)
  })

  it('rejects unregistered commands and extra envelope fields', () => {
    expect(
      browserCommandEnvelopeSchema.safeParse({
        type: 'command',
        version: 1,
        requestId: '38ca37a9-8d36-4e8a-a3e3-73d2676402cc',
        sequence: 1,
        capability: 'browser.executeJavaScript',
        parameters: {},
        deadline: Date.now() + 1_000,
        mac: 'a'.repeat(64)
      }).success
    ).toBe(false)
    expect(
      browserCommandEnvelopeSchema.safeParse({
        type: 'command',
        version: 1,
        requestId: '38ca37a9-8d36-4e8a-a3e3-73d2676402cc',
        sequence: 1,
        capability: 'browser.reload',
        parameters: {},
        deadline: Date.now() + 1_000,
        mac: 'a'.repeat(64),
        selector: '#danger'
      }).success
    ).toBe(false)
  })

  it('accepts Chrome host permission patterns but not arbitrary strings', () => {
    expect(
      extensionStatusSchema.safeParse({
        type: 'extension_status',
        version: 1,
        grantedOrigins: ['https://www.youtube.com/*', 'http://*/*', 'https://example.com/*'],
        activeTabOrigin: 'https://example.com'
      }).success
    ).toBe(true)
    expect(
      extensionStatusSchema.safeParse({
        type: 'extension_status',
        version: 1,
        grantedOrigins: ['chrome://extensions/*']
      }).success
    ).toBe(false)
  })

  it('rejects replayed and out-of-order sequence numbers', () => {
    expect(isMonotonicSequence(1, 0)).toBe(true)
    expect(isMonotonicSequence(2, 1)).toBe(true)
    expect(isMonotonicSequence(2, 2)).toBe(false)
    expect(isMonotonicSequence(1, 2)).toBe(false)
    expect(isMonotonicSequence(0, 0)).toBe(false)
  })

  it('requires a fresh nonce-auth timestamp and an extension origin', () => {
    const now = 1_000_000
    expect(isFreshTimestamp(now - 29_999, now)).toBe(true)
    expect(isFreshTimestamp(now - 30_001, now)).toBe(false)
    expect(
      authHelloSchema.safeParse({
        type: 'auth_hello',
        version: 1,
        extensionOrigin: 'https://example.com',
        extensionVersion: '1.0.0',
        nonce: 'n'.repeat(32),
        timestamp: now,
        mac: 'a'.repeat(64)
      }).success
    ).toBe(false)
  })
})
