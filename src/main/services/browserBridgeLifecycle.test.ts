import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalWebSocketConnection } from './localWebSocketServer'

const EXTENSION_ID = 'bpnhommpdnofjjgbgjoehmdjglfglkje'
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`
const LEGACY_EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const EXTENSION_VERSION = '1.2.0'

const harness = vi.hoisted(() => ({
  storedFile: undefined as Buffer | undefined,
  temporaryFiles: new Map<string, Buffer>(),
  decryptFails: false,
  failPorts: new Set<number>(),
  activePort: undefined as number | undefined,
  acceptConnection: undefined as ((connection: LocalWebSocketConnection) => void) | undefined,
  listenedPorts: [] as number[],
  events: [] as Array<Record<string, unknown>>
}))

function missingFileError(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' })
}

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:/OrbitBridgeHarness'),
    getAppPath: vi.fn(() => 'C:/OrbitProject'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => {
      if (harness.decryptFails) throw new Error('decrypt failed')
      return value.toString('utf8')
    })
  }
}))

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => {
    if (!harness.storedFile) throw missingFileError()
    return Buffer.from(harness.storedFile)
  }),
  writeFile: vi.fn(async (path: string, value: Buffer) => {
    harness.temporaryFiles.set(path, Buffer.from(value))
  }),
  rename: vi.fn(async (from: string) => {
    const value = harness.temporaryFiles.get(from)
    if (!value) throw missingFileError()
    harness.storedFile = Buffer.from(value)
    harness.temporaryFiles.delete(from)
  }),
  unlink: vi.fn(async (path: string) => {
    if (harness.temporaryFiles.delete(path)) return
    if (!harness.storedFile) throw missingFileError()
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
    (
      _path: string,
      _allowedOrigin: string,
      acceptConnection: (connection: LocalWebSocketConnection) => void
    ) => ({
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
  disconnectBrowser,
  getBrowserStatus,
  initializeBrowserBridgeService,
  resetBrowserBridgeServiceForTests,
  stopBrowserBridgeService
} from './browserBridgeService'

type SentMessage = Record<string, unknown>

class FakeConnection implements LocalWebSocketConnection {
  readonly remoteAddress = '127.0.0.1'
  readonly sent: SentMessage[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []
  private messageListener: ((value: unknown) => void) | undefined
  private closeListener: (() => void) | undefined
  private closed = false

  constructor(readonly origin = EXTENSION_ORIGIN) {}

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
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

async function waitForMessage(connection: FakeConnection, type: string): Promise<SentMessage> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = connection.sent.find((candidate) => candidate.type === type)
    if (message) return message
    await Promise.resolve()
  }
  throw new Error(`Timed out waiting for ${type}.`)
}

function attachConnection(origin = EXTENSION_ORIGIN): FakeConnection {
  if (!harness.acceptConnection) throw new Error('The bridge is not listening.')
  const connection = new FakeConnection(origin)
  harness.acceptConnection(connection)
  return connection
}

async function pairExtension(extensionVersion = EXTENSION_VERSION): Promise<string> {
  const session = await beginBrowserPairing()
  const connection = attachConnection()
  connection.emit({
    type: 'pair',
    version: BROWSER_PROTOCOL_VERSION,
    code: session.code,
    extensionOrigin: EXTENSION_ORIGIN,
    extensionVersion
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
  nonce = 'n'.repeat(32),
  extensionVersion = EXTENSION_VERSION
): Promise<FakeConnection> {
  const connection = attachConnection()
  const hello = {
    type: 'auth_hello' as const,
    version: BROWSER_PROTOCOL_VERSION,
    extensionOrigin: EXTENSION_ORIGIN,
    extensionVersion,
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

function decodeStoredPairing(): Record<string, unknown> {
  return JSON.parse(harness.storedFile?.toString('utf8') ?? '{}') as Record<string, unknown>
}

beforeEach(() => {
  resetBrowserBridgeServiceForTests()
  harness.storedFile = undefined
  harness.temporaryFiles.clear()
  harness.decryptFails = false
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
  it('completes pairing only after the authenticated reconnect and blocks secret rotation', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension()

    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      pairingState: 'paired',
      connected: false,
      phase: 'authenticating',
      activePort: 43117,
      expectedExtensionId: EXTENSION_ID
    })
    await expect(beginBrowserPairing()).rejects.toThrow('already paired or pairing')

    await authenticateExtension(secret)

    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      pairingState: 'paired',
      connected: true,
      phase: 'connected',
      activePort: 43117,
      extensionVersion: EXTENSION_VERSION
    })
    expect(decodeStoredPairing()).toMatchObject({
      version: 3,
      extensionOrigin: EXTENSION_ORIGIN,
      confirmed: true
    })
    expect(JSON.stringify(getBrowserStatus())).not.toMatch(/secret|nonce|hmac|mac/i)
    expect(harness.temporaryFiles.size).toBe(0)
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
      expect.objectContaining({ type: 'protocol_error', code: 'AUTHENTICATION_FAILED' })
    )
    expect(connection.closes).toContainEqual({ code: 1008, reason: 'Authentication failed' })
    expect(JSON.stringify(connection.sent)).not.toMatch(/secret|nonce|hmac/i)
  })

  it('retains credentials through a temporary protocol mismatch and reconnects when compatible', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension()
    const active = await authenticateExtension(secret)
    const savedBeforeMismatch = Buffer.from(harness.storedFile ?? Buffer.alloc(0))
    active.close(1001, 'Extension update started')

    const stale = attachConnection()
    stale.emit({
      type: 'auth_hello',
      version: BROWSER_PROTOCOL_VERSION - 1,
      extensionOrigin: EXTENSION_ORIGIN,
      extensionVersion: '1.1.1'
    })
    await flushAsyncWork()

    expect(stale.sent).toContainEqual(
      expect.objectContaining({
        type: 'protocol_error',
        code: 'BROWSER_PROTOCOL_INCOMPATIBLE',
        message: expect.stringContaining('saved pairing was kept')
      })
    )
    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      pairingState: 'paired',
      connected: false,
      phase: 'error',
      lastError: { code: 'BROWSER_PROTOCOL_INCOMPATIBLE' }
    })
    expect(harness.storedFile).toEqual(savedBeforeMismatch)

    const compatible = await authenticateExtension(secret, 'c'.repeat(32), '1.2.1')
    expect(compatible.sent).toContainEqual(expect.objectContaining({ type: 'authenticated' }))
    expect(getBrowserStatus()).toMatchObject({ connected: true, extensionVersion: '1.2.1' })
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

  it('preserves pairing after heartbeat timeouts and ordinary disconnects', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'))
    await initializeBrowserBridgeService()
    const secret = await pairExtension()
    const connection = await authenticateExtension(secret)
    const savedPairing = Buffer.from(harness.storedFile ?? Buffer.alloc(0))

    await vi.advanceTimersByTimeAsync(80_001)

    expect(connection.closes).toContainEqual({
      code: 4004,
      reason: 'Authenticated heartbeat timeout'
    })
    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      pairingState: 'paired',
      connected: false,
      phase: 'reconnecting',
      lastError: { code: 'BROWSER_HEARTBEAT_TIMEOUT' }
    })
    expect(harness.storedFile).toEqual(savedPairing)
  })

  it('rotates away from an unavailable saved port and atomically persists the replacement', async () => {
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
      pairingState: 'paired',
      connected: false,
      phase: 'connecting',
      activePort: 43118
    })
    expect(decodeStoredPairing()).toMatchObject({ version: 3, port: 43118 })
    expect(harness.temporaryFiles.size).toBe(0)
  })

  it('re-authenticates after Orbit and Chrome restarts and extension-version changes', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension('1.2.0')
    const first = await authenticateExtension(secret, 'a'.repeat(32), '1.2.0')
    first.close(1001, 'Chrome restarted')
    await flushAsyncWork()

    const restartedChrome = await authenticateExtension(secret, 'b'.repeat(32), '1.2.1')
    expect(restartedChrome.sent).toContainEqual(expect.objectContaining({ type: 'authenticated' }))

    await stopBrowserBridgeService()
    resetBrowserBridgeServiceForTests()
    harness.activePort = undefined
    harness.acceptConnection = undefined
    await initializeBrowserBridgeService()

    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      pairingState: 'paired',
      connected: false,
      phase: 'connecting'
    })
    const restartedOrbit = await authenticateExtension(secret, 'd'.repeat(32), '2.0.0')
    expect(restartedOrbit.sent).toContainEqual(expect.objectContaining({ type: 'authenticated' }))
    expect(getBrowserStatus()).toMatchObject({
      paired: true,
      connected: true,
      extensionVersion: '2.0.0'
    })
  })

  it('detects the legacy path-derived identity and allows one final migration pairing', async () => {
    harness.storedFile = Buffer.from(
      JSON.stringify({
        version: 2,
        extensionOrigin: LEGACY_EXTENSION_ORIGIN,
        secret: Buffer.alloc(32, 4).toString('base64'),
        port: 43122,
        confirmed: true
      }),
      'utf8'
    )

    await initializeBrowserBridgeService()

    expect(getBrowserStatus()).toMatchObject({
      paired: false,
      pairingState: 'legacy',
      phase: 'migration-required',
      legacyExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expectedExtensionId: EXTENSION_ID
    })
    expect(harness.listenedPorts).toEqual([])

    const secret = await pairExtension()
    expect(harness.listenedPorts[0]).toBe(43122)
    expect(decodeStoredPairing()).toMatchObject({
      version: 3,
      extensionOrigin: EXTENSION_ORIGIN
    })
    await authenticateExtension(secret)
    expect(getBrowserStatus()).toMatchObject({ pairingState: 'paired', connected: true })
  })

  it('surfaces unreadable encrypted storage instead of treating it as unpaired', async () => {
    harness.storedFile = Buffer.from('encrypted-data', 'utf8')
    harness.decryptFails = true

    await initializeBrowserBridgeService()

    expect(getBrowserStatus()).toMatchObject({
      paired: false,
      pairingState: 'unreadable',
      phase: 'error',
      lastError: { code: 'BROWSER_PAIRING_STORAGE_UNREADABLE' }
    })
    await expect(beginBrowserPairing()).rejects.toThrow('could not be decrypted or read')

    const forgotten = await disconnectBrowser()
    expect(forgotten.synchronized).toBe(false)
    expect(forgotten.warning).toContain('Chrome was offline')
    expect(harness.storedFile).toBeUndefined()
    expect(forgotten.status).toMatchObject({ pairingState: 'none', phase: 'unpaired' })
  })

  it('forgets both sides only after a typed authenticated acknowledgment', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension()
    const connection = await authenticateExtension(secret)

    const forgetting = disconnectBrowser()
    const request = await waitForMessage(connection, 'forget_pairing_request')
    const ackPayload = {
      version: BROWSER_PROTOCOL_VERSION,
      requestId: request.requestId as string,
      initiator: 'orbit' as const,
      ok: true,
      timestamp: Date.now()
    }
    connection.emit({
      type: 'forget_pairing_ack',
      ...ackPayload,
      mac: createBrowserMac(Buffer.from(secret, 'base64'), 'forget-ack-orbit', ackPayload)
    })

    await expect(forgetting).resolves.toMatchObject({
      synchronized: true,
      status: { paired: false, pairingState: 'none', phase: 'unpaired' }
    })
    expect(harness.storedFile).toBeUndefined()
  })

  it('clears locally with a warning when Chrome is offline during Forget pairing', async () => {
    await initializeBrowserBridgeService()
    const secret = await pairExtension()
    const connection = await authenticateExtension(secret)
    connection.close(1001, 'Chrome offline')
    await flushAsyncWork()

    const result = await disconnectBrowser()

    expect(result).toMatchObject({
      synchronized: false,
      status: { paired: false, pairingState: 'none', phase: 'unpaired' }
    })
    expect(result.warning).toContain('Chrome was offline')
    expect(harness.storedFile).toBeUndefined()
  })
})
