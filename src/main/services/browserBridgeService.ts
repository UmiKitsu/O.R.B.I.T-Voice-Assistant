import { app, safeStorage } from 'electron'
import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BrowserCommandResult,
  BrowserConnectionError,
  BrowserConnectionPhase,
  BrowserConnectionStatus,
  BrowserForgetPairingResult,
  BrowserPairingPersistenceState,
  BrowserPairingSession,
  YouTubePlaybackState
} from '../../shared/types'
import {
  ORBIT_BROWSER_EXTENSION_ID,
  ORBIT_BROWSER_EXTENSION_ORIGIN,
  ORBIT_BROWSER_PAIRING_FILE_NAME
} from './browserBridgeCompatibility'
import { logOperationalEvent } from './loggerService'
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
  forgetPairingAckSchema,
  forgetPairingRequestSchema,
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
const FORGET_ACK_TIMEOUT_MS = 3_000
const SOCKET_PATH = '/orbit-browser-v1'
const HEARTBEAT_INTERVAL_MS = 20_000
const AUTHENTICATED_CONTACT_TIMEOUT_MS = 60_000
const PAIRING_STORAGE_ERROR: BrowserConnectionError = {
  code: 'BROWSER_PAIRING_STORAGE_UNREADABLE',
  message:
    'Orbit found saved browser pairing data, but it could not be decrypted or read. Forget the local pairing before pairing again.'
}

type StoredPairing = {
  version: 3
  extensionOrigin: typeof ORBIT_BROWSER_EXTENSION_ORIGIN
  secret: string
  port: number
  confirmed: boolean
}

type DecodedPairing =
  | { kind: 'current'; pairing: StoredPairing; needsRewrite: boolean }
  | { kind: 'legacy'; extensionOrigin: string; port: number }

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

type ActivePairingState = {
  code: string
  expiresAt: number
}

type PendingForget = {
  requestId: string
  resolve: (acknowledged: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

let pairingFilePath = ''
let extensionPath = ''
let storedPairing: StoredPairing | null = null
let pairingPersistenceState: BrowserPairingPersistenceState = 'none'
let legacyExtensionId: string | undefined
let legacyPreferredPort: number | undefined
let activePairing: ActivePairingState | null = null
let server: LocalWebSocketServer | null = null
let serverPort: number | null = null
let activeConnection: LocalWebSocketConnection | null = null
let pendingAuth = new WeakMap<LocalWebSocketConnection, PendingAuth>()
let authenticatedConnections = new WeakSet<LocalWebSocketConnection>()
let extensionVersion: string | undefined
let lastSeenAt: number | undefined
let lastAuthenticatedContactAt: number | undefined
let connectionPhase: BrowserConnectionPhase = 'unpaired'
let retryAt: number | undefined
let lastError: BrowserConnectionError | undefined
let sequence = 0
let lastResponseSequence = 0
let siteAccessMode: BrowserConnectionStatus['siteAccessMode'] = 'restricted'
let activeTabOrigin: string | undefined
let lastYouTubePlaybackState: YouTubePlaybackState | undefined
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let initialized = false
let pendingForget: PendingForget | null = null
const usedAuthNonces = new Map<string, number>()
const usedForgetRequestIds = new Map<string, number>()
const pendingCommands = new Map<string, PendingCommand>()

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join('\n') === [...keys].sort().join('\n')
}

function parseStoredPairing(value: unknown): DecodedPairing {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The browser pairing record is invalid.')
  }
  const candidate = value as Record<string, unknown>
  const version = candidate.version
  const validKeys =
    version === 1
      ? exactKeys(candidate, ['version', 'extensionOrigin', 'secret', 'port'])
      : exactKeys(candidate, [
          'version',
          'extensionOrigin',
          'secret',
          'port',
          'confirmed'
        ])
  const validOrigin =
    typeof candidate.extensionOrigin === 'string' &&
    /^chrome-extension:\/\/[a-p]{32}$/.test(candidate.extensionOrigin)
  const validSecret =
    typeof candidate.secret === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(candidate.secret)
  const validPort =
    typeof candidate.port === 'number' &&
    Number.isInteger(candidate.port) &&
    candidate.port >= PORT_MIN &&
    candidate.port <= PORT_MAX
  const validConfirmed = version === 1 || typeof candidate.confirmed === 'boolean'

  if (![1, 2, 3].includes(version as number) || !validKeys || !validOrigin || !validSecret || !validPort || !validConfirmed) {
    throw new Error('The browser pairing record is invalid.')
  }

  if (candidate.extensionOrigin !== ORBIT_BROWSER_EXTENSION_ORIGIN) {
    return {
      kind: 'legacy',
      extensionOrigin: candidate.extensionOrigin as string,
      port: candidate.port as number
    }
  }

  return {
    kind: 'current',
    needsRewrite: version !== 3,
    pairing: {
      version: 3,
      extensionOrigin: ORBIT_BROWSER_EXTENSION_ORIGIN,
      secret: candidate.secret as string,
      port: candidate.port as number,
      confirmed: version === 1 ? true : (candidate.confirmed as boolean)
    }
  }
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

function deserializePairing(value: Buffer): DecodedPairing {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure operating-system storage is unavailable.')
  }
  const decrypted = safeStorage.decryptString(value)
  return parseStoredPairing(JSON.parse(decrypted) as unknown)
}

