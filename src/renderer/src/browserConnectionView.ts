import type { BrowserConnectionStatus } from '../../shared/types'

export type BrowserConnectionView = {
  heading: string
  description: string
  showSetup: boolean
  showMigration: boolean
  showPairedSummary: boolean
  canBeginPairing: boolean
  canRetry: boolean
  canForget: boolean
}

export function getBrowserConnectionView(status: BrowserConnectionStatus): BrowserConnectionView {
  if (status.pairingState === 'legacy') {
    return {
      heading: 'One-time extension migration required',
      description: status.legacyExtensionId
        ? `Orbit found the legacy extension ID ${status.legacyExtensionId}. Remove that entry, load the updated bundled extension, and pair once.`
        : 'Remove the legacy Orbit Browser Control entry, load the updated bundled extension, and pair once.',
      showSetup: false,
      showMigration: true,
      showPairedSummary: false,
      canBeginPairing: true,
      canRetry: false,
      canForget: true
    }
  }

  if (status.pairingState === 'unreadable') {
    return {
      heading: 'Pairing storage error',
      description:
        status.lastError?.message ??
        'Orbit found saved browser pairing data, but it could not be decrypted or read.',
      showSetup: false,
      showMigration: false,
      showPairedSummary: false,
      canBeginPairing: false,
      canRetry: false,
      canForget: true
    }
  }

  if (status.paired) {
    return {
      heading: status.connected ? 'Connected' : 'Paired, reconnecting',
      description: status.connected
        ? `Chrome extension ${status.extensionVersion ?? 'version unknown'} is responding on port ${status.activePort ?? 'unknown'}.`
        : status.lastError?.message ?? 'Paired—reconnects automatically after updates and restarts.',
      showSetup: false,
      showMigration: false,
      showPairedSummary: true,
      canBeginPairing: false,
      canRetry: true,
      canForget: true
    }
  }

  return {
    heading:
      status.phase === 'pairing' || status.phase === 'authenticating'
        ? 'Pairing'
        : status.phase === 'error'
          ? 'Connection error'
          : 'Not paired',
    description:
      status.lastError?.message ??
      'Orbit uses its own trusted unpacked extension for typed browser actions.',
    showSetup: true,
    showMigration: false,
    showPairedSummary: false,
    canBeginPairing: true,
    canRetry: false,
    canForget: false
  }
}
