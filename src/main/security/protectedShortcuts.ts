export type ShortcutContext = {
  fileExplorer: boolean
  automaticTextEntryAfterRun?: boolean
}

function normalizeKeys(keys: readonly string[]): Set<string> {
  return new Set(
    keys.map((key) => {
      const normalized = key.trim().toLocaleLowerCase()
      if (normalized === 'control') return 'ctrl'
      if (normalized === 'windows') return 'win'
      return normalized
    })
  )
}

function isExact(keys: Set<string>, expected: readonly string[]): boolean {
  return keys.size === expected.length && expected.every((key) => keys.has(key))
}

export function isProtectedShortcut(keys: readonly string[], context: ShortcutContext): boolean {
  const normalized = normalizeKeys(keys)
  if (isExact(normalized, ['ctrl', 's'])) return true
  if (isExact(normalized, ['ctrl', 'shift', 's'])) return true
  if (isExact(normalized, ['shift', 'delete'])) return true
  if (
    context.automaticTextEntryAfterRun &&
    (isExact(normalized, ['win', 'r']) || isExact(normalized, ['windows', 'r']))
  ) {
    return true
  }

  if (!context.fileExplorer) return false
  return (
    isExact(normalized, ['delete']) ||
    isExact(normalized, ['f2']) ||
    isExact(normalized, ['ctrl', 'x']) ||
    isExact(normalized, ['ctrl', 'v']) ||
    isExact(normalized, ['ctrl', 'shift', 'n'])
  )
}
