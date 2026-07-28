import { describe, expect, it } from 'vitest'
import type { BrowserConnectionStatus } from '../../shared/types'
import { getBrowserConnectionView } from './browserConnectionView'

const BASE_STATUS: BrowserConnectionStatus = {
  paired: false,
  connected: false,
  browser: 'chrome',
  phase: 'unpaired',
  pairingState: 'none',
  expectedExtensionId: 'bpnhommpdnofjjgbgjoehmdjglfglkje',
  siteAccessMode: 'restricted'
}

describe('browser connection renderer states', () => {
  it('shows setup only while genuinely unpaired', () => {
    expect(getBrowserConnectionView(BASE_STATUS)).toMatchObject({
      heading: 'Not paired',
      showSetup: true,
      showPairedSummary: false,
      canBeginPairing: true,
      canForget: false
    })
  })

  it('hides setup and pairing controls while paired', () => {
    const view = getBrowserConnectionView({
      ...BASE_STATUS,
      paired: true,
      pairingState: 'paired',
      phase: 'reconnecting'
    })
    expect(view).toMatchObject({
      heading: 'Paired, reconnecting',
      showSetup: false,
      showPairedSummary: true,
      canBeginPairing: false,
      canRetry: true,
      canForget: true
    })
    expect(view.description).toContain('reconnects automatically')
  })

  it('shows the one-time legacy identity migration steps', () => {
    const view = getBrowserConnectionView({
      ...BASE_STATUS,
      pairingState: 'legacy',
      phase: 'migration-required',
      legacyExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    })
    expect(view).toMatchObject({
      heading: 'One-time extension migration required',
      showSetup: false,
      showMigration: true,
      canBeginPairing: true,
      canForget: true
    })
    expect(view.description).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('surfaces unreadable storage and only offers explicit forgetting', () => {
    const view = getBrowserConnectionView({
      ...BASE_STATUS,
      pairingState: 'unreadable',
      phase: 'error',
      lastError: {
        code: 'BROWSER_PAIRING_STORAGE_UNREADABLE',
        message: 'Saved pairing could not be decrypted.'
      }
    })
    expect(view).toMatchObject({
      heading: 'Pairing storage error',
      description: 'Saved pairing could not be decrypted.',
      showSetup: false,
      canBeginPairing: false,
      canRetry: false,
      canForget: true
    })
  })
})
