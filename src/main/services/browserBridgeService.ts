import { app, safeStorage } from 'electron'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BrowserCommandResult,
  BrowserConnectionStatus,
  BrowserPairingSession,
  YouTubePlaybackState
} from '../../shared/types'
import { getSettings } from './settingsService'
import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_REQUEST_TTL_MS,
  authAckSchema,
  authHelloSchema,
  browserCommandResponseSchema,
  commandMacPayload,
  createBrowserMac,
  extensionStatusSchema,
  isFreshTimestamp,
  isMonotonicSequence,
  pairRequestSchema,
  responseMacPayload,
  type RegisteredBrowserCapability,
  verifyBrowserMac
} from './browserBridgeProtocol'
import {
  createLocalWebSocketServer,
  type LocalWebSocketConnection,
  type LocalWebSocketServer
} from './localWebSocketServer'

const PORT_MIN = 43_117
const PORT_MAX = 43_127
const PAIRING_TTL_MS = 5 * 60_000
const SECRET_FILE_NAME = 'orbit-browser-pairing.bin'
const SOCKET_PATH = '/orbit-browser-v1'
const HEARTBEAT_INTERVAL_MS = 20_000

type StoredPairing = {
  version: 1
  extensionOrigin: string
  secret: string
  port: number
}

type PendingAuth = {
  clientNonce: string
  serverNonce: string
}

type PendingCommand = {
  sequence: number
  capability: RegisteredBrowserCapability
  resolve: (result: BrowserCommandResult<unknown>) => void
  timeout: ReturnType<typeof setTimeout>
}

type PairingState = {
  code: string
  expiresAt: number
}

let pairingFilePath = ''
let extensionPath = ''
let storedPairing: StoredPairing | null = null
let activePairing: PairingState | null = null
let server: LocalWebSocketServer | null = null
let serverPort: number | null = null
let activeConnection: LocalWebSocketConnection | null = null
let pendingAuth = new WeakMap<LocalWebSocketConnection, PendingAuth>()
let authenticatedConnections = new WeakSet<LocalWebSocketConnection>()
let extensionVersion: string | undefined
let lastSeenAt: number | undefined
let sequence = 0
let lastResponseSequence = 0
let grantedOrigins: string[] = []
let activeTabOrigin: string | undefined
let lastYouTubePlaybackState: YouTubePlaybackState | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let initialized = false
const usedAuthNonces = new Map<string, number>()
const pendingCommands = new Map<string, PendingCommand>()

function pairingIsValid(value: unknown): value is StoredPairing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Object.keys(candidate).length === 4 &&
    candidate.version === 1 &&
    typeof candidate.extensionOrigin === 'string' &&
    /^chrome-extension:\/\/[a-p]{32}$/.test(candidate.extensionOrigin) &&
    typeof candidate.secret === 'string' &&
    /^[A-Za-z0-9+/]{43}=$/.test(candidate.secret) &&
    typeof candidate.port === 'number' &&
    Number.isInteger(candidate.port) &&
    candidate.port >= PORT_MIN &&
    candidate.port <= PORT_MAX
  )
}

function secretBuffer(): Buffer | null {
  if (!storedPairing) return null
  try {
    const secret = Buffer.from(storedPairing.secret, 'base64')
    return secret.length === 32 ? secret : null
  } catch {
    return null
  }
}

function serializePairing(value: StoredPairing): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure operating-system storage is unavailable.')
  }
  return safeStorage.encryptString(JSON.stringify(value))
}