async function persistPairing(value: StoredPairing): Promise<void> {
  const temporaryPath = `${pairingFilePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, serializePairing(value), { mode: 0o600, flag: 'wx' })
    await rename(temporaryPath, pairingFilePath)
  } catch (error: unknown) {
    await unlink(temporaryPath).catch(() => undefined)
    throw error
  }
  storedPairing = value
  pairingPersistenceState = 'paired'
  legacyExtensionId = undefined
  legacyPreferredPort = undefined
}

async function removePairingFile(): Promise<void> {
  try {
    await unlink(pairingFilePath)
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
}

function currentStatus(): BrowserConnectionStatus {
  return {
    paired: storedPairing !== null,
    connected: activeConnection !== null,
    browser: 'chrome',
    phase: connectionPhase,
    pairingState: pairingPersistenceState,
    expectedExtensionId: ORBIT_BROWSER_EXTENSION_ID,
    ...(legacyExtensionId ? { legacyExtensionId } : {}),
    ...(serverPort !== null ? { activePort: serverPort } : {}),
    ...(retryAt ? { retryAt } : {}),
    ...(lastError ? { lastError: { ...lastError } } : {}),
    ...(extensionVersion ? { extensionVersion } : {}),
    ...(lastSeenAt ? { lastSeenAt } : {}),
    siteAccessMode,
    ...(activeTabOrigin ? { activeTabOrigin } : {})
  }
}

function setConnectionError(code: string, message: string): void {
  connectionPhase = 'error'
  lastError = { code, message }
  retryAt = undefined
}

function failPendingCommands(code: string, message: string): void {
  for (const [requestId, pending] of pendingCommands) {
    clearTimeout(pending.timeout)
    pending.resolve({ ok: false, code, message, recoverable: true })
    pendingCommands.delete(requestId)
  }
}

function resolvePendingForget(acknowledged: boolean): void {
  const pending = pendingForget
  if (!pending) return
  pendingForget = null
  clearTimeout(pending.timeout)
  pending.resolve(acknowledged)
}

function resetPairingMetadata(): void {
  activePairing = null
  storedPairing = null
  pairingPersistenceState = 'none'
  legacyExtensionId = undefined
  legacyPreferredPort = undefined
  extensionVersion = undefined
  lastSeenAt = undefined
  lastAuthenticatedContactAt = undefined
  connectionPhase = 'unpaired'
  retryAt = undefined
  lastError = undefined
  siteAccessMode = 'restricted'
  activeTabOrigin = undefined
}

function detachConnection(connection: LocalWebSocketConnection): void {
  if (activeConnection !== connection) return
  activeConnection = null
  resolvePendingForget(false)
  lastResponseSequence = 0
  lastAuthenticatedContactAt = undefined
  activeTabOrigin = undefined
  if (storedPairing) {
    connectionPhase = 'reconnecting'
    lastError ??= {
      code: 'BROWSER_EXTENSION_DISCONNECTED',
      message: 'The Orbit browser extension disconnected and will retry automatically.'
    }
    logOperationalEvent({ event: 'browser.retry-scheduled', code: lastError.code })
  } else if (pairingPersistenceState === 'legacy') {
    connectionPhase = 'migration-required'
  } else if (pairingPersistenceState === 'unreadable') {
    connectionPhase = 'error'
    lastError = { ...PAIRING_STORAGE_ERROR }
  } else {
    connectionPhase = 'unpaired'
    lastError = undefined
  }
  logOperationalEvent({ event: 'browser.disconnected', code: lastError?.code })
  failPendingCommands(
    'BROWSER_EXTENSION_DISCONNECTED',
    'The Orbit browser extension disconnected before the action completed.'
  )
}

function pruneSecurityTokens(now = Date.now()): void {
  for (const [nonce, expiresAt] of usedAuthNonces) {
    if (expiresAt <= now) usedAuthNonces.delete(nonce)
  }
  for (const [requestId, expiresAt] of usedForgetRequestIds) {
    if (expiresAt <= now) usedForgetRequestIds.delete(requestId)
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
  if (storedPairing) {
    sendProtocolError(
      connection,
      'PAIRING_ALREADY_EXISTS',
      'Orbit is already paired. Forget the current pairing before creating another one.'
    )
    connection.close(1008, 'Pairing already exists')
    return true
  }
  if (
    pairingPersistenceState === 'unreadable' ||
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
    version: 3,
    extensionOrigin: ORBIT_BROWSER_EXTENSION_ORIGIN,
    secret: secret.toString('base64'),
    port: serverPort,
    confirmed: false
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
  connectionPhase = 'authenticating'
  lastError = undefined
  retryAt = undefined
  extensionVersion = parsed.data.extensionVersion
  logOperationalEvent({ event: 'browser.pairing-stored', port: nextPairing.port })
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
  pruneSecurityTokens(now)
  const { mac, ...payload } = parsed.data

  if (
    !storedPairing ||
    !secret ||
    connection.origin !== ORBIT_BROWSER_EXTENSION_ORIGIN ||
    payload.extensionOrigin !== ORBIT_BROWSER_EXTENSION_ORIGIN ||
    !isFreshTimestamp(payload.timestamp, now) ||
    usedAuthNonces.has(payload.nonce) ||
    !verifyBrowserMac(secret, 'auth-client', payload, mac)
  ) {
    sendProtocolError(connection, 'AUTHENTICATION_FAILED', 'Browser authentication failed.')
    connection.close(1008, 'Authentication failed')
    return true
  }

  usedAuthNonces.set(payload.nonce, now + 2 * 60_000)
  connectionPhase = 'authenticating'
  lastError = undefined
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

async function handleAuthAck(connection: LocalWebSocketConnection, message: unknown): Promise<boolean> {
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
  if (storedPairing && !storedPairing.confirmed) {
    try {
      await persistPairing({ ...storedPairing, confirmed: true })
    } catch {
      sendProtocolError(
        connection,
        'PAIRING_STORAGE_FAILED',
        'Orbit could not finish storing the browser pairing securely.'
      )
      connection.close(1011, 'Secure storage failed')
      setConnectionError(
        'PAIRING_STORAGE_FAILED',
        'Orbit could not finish storing the browser pairing securely.'
      )
      return true
    }
  }
  authenticatedConnections.add(connection)
  if (activeConnection && activeConnection !== connection) {
    activeConnection.close(4001, 'A newer Orbit connection replaced this connection')
  }
  activeConnection = connection
  const now = Date.now()
  lastSeenAt = now
  lastAuthenticatedContactAt = now
  lastResponseSequence = 0
  connectionPhase = 'connected'
  retryAt = undefined
  lastError = undefined
  logOperationalEvent({ event: 'browser.authenticated', port: serverPort ?? undefined })
  connection.sendJson({
    type: 'authenticated',
    version: BROWSER_PROTOCOL_VERSION,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS
  })
  return true
}

type ForgetRequestPayload = {
  version: number
  requestId: string
  initiator: 'orbit' | 'extension'
  timestamp: number
}

type ForgetAckPayload = ForgetRequestPayload & {
  ok: boolean
}

function forgetRequestPayload(value: ForgetRequestPayload): ForgetRequestPayload {
  return {
    version: value.version,
    requestId: value.requestId,
    initiator: value.initiator,
    timestamp: value.timestamp
  }
}

function forgetAckPayload(value: ForgetAckPayload): ForgetAckPayload {
  return {
    version: value.version,
    requestId: value.requestId,
    initiator: value.initiator,
    ok: value.ok,
    timestamp: value.timestamp
  }
}

function handleForgetPairingAck(connection: LocalWebSocketConnection, message: unknown): boolean {
  const parsed = forgetPairingAckSchema.safeParse(message)
  if (!parsed.success) return false
  const pending = pendingForget
  const secret = secretBuffer()
  const { mac } = parsed.data
  const payload = forgetAckPayload(parsed.data)
  if (
    parsed.data.initiator !== 'orbit' ||
    !pending ||
    parsed.data.requestId !== pending.requestId ||
    connection !== activeConnection ||
    !authenticatedConnections.has(connection) ||
    !secret ||
    !isFreshTimestamp(parsed.data.timestamp) ||
    !verifyBrowserMac(secret, 'forget-ack-orbit', payload, mac)
  ) {
    sendProtocolError(connection, 'FORGET_ACK_REJECTED', 'The forget-pairing acknowledgment was rejected.')
    return true
  }
  resolvePendingForget(parsed.data.ok)
  return true
}

async function handleForgetPairingRequest(
  connection: LocalWebSocketConnection,
  message: unknown
): Promise<boolean> {
  const parsed = forgetPairingRequestSchema.safeParse(message)
  if (!parsed.success) return false
  if (parsed.data.initiator !== 'extension') return false
  const secret = secretBuffer()
  const now = Date.now()
  pruneSecurityTokens(now)
  const { mac } = parsed.data
  const payload = forgetRequestPayload(parsed.data)
  if (
    connection !== activeConnection ||
    !authenticatedConnections.has(connection) ||
    !secret ||
    !isFreshTimestamp(parsed.data.timestamp, now) ||
    usedForgetRequestIds.has(parsed.data.requestId) ||
    !verifyBrowserMac(secret, 'forget-request-extension', payload, mac)
  ) {
    sendProtocolError(connection, 'FORGET_REQUEST_REJECTED', 'The forget-pairing request was rejected.')
    return true
  }

  usedForgetRequestIds.set(parsed.data.requestId, now + 2 * 60_000)
  let cleared = false
  try {
    await removePairingFile()
    resetPairingMetadata()
    cleared = true
  } catch {
    setConnectionError(
      'BROWSER_PAIRING_FORGET_FAILED',
      'Orbit could not remove its saved browser pairing.'
    )
  }

  const ack = forgetAckPayload({
    version: BROWSER_PROTOCOL_VERSION,
    requestId: parsed.data.requestId,
    initiator: 'extension',
    ok: cleared,
    timestamp: Date.now()
  })
  connection.sendJson({
    type: 'forget_pairing_ack',
    ...ack,
    mac: createBrowserMac(secret, 'forget-ack-extension', ack)
  })
  if (cleared) {
    failPendingCommands('BROWSER_DISCONNECTED', 'The browser pairing was forgotten.')
    connection.close(4002, 'Pairing forgotten')
    if (activeConnection === connection) activeConnection = null
  }
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
  const now = Date.now()
  lastSeenAt = now
  lastAuthenticatedContactAt = now
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
  siteAccessMode = parsed.data.siteAccessMode
  activeTabOrigin = parsed.data.activeTabOrigin
  const now = Date.now()
  lastSeenAt = now
  lastAuthenticatedContactAt = now
  return true
}

async function handleMessage(connection: LocalWebSocketConnection, message: unknown): Promise<void> {
  if (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as Record<string, unknown>).type === 'string' &&
    typeof (message as Record<string, unknown>).version === 'number' &&
    (message as Record<string, unknown>).version !== BROWSER_PROTOCOL_VERSION
  ) {
    const compatibilityMessage =
      'Orbit and the browser extension use different protocol versions. Update or reload the older side; the saved pairing was kept.'
    setConnectionError('BROWSER_PROTOCOL_INCOMPATIBLE', compatibilityMessage)
    logOperationalEvent({
      event: 'browser.protocol-incompatible',
      code: 'BROWSER_PROTOCOL_INCOMPATIBLE'
    })
    sendProtocolError(connection, 'BROWSER_PROTOCOL_INCOMPATIBLE', compatibilityMessage)
    connection.close(1002, 'Protocol version mismatch')
    return
  }
  if (await handlePair(connection, message)) return
  if (handleAuthHello(connection, message)) return
  if (await handleAuthAck(connection, message)) return

  if (!authenticatedConnections.has(connection) || connection !== activeConnection) {
    sendProtocolError(connection, 'AUTHENTICATION_REQUIRED', 'Authenticate before sending messages.')
    connection.close(1008, 'Authentication required')
    return
  }

  if (await handleForgetPairingRequest(connection, message)) return
  if (handleForgetPairingAck(connection, message)) return
  if (handleCommandResult(connection, message)) return
  if (handleExtensionStatus(connection, message)) return

  if (
    typeof message === 'object' &&
    message !== null &&
    (message as Record<string, unknown>).type === 'heartbeat' &&
    (message as Record<string, unknown>).version === BROWSER_PROTOCOL_VERSION
  ) {
    const now = Date.now()
    lastSeenAt = now
    lastAuthenticatedContactAt = now
    return
  }

  sendProtocolError(connection, 'INVALID_MESSAGE', 'The browser message was invalid.')
}

function acceptConnection(connection: LocalWebSocketConnection): void {
  connection.onMessage((message) => void handleMessage(connection, message))
  connection.onClose(() => detachConnection(connection))
}

async function startServerAt(port: number): Promise<boolean> {
  const nextServer = createLocalWebSocketServer(
    SOCKET_PATH,
    ORBIT_BROWSER_EXTENSION_ORIGIN,
    acceptConnection
  )
  try {
    await nextServer.listen(port)
    server = nextServer
    serverPort = port
    logOperationalEvent({ event: 'browser.bridge-listening', port })
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
    const now = Date.now()
    pruneSecurityTokens(now)
    if (!activeConnection) return
    if (
      !lastAuthenticatedContactAt ||
      now - lastAuthenticatedContactAt > AUTHENTICATED_CONTACT_TIMEOUT_MS
    ) {
      const staleConnection = activeConnection
      setConnectionError(
        'BROWSER_HEARTBEAT_TIMEOUT',
        'The Orbit browser extension stopped responding and must reconnect.'
      )
      staleConnection.close(4004, 'Authenticated heartbeat timeout')
      detachConnection(staleConnection)
      return
    }
    activeConnection.sendJson({
      type: 'heartbeat',
      version: BROWSER_PROTOCOL_VERSION,
      timestamp: now
    })
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
}

async function loadPairingRecord(): Promise<void> {
  try {
    const decoded = deserializePairing(await readFile(pairingFilePath))
    if (decoded.kind === 'legacy') {
      storedPairing = null
      pairingPersistenceState = 'legacy'
      legacyExtensionId = decoded.extensionOrigin.slice('chrome-extension://'.length)
      legacyPreferredPort = decoded.port
      connectionPhase = 'migration-required'
      lastError = undefined
      return
    }

    storedPairing = decoded.pairing
    pairingPersistenceState = 'paired'
    legacyExtensionId = undefined
    legacyPreferredPort = undefined
    if (decoded.needsRewrite) await persistPairing(decoded.pairing)
    const port = await ensureServer(decoded.pairing.port)
    if (port !== decoded.pairing.port) await persistPairing({ ...decoded.pairing, port })
    connectionPhase = 'connecting'
    lastError = undefined
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      storedPairing = null
      pairingPersistenceState = 'none'
      connectionPhase = 'unpaired'
      lastError = undefined
      return
    }
    storedPairing = null
    pairingPersistenceState = 'unreadable'
    connectionPhase = 'error'
    lastError = { ...PAIRING_STORAGE_ERROR }
  }
}

export async function initializeBrowserBridgeService(): Promise<void> {
  if (initialized) return
  pairingFilePath = join(app.getPath('userData'), ORBIT_BROWSER_PAIRING_FILE_NAME)
  extensionPath = app.isPackaged
    ? join(process.resourcesPath, 'orbit-browser-extension')
    : join(app.getAppPath(), 'resources', 'orbit-browser-extension')

  await loadPairingRecord()
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
  if (pairingPersistenceState === 'unreadable') {
    throw new Error(PAIRING_STORAGE_ERROR.message)
  }
  if (storedPairing || activePairing) {
    throw new Error('Orbit is already paired or pairing. Forget the current pairing before starting another one.')
  }
  const port = await ensureServer(legacyPreferredPort)
  const now = Date.now()
  activePairing = {
    code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
    expiresAt: now + PAIRING_TTL_MS
  }
  connectionPhase = 'pairing'
  lastError = undefined
  retryAt = undefined
  return {
    port,
    code: activePairing.code,
    expiresAt: activePairing.expiresAt,
    extensionPath
  }
}

export async function retryBrowserConnection(): Promise<BrowserConnectionStatus> {
  if (!initialized) await initializeBrowserBridgeService()
  if (pairingPersistenceState === 'unreadable') {
    throw new Error(PAIRING_STORAGE_ERROR.message)
  }
  if (pairingPersistenceState === 'legacy') {
    connectionPhase = 'migration-required'
    return currentStatus()
  }
  if (!storedPairing) return currentStatus()

  const port = await ensureServer(storedPairing.port)
  if (port !== storedPairing.port) await persistPairing({ ...storedPairing, port })
  if (!activeConnection) connectionPhase = 'connecting'
  retryAt = undefined
  lastError = undefined
  return currentStatus()
}

function requestExtensionForget(): Promise<boolean> {
  const connection = activeConnection
  const secret = secretBuffer()
  if (!connection || !secret || !authenticatedConnections.has(connection)) {
    return Promise.resolve(false)
  }
  resolvePendingForget(false)
  const requestId = randomUUID()
  const payload = forgetRequestPayload({
    version: BROWSER_PROTOCOL_VERSION,
    requestId,
    initiator: 'orbit',
    timestamp: Date.now()
  })

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingForget?.requestId === requestId) {
        pendingForget = null
        resolve(false)
      }
    }, FORGET_ACK_TIMEOUT_MS)
    timeout.unref?.()
    pendingForget = { requestId, resolve, timeout }
    connection.sendJson({
      type: 'forget_pairing_request',
      ...payload,
      mac: createBrowserMac(secret, 'forget-request-orbit', payload)
    })
  })
}

export async function disconnectBrowser(): Promise<BrowserForgetPairingResult> {
  if (!initialized) await initializeBrowserBridgeService()
  const hadPairingRecord = pairingPersistenceState !== 'none'
  const synchronized = storedPairing ? await requestExtensionForget() : false

  await removePairingFile()
  resetPairingMetadata()
  const connection = activeConnection
  activeConnection = null
  connection?.close(4002, 'Orbit forgot the browser pairing')
  failPendingCommands('BROWSER_DISCONNECTED', 'The browser pairing was forgotten.')
  resolvePendingForget(false)

  const warning =
    hadPairingRecord && !synchronized
      ? 'Orbit forgot its local pairing, but Chrome was offline or could not acknowledge it. Use “Forget pairing” in the extension before pairing again.'
      : undefined
  return {
    status: currentStatus(),
    synchronized: !hadPairingRecord || synchronized,
    ...(warning ? { warning } : {})
  }
}

export async function stopBrowserBridgeService(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = null
  resolvePendingForget(false)
  activeConnection?.close(1001, 'Orbit is closing')
  activeConnection = null
  lastAuthenticatedContactAt = undefined
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
  if (pairingPersistenceState === 'unreadable') {
    return {
      ok: false,
      code: PAIRING_STORAGE_ERROR.code,
      message: PAIRING_STORAGE_ERROR.message,
      recoverable: true
    }
  }
  if (pairingPersistenceState === 'legacy') {
    return {
      ok: false,
      code: 'BROWSER_EXTENSION_MIGRATION_REQUIRED',
      message: 'Remove the legacy Orbit extension, load the updated bundled extension, and pair once.',
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
      finish({
        ok: false,
        code: 'ACTION_CANCELLED',
        message: 'The request was cancelled.',
        recoverable: true
      })
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
  resolvePendingForget(false)
  storedPairing = null
  pairingPersistenceState = 'none'
  legacyExtensionId = undefined
  legacyPreferredPort = undefined
  activePairing = null
  server = null
  serverPort = null
  activeConnection = null
  pendingAuth = new WeakMap()
  authenticatedConnections = new WeakSet()
  extensionVersion = undefined
  lastSeenAt = undefined
  lastAuthenticatedContactAt = undefined
  connectionPhase = 'unpaired'
  retryAt = undefined
  lastError = undefined
  sequence = 0
  lastResponseSequence = 0
  siteAccessMode = 'restricted'
  activeTabOrigin = undefined
  lastYouTubePlaybackState = undefined
  usedAuthNonces.clear()
  usedForgetRequestIds.clear()
  pendingCommands.clear()
  initialized = false
  pairingFilePath = ''
  extensionPath = ''
}
