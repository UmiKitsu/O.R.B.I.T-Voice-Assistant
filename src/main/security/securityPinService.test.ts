import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => electronState.userData },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

import {
  changeSecurityPin,
  createSecurityPin,
  getSecurityPinStatus,
  initializeSecurityPinService,
  resetSecurityPinServiceForTests,
  verifySecurityPin
} from './securityPinService'

let temporaryRoot: string | null = null

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'orbit-pin-'))
  electronState.userData = temporaryRoot
  resetSecurityPinServiceForTests()
  await initializeSecurityPinService()
})

afterEach(async () => {
  resetSecurityPinServiceForTests()
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = null
})

describe('security PIN service', () => {
  it('creates, verifies, changes, and locks a hidden four-digit PIN', async () => {
    expect(getSecurityPinStatus()).toMatchObject({ hasPin: false, temporarilyLocked: false })

    await expect(createSecurityPin('1234', '1234')).resolves.toMatchObject({ hasPin: true })
    await expect(verifySecurityPin('1234')).resolves.toEqual({ ok: true })
    await expect(verifySecurityPin('0000')).resolves.toMatchObject({
      ok: false,
      code: 'PIN_INVALID'
    })

    await expect(changeSecurityPin('1234', '5678', '5678')).resolves.toMatchObject({
      hasPin: true
    })
    await expect(verifySecurityPin('1234')).resolves.toMatchObject({
      ok: false,
      code: 'PIN_INVALID'
    })
    await expect(verifySecurityPin('5678')).resolves.toEqual({ ok: true })

    for (let attempt = 0; attempt < 5; attempt += 1) await verifySecurityPin('0000')
    expect(getSecurityPinStatus()).toMatchObject({ hasPin: true, temporarilyLocked: true })
  })
})