function deserializePairing(value: Buffer): StoredPairing | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    const parsed = JSON.parse(safeStorage.decryptString(value)) as unknown
    return pairingIsValid(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function persistPairing(value: StoredPairing): Promise<void> {
  await writeFile(pairingFilePath, serializePairing(value), { mode: 0o600 })
  storedPairing = value
}

async function removePairingFile(): Promise<void> {
  try {
    await unlink(pairingFilePath)
  } catch {
    // Missing pairing files are already disconnected.
  }
}

function currentStatus(): BrowserConnectionStatus {
  return {
    paired: storedPairing !== null,
    connected: activeConnection !== null,
    browser: 'chrome',
    ...(extensionVersion ? { extensionVersion } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    grantedOrigins: [...grantedOrigins],
    ...(activeTabOrigin ? { activeTabOrigin } : {})
  }
}

function failPendingCommands(code: string, message: string): void {
  for (const [requestId, pending] of pendingCommands) {
    clearTimeout(pending.timeout)
    pending.resolve({ ok: false, code, message, recoverable: true })
    pendingCommands.delete(requestId)
  }
}

function detachConnection(connection: LocalWebSocketConnection): void {
  if (activeConnection !== connection) return
  activeConnection = null
  lastResponseSequence = 0
  failPendingCommands(
    'BROWSER_EXTENSION_DISCONNECTED',
    'The Orbit browser extension disconnected before the action completed.'
  )
}

function pruneAuthNonces(now = Date.now()): void {
  for (const [nonce, expiresAt] of usedAuthNonces) {
    if (expiresAt <= now) usedAuthNonces.delete(nonce)
  }
}

function sendProtocolError(connection: LocalWebSocketConnection, code: string, message: string): void {
  connection.sendJson({
    type: 'protocol_error',
    version: BROWSER_PROTOCOL_VERSION,
    code,
    message
  })
}

async function handlePair(
  connection: LocalWebSocketConnection,
  message: unknown
): Promise<boolean> {
  const parsed = pairRequestSchema.safeParse(message)
  if (!parsed.success) return false
  const now = Date.now()
  if (
    !activePairing ||
    activePairing.expiresAt <= now ||
    parsed.data.code !== activePairing.code ||
    parsed.data.extensionOrigin !== connection.origin ||
    !safeStorage.isEncryptionAvailable() ||
    serverPort === null
  ) {
    sendProtocolError(connection, 'PAIRING_REJECTED', 'The pairing code is invalid or expired.')
    connection.close(1008, 'Pairing rejected')
    return true
  }

  const secret = randomBytes(32)
  const nextPairing: StoredPairing = {
    version: 1,
    extensionOrigin: parsed.data.extensionOrigin,
    secret: secret.toString('base64'),
    port: serverPort
  }
  try {
    await persistPairing(nextPairing)
  } catch {
    sendProtocolError(
      connection,
      'PAIRING_STORAGE_FAILED',
      'Orbit could not store the browser pairing secret securely.'
    )
    connection.close(1011, 'Secure storage failed')
    return true
  }

  activePairing = null
  extensionVersion = parsed.data.extensionVersion
  connection.sendJson({
    type: 'pair_success',
    version: BROWSER_PROTOCOL_VERSION,
    secret: nextPairing.secret,
    port: nextPairing.port,
    extensionOrigin: nextPairing.extensionOrigin
  })
  connection.close(4000, 'Reconnect with authentication')
  return true
}

function handleAuthHello(connection: LocalWebSocketConnection, message: unknown): boolean {
  const parsed = authHelloSchema.safeParse(message)
  if (!parsed.success) return false
  const secret = secretBuffer()
  const now = Date.now()
  pruneAuthNonces(now)
  const { mac, ...payload } = parsed.data

  if (
    !storedPairing ||
    !secret ||
    connection.origin !== storedPairing.extensionOrigin ||
    payload.extensionOrigin !== storedPairing.extensionOrigin ||
    !isFreshTimestamp(payload.timestamp, now) ||
    usedAuthNonces.has(payload.nonce) ||
    !verifyBrowserMac(secret, 'auth-client', payload, mac)
  ) {
    sendProtocolError(connection, 'AUTHENTICATION_FAILED', 'Browser authentication failed.')
    connection.close(1008, 'Authentication failed')
    return true
  }

  usedAuthNonces.set(payload.nonce, now + 2 * 60_000)
  const serverNonce = randomBytes(32).toString('base64url')
  pendingAuth.set(connection, { clientNonce: payload.nonce, serverNonce })
  extensionVersion = payload.extensionVersion
  const challengePayload = {
    version: BROWSER_PROTOCOL_VERSION,
    clientNonce: payload.nonce,
    serverNonce,
    timestamp: now
  }
  connection.sendJson({
    type: 'auth_challenge',
    ...challengePayload,
    mac: createBrowserMac(secret, 'auth-server', challengePayload)
  })
  return true
}

function handleAuthAck(connection: LocalWebSocketConnection, message: unknown): boolean {
  const parsed = authAckSchema.safeParse(message)
  if (!parsed.success) return false
  const secret = secretBuffer()
  const pending = pendingAuth.get(connection)
  const { mac, ...payload } = parsed.data
  if (
    !secret ||
    !pending ||
    payload.clientNonce !== pending.clientNonce ||
    payload.serverNonce !== pending.serverNonce ||
    !verifyBrowserMac(secret, 'auth-ack', payload, mac)
  ) {
    sendProtocolError(connection, 'AUTHENTICATION_FAILED', 'Browser authentication failed.')
    connection.close(1008, 'Authentication failed')
    return true
  }

  pendingAuth.delete(connection)
  authenticatedConnections.add(connection)
  if (activeConnection && activeConnection !== connection) {
    activeConnection.close(4001, 'A newer Orbit connection replaced this connection')
  }
  activeConnection = connection
  lastSeenAt = Date.now()
  lastResponseSequence = 0
  connection.sendJson({
    type: 'authenticated',
    version: BROWSER_PROTOCOL_VERSION,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
  })
  return true
}

function isYouTubePlaybackState(value: unknown): value is YouTubePlaybackState {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    typeof state.url === 'string' &&
    typeof state.paused === 'boolean' &&
    typeof state.ended === 'boolean' &&
    typeof state.muted === 'boolean' &&
    typeof state.volume === 'number' &&
    typeof state.currentTime === 'number' &&
    typeof state.confirmedPlaying === 'boolean'
  )
}

function handleCommandResult(connection: LocalWebSocketConnection, message: unknown): boolean {
  const parsed = browserCommandResponseSchema.safeParse(message)
  if (!parsed.success) return false
  const secret = secretBuffer()
  const pending = pendingCommands.get(parsed.data.requestId)
  const { mac } = parsed.data
  const payload = {
    version: parsed.data.version,
    requestId: parsed.data.requestId,
    sequence: parsed.data.sequence,
    result: parsed.data.result
  }
  if (
    !secret ||
    connection !== activeConnection ||
    !pending ||
    parsed.data.sequence !== pending.sequence ||
    !isMonotonicSequence(parsed.data.sequence, lastResponseSequence) ||
    !verifyBrowserMac(secret, 'command-result', responseMacPayload(payload), mac)
  ) {
    sendProtocolError(connection, 'REPLAY_OR_RESPONSE_REJECTED', 'The browser response was rejected.')
    return true
  }

  lastResponseSequence = parsed.data.sequence
  pendingCommands.delete(parsed.data.requestId)
  clearTimeout(pending.timeout)
  lastSeenAt = Date.now()
  if (
    pending.capability.startsWith('youtube.') &&
    parsed.data.result.ok &&
    isYouTubePlaybackState(parsed.data.result.data)
  ) {
    lastYouTubePlaybackState = { ...parsed.data.result.data }
  }
  pending.resolve(parsed.data.result)
  return true
}

function handleExtensionStatus(connection: LocalWebSocketConnection, message: unknown): boolean {
  const parsed = extensionStatusSchema.safeParse(message)
  if (!parsed.success) return false
  if (connection !== activeConnection || !authenticatedConnections.has(connection)) return true
  grantedOrigins = [...new Set(parsed.data.grantedOrigins)].sort()
  activeTabOrigin = parsed.data.activeTabOrigin
  lastSeenAt = Date.now()
  return true
}

async function handleMessage(connection: LocalWebSocketConnection, message: unknown): Promise<void> {
  if (await handlePair(connection, message)) return
  if (handleAuthHello(connection, message)) return
  if (handleAuthAck(connection, message)) return

  if (!authenticatedConnections.has(connection) || connection !== activeConnection) {
    sendProtocolError(connection, 'AUTHENTICATION_REQUIRED', 'Authenticate before sending messages.')
    connection.close(1008, 'Authentication required')
    return
  }

  if (handleCommandResult(connection, message)) return
  if (handleExtensionStatus(connection, message)) return

  if (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).type === 'heartbeat' &&
    (message as Record<string, unknown>).version === BROWSER_PROTOCOL_VERSION
  ) {
    lastSeenAt = Date.now()
    return
  }

  sendProtocolError(connection, 'INVALID_MESSAGE', 'The browser message was invalid.')
}

