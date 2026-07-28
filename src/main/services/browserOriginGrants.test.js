import { describe, expect, it } from 'vitest'
import {
  migrateExactOriginPatterns,
  normalizeExactOrigin
} from '../../../resources/orbit-browser-extension/origin-grants.js'

describe('browser exact-origin grants', () => {
  it.each([
    ['https://example.com', 'https://example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['https://example.com/path', null],
    ['https://user:password@example.com', null],
    ['chrome://extensions', null],
    ['file:///C:/secret.txt', null],
    ['https://*.example.com', null]
  ])('normalizes only an exact HTTP(S) origin: %s', (value, expected) => {
    expect(normalizeExactOrigin(value)).toBe(expected)
  })

  it('migrates exact grants while rejecting broad and fixed host permissions', () => {
    expect(
      migrateExactOriginPatterns(
        [
          'http://*/*',
          'https://*/*',
          'https://www.youtube.com/*',
          'https://example.com/*',
          'http://localhost:3000/*',
          'chrome://extensions/*'
        ],
        ['https://existing.example']
      )
    ).toEqual([
      'http://localhost:3000',
      'https://example.com',
      'https://existing.example'
    ])
  })

  it('deduplicates grants without broadening their origin', () => {
    expect(
      migrateExactOriginPatterns(
        ['https://example.com/*', 'https://example.com/*'],
        ['https://example.com']
      )
    ).toEqual(['https://example.com'])
  })
})
