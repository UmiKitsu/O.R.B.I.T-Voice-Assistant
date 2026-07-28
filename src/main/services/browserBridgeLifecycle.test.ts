import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalWebSocketConnection } from './localWebSocketServer'

const EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const EXTENSION_VERSION = '1.1.0'

const harness = vi.hoisted(() => ({
  storedFile: undefined as Buffer | undefined,
  failPorts: new Set<number>(),
  activePort: undefined as number | undefined,
  acceptConnection: undefined as ((connection: LocalWebSocketConnection) => void) | undefined,
  listenedPorts: [] as number[],
  events: [] as Array<Record<string, unknown>>
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/OrbitBridgeHarness'),
    getAppPath: vi.fn(() => 'C:/OrbitProject'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
  }
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => {
    if (!harness.storedFile) throw new Error('missing')
    return Buffer.from(harness.storedFile)
  }),
  writeFile: vi.fn(async (_path: string, value: Buffer) => {
    harness.storedFile = Buffer.from(value)
  }),
  unlink: vi.fn(async () => {
    harness.storedFile = undefined
  })
}))

vi.mock('./settingsService', () => ({
  getSettings: vi.fn(() => ({ browserControlEnabled: true }))
}))

vi.mock('./loggerService', () => ({
  logOperationalEvent: vi.fn((event: Record<string, unknown>) => {
    harness.events.push({ ...event })
  })
}))

vi.mock('./localWebSocketServer', () => ({
  createLocalWebSocketServer: vi.fn(
    (_path: string, acceptConnection: (connection: LocalWebSocketConnection) => void) => ({
      listen: vi.fn(async (port: number) => {
        harness.listenedPorts.push(port)
        if (harness.failPorts.has(port)) throw new Error('port unavailable')
        harness.activePort = port
        harness.acceptConnection = acceptConnection
      }),
      close: vi.fn(async () => undefined)
    })
  )
}))

import {
  BROWSER_PROTOCOL_VERSION,
  createBrowserMac
} from './browserBridgeProtocol'
import {
  beginBrowserPairing,
  getBrowserStatus,
  initializeBrowserBridgeService,
  resetBrowserBridgeServiceForTests,
  stopBrowserBridgeService
} from './browserBridgeService'

type SentMessage = Record<string, unknown>

class FakeConnection implements LocalWebSocketConnection {
  readonly origin = EXTENSION_ORIGIN
  readonly remoteAddress = '127.0.0.1'
  readonly sent: SentMessage[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private messageListener: ((value: unknown) => void) | undefined
  private closeListener: (() => void) | undefined
  private closed = false

  sendJson(value: unknown): void {
    this.sent.push(value as SentMessage)
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return
    this.closed = true
    this.closes.push({ code, reason })
    this.closeListener?.()
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener
  }

  onClose(listener: () => void): void {
    this.closeListener = listener
  }

  emit(value: unknown): void {
    this.messageListener?.(value)
  }
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

async function waitForMessage(connection: FakeConnection, type: string): Promise<SentMessage> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const message = connection.sent.find((candidate) => candidate.type === type)
    if (message) return message
    await Promise.resolve()
  }
  throw new Error(`Timed out waiting for ${type}.`)
}

function attachConnection(): FakeConnection {
  if (!harness.acceptConnection) throw new Error('The bridge is not listening.')
  const connection = new FakeConnection()
  harness.acceptConnection(connection)
  return connection
}

async function pairExtension(): Promise<string> {
  const session = await beginBrowserPairing()
  const connection = attachConnection()
  connection.emit({
    type: 'pair',
    version: BROWSER_PROTOCOL_VERSION,
    code: session.code,
    extensionOrigin: EXTENSION_ORIGIN,
    extensionVersion: EXTENSION_VERSION
  })
  const response = await waitForMessage(connection, 'pair_success')
  expect(connection.closes).toContainEqual({
    code: 4000,
    reason: 'Reconnect with authentication'
  })
  expect(typeof response.secret).toBe('string')
  return response.secret as string
}

async function authenticateExtension(
  secret: string,
  nonce = 'n'.repeat(32)
): Promise<FakeConnection> {
  const connection = attachConnection()
  const hello = {
    type: 'auth_hello' as const,
    version: BROWSER_PROTOCOL_VERSION,
    extensionOrigin: EXTENSION_ORIGIN,
    extensionVersion: EXTENSION_VERSION,
    nonce,
    timestamp: Date.now()
  }
  connection.emit({
    ...hello,
    mac: createBrowserMac(Buffer.from(secret, 'base64'), 'auth-client', hello)
  })
  const challenge = await waitForMessage(connection, 'auth_challenge')
  const ack = {
    type: 'auth_ack' as const,
    version: BROWSER_PROTOCOL_VERSION,
    clientNonce: challenge.clientNonce as string,
    serverNonce: challenge.serverNonce as string
  }
  connection.emit({
    ...ack,
    mac: createBrowserMac(Buffer.from(secret, 'base64'), 'auth-ack', ack)
  })
  await waitForMessage(connection, 'authenticated')
  return connection
}

beforeEach(() => {
  resetBrowserBridgeServiceForTests()
  harness.storedFile = undefined
  harness.failPorts.clear()
  harness.activePort = undefined
  harness.acceptConnection = undefined
  harness.listenedPorts.length = 0
  harness.events.length = 0
})

afterEach(async () => {
  vi.useRealTimers()
  await stopBrowserBridgeService()
  resetBrowserBridgeServiceForTests()
})