function acceptConnection(connection: LocalWebSocketConnection): void {
  connection.onMessage((message) => void handleMessage(connection, message))
  connection.onClose(() => detachConnection(connection))
}

async function startServerAt(port: number): Promise<boolean> {
  const nextServer = createLocalWebSocketServer(SOCKET_PATH, acceptConnection)
  try {
    await nextServer.listen(port)
    server = nextServer
    serverPort = port
    return true
  } catch {
    await nextServer.close().catch(() => undefined)
    return false
  }
}

async function ensureServer(preferredPort?: number): Promise<number> {
  if (server && serverPort !== null) return serverPort
  const candidates = [
    ...(preferredPort && preferredPort >= PORT_MIN && preferredPort <= PORT_MAX ? [preferredPort] : []),
    ...Array.from({ length: PORT_MAX - PORT_MIN + 1 }, (_, index) => PORT_MIN + index).filter(
      (port) => port !== preferredPort
    )
  ]
  for (const port of candidates) {
    if (await startServerAt(port)) return port
  }
  throw new Error('Orbit could not open a local browser-control port.')
}

function startHeartbeat(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    pruneAuthNonces()
    if (!activeConnection) return
    activeConnection.sendJson({
      type: 'heartbeat',
      version: BROWSER_PROTOCOL_VERSION,
      timestamp: Date.now()
    })
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
}

