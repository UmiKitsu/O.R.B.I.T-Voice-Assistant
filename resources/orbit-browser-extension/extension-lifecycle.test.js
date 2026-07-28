import { describe, expect, it } from 'vitest'
import { EXPECTED_EXTENSION_ORIGIN } from './extension-identity.js'
import { getInstalledLifecycle } from './extension-lifecycle.js'
import {
  createDurablePairingRecord,
  parseDurablePairing
} from './pairing-storage.js'

const SECRET = Buffer.alloc(32, 7).toString('base64')

describe('Orbit extension update lifecycle', () => {
  it('retains storage.local, tolerates cleared session state, and reconnects silently on update', () => {
    const durableLocalStorage = createDurablePairingRecord({
      port: 43120,
      secret: SECRET,
      extensionOrigin: EXPECTED_EXTENSION_ORIGIN,
      confirmed: true
    })
    const clearedSessionStorage = {}
    const lifecycle = getInstalledLifecycle('update')
    const restored = parseDurablePairing(durableLocalStorage, EXPECTED_EXTENSION_ORIGIN)

    expect(clearedSessionStorage).toEqual({})
    expect(lifecycle).toEqual({ openOptions: false, reconnect: true })
    expect(restored).toEqual({
      kind: 'paired',
      pairing: {
        port: 43120,
        secret: SECRET,
        extensionOrigin: EXPECTED_EXTENSION_ORIGIN,
        confirmed: true
      }
    })
  })

  it('opens setup only on first installation and treats unpacked reload as a silent update', () => {
    expect(getInstalledLifecycle('install')).toEqual({ openOptions: true, reconnect: true })
    expect(getInstalledLifecycle('update')).toEqual({ openOptions: false, reconnect: true })
  })

  it('distinguishes missing durable pairing from unreadable durable pairing', () => {
    expect(parseDurablePairing({}, EXPECTED_EXTENSION_ORIGIN)).toEqual({ kind: 'none' })
    expect(
      parseDurablePairing(
        {
          orbitPort: 43117,
          orbitSecret: 'damaged',
          orbitExtensionOrigin: EXPECTED_EXTENSION_ORIGIN,
          orbitPairingConfirmed: true
        },
        EXPECTED_EXTENSION_ORIGIN
      )
    ).toMatchObject({ kind: 'unreadable', error: { code: 'PAIRING_STORAGE_UNREADABLE' } })
  })
})
