import { shell } from 'electron'
import type { ActionResult } from '../../shared/types'

export const MAX_EXTERNAL_URL_LENGTH = 2_048

export type ExternalUrlOpener = (url: string) => Promise<void>

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

export function validateExternalUrl(value: string): URL | null {
  if (
    value.length === 0 ||
    value.length > MAX_EXTERNAL_URL_LENGTH ||
    containsControlCharacter(value)
  )
    return null

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

export async function openExternalUrl(
  value: string,
  opener: ExternalUrlOpener = (url) => shell.openExternal(url)
): Promise<ActionResult> {
  const url = validateExternalUrl(value)
  if (!url) {
    return {
      ok: false,
      code: 'INVALID_EXTERNAL_URL',
      message: 'That URL is not allowed.',
      recoverable: true
    }
  }

  try {
    await opener(url.toString())
    return { ok: true, message: 'Opening the requested page.' }
  } catch {
    return {
      ok: false,
      code: 'BROWSER_OPEN_FAILED',
      message: 'The page could not be opened in the default browser.',
      recoverable: true
    }
  }
}