export async function initializeBrowserBridgeService(): Promise<void> {
  if (initialized) return
  pairingFilePath = join(app.getPath('userData'), SECRET_FILE_NAME)
  extensionPath = app.isPackaged
    ? join(process.resourcesPath, 'orbit-browser-extension')
    : join(app.getAppPath(), 'resources', 'orbit-browser-extension')

  try {
    storedPairing = deserializePairing(await readFile(pairingFilePath))
  } catch {
    storedPairing = null
  }

  if (storedPairing) {
    const port = await ensureServer(storedPairing.port)
    if (port !== storedPairing.port) await persistPairing({ ...storedPairing, port })
  }
  startHeartbeat()
  initialized = true
}

export function getBrowserStatus(): BrowserConnectionStatus {
  return currentStatus()
}

export function getBrowserExtensionPath(): string {
  return extensionPath
}

export function getLastYouTubePlaybackState(): YouTubePlaybackState | undefined {
  return lastYouTubePlaybackState ? { ...lastYouTubePlaybackState } : undefined
}

export async function beginBrowserPairing(): Promise<BrowserPairingSession> {
  if (!initialized) await initializeBrowserBridgeService()
  const port = await ensureServer(storedPairing?.port)
  const now = Date.now()
  activePairing = {
    code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
    expiresAt: now + PAIRING_TTL_MS
  }
  return {
    port,
    code: activePairing.code,
    expiresAt: activePairing.expiresAt,
    extensionPath
  }
}

