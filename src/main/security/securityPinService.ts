import { app, safeStorage } from 'electron'
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback)
const PIN_PATTERN = /^\d{4}$/
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 60_000
const PIN_FILE_NAME = 'orbit-security-pin.bin'

type StoredPinRecord = {
  version: 1
  salt: string
  verifier: string
}

export type SecurityPinStatus = {
  hasPin: boolean
  temporarilyLocked: boolean
  retryAt?: number
}

export type PinVerificationResult =
  | { ok: true }
  | {
      ok: false
      code: 'PIN_NOT_CONFIGURED' | 'PIN_INVALID' | 'PIN_LOCKED' | 'PIN_UNAVAILABLE'
      message: string
      retryAt?: number
    }

let record: StoredPinRecord | null = null
let pinFilePath: string | null = null
let initialized = false
let failedAttempts = 0
let lockedUntil = 0

function isStoredPinRecord(value: unknown): value is StoredPinRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Object.keys(candidate).length === 3 &&
    candidate.version === 1 &&
    typeof candidate.salt === 'string' &&
    /^[a-f0-9]{32}$/i.test(candidate.salt) &&
    typeof candidate.verifier === 'string' &&
    /^[a-f0-9]{128}$/i.test(candidate.verifier)
  )
}

function assertValidPin(pin: string): void {
  if (!PIN_PATTERN.test(pin)) {
    throw new Error('The security PIN must contain exactly four digits.')
  }
}

async function deriveVerifier(pin: string, salt: string): Promise<Buffer> {
  return (await scrypt(pin, Buffer.from(salt, 'hex'), 64)) as Buffer
}

function serializeRecord(value: StoredPinRecord): Buffer {
  const json = JSON.stringify(value)
  if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(json)

  // The fallback contains only a salted scrypt verifier, never the PIN itself.
  return Buffer.from(json, 'utf8')
}

function deserializeRecord(value: Buffer): StoredPinRecord | null {
  const candidates: string[] = []
  if (safeStorage.isEncryptionAvailable()) {
    try {
      candidates.push(safeStorage.decryptString(value))
    } catch {
      // The file may have been created while OS encryption was unavailable.
    }
  }
  candidates.push(value.toString('utf8'))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (isStoredPinRecord(parsed)) return parsed
    } catch {
      // Ignore malformed or unreadable records.
    }
  }
  return null
}

async function persistRecord(nextRecord: StoredPinRecord): Promise<void> {
  if (!pinFilePath) throw new Error('The security PIN service is not initialized.')
  await writeFile(pinFilePath, serializeRecord(nextRecord), { mode: 0o600 })
  record = nextRecord
}

function currentStatus(now = Date.now()): SecurityPinStatus {
  const temporarilyLocked = lockedUntil > now
  return {
    hasPin: record !== null,
    temporarilyLocked,
    ...(temporarilyLocked ? { retryAt: lockedUntil } : {})
  }
}

export async function initializeSecurityPinService(): Promise<void> {
  if (initialized) return
  pinFilePath = join(app.getPath('userData'), PIN_FILE_NAME)

  try {
    const stored = await readFile(pinFilePath)
    record = deserializeRecord(stored)
  } catch {
    record = null
  }

  initialized = true
}

export function getSecurityPinStatus(): SecurityPinStatus {
  if (lockedUntil > 0 && lockedUntil <= Date.now()) {
    lockedUntil = 0
    failedAttempts = 0
  }
  return currentStatus()
}

export async function createSecurityPin(pin: string, confirmation: string): Promise<SecurityPinStatus> {
  assertValidPin(pin)
  if (pin !== confirmation) throw new Error('The PIN entries do not match.')
  if (record) throw new Error('A security PIN is already configured.')

  const salt = randomBytes(16).toString('hex')
  const verifier = (await deriveVerifier(pin, salt)).toString('hex')
  await persistRecord({ version: 1, salt, verifier })
  failedAttempts = 0
  lockedUntil = 0
  return currentStatus()
}

export async function verifySecurityPin(pin: string): Promise<PinVerificationResult> {
  const now = Date.now()
  if (lockedUntil > now) {
    return {
      ok: false,
      code: 'PIN_LOCKED',
      message: 'Too many incorrect PIN attempts. Try again after the temporary lockout.',
      retryAt: lockedUntil
    }
  }

  if (!record) {
    return {
      ok: false,
      code: 'PIN_NOT_CONFIGURED',
      message: 'Create a four-digit security PIN before authorizing this action.'
    }
  }

  if (!PIN_PATTERN.test(pin)) {
    return {
      ok: false,
      code: 'PIN_INVALID',
      message: 'Enter exactly four digits.'
    }
  }

  try {
    const candidate = await deriveVerifier(pin, record.salt)
    const expected = Buffer.from(record.verifier, 'hex')
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      failedAttempts = 0
      lockedUntil = 0
      return { ok: true }
    }
  } catch {
    return {
      ok: false,
      code: 'PIN_UNAVAILABLE',
      message: 'Orbit could not verify the security PIN.'
    }
  }

  failedAttempts += 1
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
    lockedUntil = now + LOCKOUT_MS
    return {
      ok: false,
      code: 'PIN_LOCKED',
      message: 'Too many incorrect PIN attempts. Try again in one minute.',
      retryAt: lockedUntil
    }
  }

  return {
    ok: false,
    code: 'PIN_INVALID',
    message: 'The security PIN was incorrect.'
  }
}

export async function changeSecurityPin(
  currentPin: string,
  nextPin: string,
  confirmation: string
): Promise<SecurityPinStatus> {
  assertValidPin(nextPin)
  if (nextPin !== confirmation) throw new Error('The new PIN entries do not match.')

  const verification = await verifySecurityPin(currentPin)
  if (!verification.ok) throw new Error(verification.message)

  const salt = randomBytes(16).toString('hex')
  const verifier = (await deriveVerifier(nextPin, salt)).toString('hex')
  await persistRecord({ version: 1, salt, verifier })
  failedAttempts = 0
  lockedUntil = 0
  return currentStatus()
}

export function resetSecurityPinServiceForTests(): void {
  record = null
  pinFilePath = null
  initialized = false
  failedAttempts = 0
  lockedUntil = 0
}
