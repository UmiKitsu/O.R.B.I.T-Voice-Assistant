/* eslint-disable @typescript-eslint/explicit-function-return-type */

export const DURABLE_PAIRING_KEYS = Object.freeze([
  'orbitPort',
  'orbitSecret',
  'orbitExtensionOrigin',
  'orbitPairingConfirmed'
])

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

export function parseDurablePairing(stored, expectedOrigin) {
  const hasPairingValue = DURABLE_PAIRING_KEYS.some((key) => hasOwn(stored, key))
  if (!hasPairingValue) return { kind: 'none' }

  const validPort =
    Number.isInteger(stored.orbitPort) && stored.orbitPort >= 43117 && stored.orbitPort <= 43127
  const validSecret =
    typeof stored.orbitSecret === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(stored.orbitSecret)
  const validOrigin = stored.orbitExtensionOrigin === expectedOrigin
  const validConfirmed =
    stored.orbitPairingConfirmed === undefined || typeof stored.orbitPairingConfirmed === 'boolean'

  if (!validPort || !validSecret || !validOrigin || !validConfirmed) {
    return {
      kind: 'unreadable',
      error: {
        code: 'PAIRING_STORAGE_UNREADABLE',
        message:
          'Chrome found saved Orbit pairing data, but it could not be read safely. Forget the local pairing and pair again.'
      }
    }
  }

  return {
    kind: 'paired',
    pairing: {
      port: stored.orbitPort,
      secret: stored.orbitSecret,
      extensionOrigin: stored.orbitExtensionOrigin,
      confirmed: stored.orbitPairingConfirmed !== false
    }
  }
}

export function createDurablePairingRecord({ port, secret, extensionOrigin, confirmed }) {
  return {
    orbitPort: port,
    orbitSecret: secret,
    orbitExtensionOrigin: extensionOrigin,
    orbitPairingConfirmed: confirmed
  }
}