export async function disconnectBrowser(): Promise<BrowserConnectionStatus> {
  activePairing = null
  storedPairing = null
  extensionVersion = undefined
  lastSeenAt = undefined
  grantedOrigins = []
  activeTabOrigin = undefined
  activeConnection?.close(4002, 'Orbit disconnected the extension')
  activeConnection = null
  failPendingCommands('BROWSER_DISCONNECTED', 'The browser connection was disconnected.')
  await removePairingFile()
  return currentStatus()
}

export async function stopBrowserBridgeService(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  activeConnection?.close(1001, 'Orbit is closing')
  activeConnection = null
  failPendingCommands('BROWSER_DISCONNECTED', 'Orbit is closing.')
  await server?.close().catch(() => undefined)
  server = null
  serverPort = null
  initialized = false
}

export async function executeBrowserCommand<TData = unknown>(
  capability: RegisteredBrowserCapability,
  parameters: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = BROWSER_REQUEST_TTL_MS
): Promise<BrowserCommandResult<TData>> {
  if (signal?.aborted) {
    return {
      ok: false,
      code: 'ACTION_CANCELLED',
      message: 'The request was cancelled.',
      recoverable: true
    }
  }
  if (!getSettings().browserControlEnabled) {
    return {
      ok: false,
      code: 'BROWSER_CONTROL_DISABLED',
      message: 'Browser control is disabled in Orbit settings.',
      recoverable: true
    }
  }
  const connection = activeConnection
  const secret = secretBuffer()
  if (!connection || !secret || !authenticatedConnections.has(connection)) {
    return {
      ok: false,
      code: 'BROWSER_EXTENSION_DISCONNECTED',
      message: 'Connect the Orbit Chrome extension before using browser control.',
      recoverable: true
    }
  }

  const requestId = randomUUID()
  sequence += 1
  const commandSequence = sequence
  const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, BROWSER_REQUEST_TTL_MS))
  const deadline = Date.now() + boundedTimeout
  const payload = commandMacPayload({
    type: 'command',
    version: BROWSER_PROTOCOL_VERSION,
    requestId,
    sequence: commandSequence,
    capability,
    parameters,
    deadline
  })

  return new Promise<BrowserCommandResult<TData>>((resolve) => {
    const finish = (result: BrowserCommandResult<unknown>): void => {
      signal?.removeEventListener('abort', abort)
      resolve(result as BrowserCommandResult<TData>)
    }
    const timeout = setTimeout(() => {
      pendingCommands.delete(requestId)
      connection.sendJson({ type: 'cancel', version: BROWSER_PROTOCOL_VERSION, requestId })
      finish({
        ok: false,
        code: 'BROWSER_COMMAND_TIMEOUT',
        message: 'The browser action timed out.',
        recoverable: true
      })
    }, boundedTimeout)
    const abort = (): void => {
      const pending = pendingCommands.get(requestId)
      if (!pending) return
      pendingCommands.delete(requestId)
      clearTimeout(pending.timeout)
      connection.sendJson({ type: 'cancel', version: BROWSER_PROTOCOL_VERSION, requestId })
      finish({ ok: false, code: 'ACTION_CANCELLED', message: 'The request was cancelled.', recoverable: true })
    }
    pendingCommands.set(requestId, {
      sequence: commandSequence,
      capability,
      timeout,
      resolve: finish
    })
    signal?.addEventListener('abort', abort, { once: true })
    connection.sendJson({
      ...payload,
      mac: createBrowserMac(secret, 'command', payload)
    })
  })
}

export function resetBrowserBridgeServiceForTests(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  storedPairing = null
  activePairing = null
  server = null
  serverPort = null
  activeConnection = null
  pendingAuth = new WeakMap()
  authenticatedConnections = new WeakSet()
  extensionVersion = undefined
  lastSeenAt = undefined
  sequence = 0
  lastResponseSequence = 0
  grantedOrigins = []
  activeTabOrigin = undefined
  lastYouTubePlaybackState = undefined
  usedAuthNonces.clear()
  pendingCommands.clear()
  initialized = false
  pairingFilePath = ''
  extensionPath = ''
}