describe('browser bridge lifecycle harness', () => {
  it('completes pairing only after the forced authenticated reconnect', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension()

    expect(getBrowserStatus()).toMatchObject({
      paired: false,
      connected: false,
      phase: 'authenticating',
      activePort: 43117
    })

    await authenticateExtension(secret)

    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      connected: true,
      phase: 'connected',
      activePort: 43117,
      extensionVersion: EXTENSION_VERSION
    })
    expect(JSON.stringify(getBrowserStatus())).not.toMatch(/secret|nonce|hmac|mac/i)
    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'browser.bridge-listening', port: 43117 }),
        expect.objectContaining({ event: 'browser.pairing-stored', port: 43117 }),
        expect.objectContaining({ event: 'browser.authenticated', port: 43117 })
      ])
    )
  })

  it('rejects a wrong secret without exposing authentication material', async () => {
    await initializeBrowserBridgeService()
    await pairExtension()
    const connection = attachConnection()
    const hello = {
      type: 'auth_hello' as const,
      version: BROWSER_PROTOCOL_VERSION,
      extensionOrigin: EXTENSION_ORIGIN,
      extensionVersion: EXTENSION_VERSION,
      nonce: 'w'.repeat(32),
      timestamp: Date.now()
    }
    connection.emit({
      ...hello,
      mac: createBrowserMac(Buffer.alloc(32, 9), 'auth-client', hello)
    })
    await flushAsyncWork()

    expect(connection.sent).toContainEqual(
      expect.objectContaining({
        type: 'protocol_error',
        code: 'AUTHENTICATION_FAILED'
      })
    )
    expect(connection.closes).toContainEqual({ code: 1008, reason: 'Authentication failed' })
    expect(JSON.stringify(connection.sent)).not.toMatch(/secret|nonce|hmac/i)
  })

  it('returns the explicit reload error for a stale extension protocol', async () => {
    await initializeBrowserBridgeService()
    const session = await beginBrowserPairing()
    const connection = attachConnection()
    connection.emit({
      type: 'pair',
      version: BROWSER_PROTOCOL_VERSION - 1,
      code: session.code,
      extensionOrigin: EXTENSION_ORIGIN,
      extensionVersion: '1.0.0'
    })
    await flushAsyncWork()

    expect(connection.sent).toContainEqual(
      expect.objectContaining({
        type: 'protocol_error',
        code: 'BROWSER_PROTOCOL_INCOMPATIBLE',
        message: 'Reload the Orbit Browser Control extension to use the current browser protocol.'
      })
    )
    expect(getBrowserStatus()).toMatchObject({
      connected: false,
      phase: 'error',
      lastError: { code: 'BROWSER_PROTOCOL_INCOMPATIBLE' }
    })
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        event: 'browser.protocol-incompatible',
        code: 'BROWSER_PROTOCOL_INCOMPATIBLE'
      })
    )
  })

  it('replaces an older authenticated socket with the newest connection', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension()
    const first = await authenticateExtension(secret, 'a'.repeat(32))
    const second = await authenticateExtension(secret, 'b'.repeat(32))

    expect(first.closes).toContainEqual({
      code: 4001,
      reason: 'A newer Orbit connection replaced this connection'
    })
    expect(second.closes).toHaveLength(0)
    expect(getBrowserStatus()).toMatchObject({ connected: true, phase: 'connected' })
  })

  it('closes an authenticated connection after sixty seconds without contact', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))
    await initializeBrowserBridgeService()
    const secret = await pairExtension()
    const connection = await authenticateExtension(secret)

    await vi.advanceTimersByTimeAsync(80_001)

    expect(connection.closes).toContainEqual({
      code: 4004,
      reason: 'Authenticated heartbeat timeout'
    })
    expect(getBrowserStatus()).toMatchObject({
      connected: false,
      phase: 'reconnecting',
      lastError: { code: 'BROWSER_HEARTBEAT_TIMEOUT' }
    })
    expect(harness.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'browser.disconnected' }),
        expect.objectContaining({
          event: 'browser.retry-scheduled',
          code: 'BROWSER_HEARTBEAT_TIMEOUT'
        })
      ])
    )
  })

  it('rotates away from an unavailable saved port and persists the replacement', async () => {
    harness.failPorts.add(43117)
    harness.storedFile = Buffer.from(
      JSON.stringify({
        version: 2,
        extensionOrigin: EXTENSION_ORIGIN,
        secret: Buffer.alloc(32, 3).toString('base64'),
        port: 43117,
        confirmed: true
      }),
      'utf8'
    )

    await initializeBrowserBridgeService()

    expect(harness.listenedPorts.slice(0, 2)).toEqual([43117, 43118])
    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      connected: false,
      phase: 'connecting',
      activePort: 43118
    })
    expect(JSON.parse(harness.storedFile?.toString('utf8') ?? '{}')).toMatchObject({ port: 43118 })
  })

  it('re-authenticates after Orbit or Chrome restarts without re-pairing', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension()
    const first = await authenticateExtension(secret)
    first.close(1001, 'Chrome restarted')
    await flushAsyncWork()

    const restartedChrome = await authenticateExtension(secret, 'c'.repeat(32))
    expect(restartedChrome.sent).toContainEqual(expect.objectContaining({ type: 'authenticated' }))

    await stopBrowserBridgeService()
    resetBrowserBridgeServiceForTests()
    harness.activePort = undefined
    harness.acceptConnection = undefined
    await initializeBrowserBridgeService()

    expect(getBrowserStatus()).toMatchObject({ paired: true, connected: false, phase: 'connecting' })
    const restartedOrbit = await authenticateExtension(secret, 'd'.repeat(32))
    expect(restartedOrbit.sent).toContainEqual(expect.objectContaining({ type: 'authenticated' }))
    expect(getBrowserStatus()).toMatchObject({ paired: true, connected: true, phase: 'connected' })
  })
})
