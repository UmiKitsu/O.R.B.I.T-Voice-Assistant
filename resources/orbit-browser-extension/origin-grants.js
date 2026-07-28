/* eslint-disable @typescript-eslint/explicit-function-return-type */

export function normalizeExactOrigin(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hostname.includes('*') ||
      url.origin !== value
    ) {
      return null
    }
    return url.origin
  } catch {
    return null
  }
}

export function migrateExactOriginPatterns(patterns, existingOrigins = []) {
  const existing = existingOrigins.flatMap((origin) => {
    const normalized = normalizeExactOrigin(origin)
    return normalized ? [normalized] : []
  })
  const migrated = patterns.flatMap((pattern) => {
    if (
      pattern === 'http://*/*' ||
      pattern === 'https://*/*' ||
      pattern === 'https://www.youtube.com/*' ||
      typeof pattern !== 'string' ||
      !pattern.endsWith('/*')
    ) {
      return []
    }
    const normalized = normalizeExactOrigin(pattern.slice(0, -2))
    return normalized ? [normalized] : []
  })
  return [...new Set([...existing, ...migrated])].sort()
}
