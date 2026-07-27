import type { VoiceCorrection, VoiceTranscript } from '../../shared/types'

const LEADING_COMMANDS = [
  'open',
  'launch',
  'start',
  'focus',
  'maximize',
  'minimize',
  'restore',
  'close',
  'play',
  'pause',
  'next',
  'previous',
  'skip',
  'volume',
  'turn',
  'set',
  'change',
  'mute',
  'unmute',
  'search',
  'tell',
  'what',
  'stop',
  'disable',
  'clear',
  'delete',
  'move',
  'rename',
  'download',
  'upload',
  'extract',
  'install',
  'save',
  'restart',
  'shutdown',
  'lock',
  'send',
  'join',
  'leave'
] as const

const BUILT_IN_APPLICATIONS: ReadonlyArray<readonly [string, string]> = [
  ['youtube', 'YouTube'],
  ['you tube', 'YouTube'],
  ['google chrome', 'Google Chrome'],
  ['chrome', 'Chrome'],
  ['browser', 'browser'],
  ['spotify', 'Spotify'],
  ['calculator', 'Calculator'],
  ['calc', 'Calculator'],
  ['file explorer', 'File Explorer'],
  ['explorer', 'File Explorer'],
  ['visual studio code', 'Visual Studio Code'],
  ['vs code', 'VS Code'],
  ['vscode', 'VS Code'],
  ['code editor', 'code editor']
]

const PROTECTED_APPLICATIONS: ReadonlyArray<readonly [string, string]> = [
  ['powershell', 'PowerShell'],
  ['power shell', 'PowerShell'],
  ['command prompt', 'Command Prompt'],
  ['windows terminal', 'Windows Terminal'],
  ['registry editor', 'Registry Editor']
]

type ApplicationAliases = Readonly<Record<string, readonly string[]>>
type Candidate = { match: string; replacement: string }

function comparable(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function damerauLevenshteinDistance(left: string, right: string): number {
  const a = comparable(left)
  const b = comparable(right)
  const matrix = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0))

  for (let row = 0; row <= a.length; row += 1) matrix[row][0] = row
  for (let column = 0; column <= b.length; column += 1) matrix[0][column] = column

  for (let row = 1; row <= a.length; row += 1) {
    for (let column = 1; column <= b.length; column += 1) {
      const substitutionCost = a[row - 1] === b[column - 1] ? 0 : 1
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitutionCost
      )

      if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
        matrix[row][column] = Math.min(
          matrix[row][column],
          matrix[row - 2][column - 2] + substitutionCost
        )
      }
    }
  }

  return matrix[a.length][b.length]
}

function maximumDistance(value: string): number {
  const length = comparable(value).replace(/\s/g, '').length
  if (length >= 8) return 2
  if (length >= 4) return 1
  return 0
}

function uniqueClosest(value: string, candidates: readonly Candidate[]): Candidate | null {
  const normalizedValue = comparable(value)
  const exact = candidates.find((candidate) => comparable(candidate.match) === normalizedValue)
  if (exact) return exact

  const allowedDistance = maximumDistance(value)
  if (allowedDistance === 0) return null

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      distance: damerauLevenshteinDistance(normalizedValue, candidate.match)
    }))
    .filter(({ distance }) => distance <= allowedDistance)
    .sort((left, right) => left.distance - right.distance)

  if (ranked.length === 0) return null
  if (ranked.length > 1 && ranked[0].distance === ranked[1].distance) return null
  return ranked[0].candidate
}

function recordCorrection(
  corrections: VoiceCorrection[],
  from: string,
  to: string,
  kind: VoiceCorrection['kind']
): void {
  if (comparable(from) === comparable(to)) return
  corrections.push({ from, to, kind })
}

function replaceWord(
  words: string[],
  index: number,
  candidates: readonly string[],
  corrections: VoiceCorrection[]
): boolean {
  const current = words[index]
  if (!current) return false
  const match = uniqueClosest(
    current,
    candidates.map((candidate) => ({ match: candidate, replacement: candidate }))
  )
  if (!match) return false
  recordCorrection(corrections, current, match.replacement, 'command')
  words[index] = match.replacement
  return true
}

function applicationCandidates(applicationAliases: ApplicationAliases): Candidate[] {
  const configured = Object.entries(applicationAliases).flatMap(([name, aliases]) =>
    [name, ...aliases].map((alias) => ({ match: alias, replacement: alias }))
  )
  return [
    ...BUILT_IN_APPLICATIONS.map(([match, replacement]) => ({ match, replacement })),
    ...PROTECTED_APPLICATIONS.map(([match, replacement]) => ({ match, replacement })),
    ...configured
  ]
}

function replaceApplicationSpan(
  words: string[],
  start: number,
  end: number,
  aliases: ApplicationAliases,
  corrections: VoiceCorrection[]
): boolean {
  if (start >= end) return false
  const current = words.slice(start, end).join(' ')
  const match = uniqueClosest(current, applicationCandidates(aliases))
  if (!match) return false
  recordCorrection(corrections, current, match.replacement, 'application')
  words.splice(start, end - start, match.replacement)
  return true
}

function normalizeSearch(words: string[], corrections: VoiceCorrection[]): void {
  if (words.length < 2) return
  if (comparable(words[1]) === 'you' && comparable(words[2] ?? '') === 'tube') {
    recordCorrection(corrections, `${words[1]} ${words[2]}`, 'YouTube', 'application')
    words.splice(1, 2, 'YouTube')
  } else {
    replaceWord(words, 1, ['youtube', 'google', 'web'], corrections)
    if (comparable(words[1]) === 'youtube') words[1] = 'YouTube'
    if (comparable(words[1]) === 'google') words[1] = 'Google'
  }
}

function normalizeFixedGrammar(
  words: string[],
  applicationAliases: ApplicationAliases,
  corrections: VoiceCorrection[]
): void {
  const command = comparable(words[0] ?? '')
  if (
    ['open', 'launch', 'start', 'focus', 'maximize', 'minimize', 'restore', 'close'].includes(
      command
    )
  ) {
    if (!replaceApplicationSpan(words, 1, words.length, applicationAliases, corrections)) {
      replaceApplicationSpan(words, 1, Math.min(3, words.length), applicationAliases, corrections)
    }
    return
  }

  if (command === 'search') {
    normalizeSearch(words, corrections)
    return
  }

  if (command === 'volume') {
    replaceWord(words, 1, ['up', 'down'], corrections)
    return
  }

  if (command === 'turn') {
    replaceWord(words, 1, ['volume'], corrections)
    replaceWord(words, 2, ['up', 'down'], corrections)
    return
  }

  if (command === 'set' || command === 'change') {
    replaceWord(words, 1, ['volume'], corrections)
    replaceWord(words, 2, ['to'], corrections)
    return
  }

  if (command === 'play') {
    const destinationIndex = words.findIndex(
      (word, index) => index > 0 && ['on', 'in'].includes(comparable(word))
    )
    if (destinationIndex >= 0) {
      replaceApplicationSpan(
        words,
        destinationIndex + 1,
        words.length,
        applicationAliases,
        corrections
      )
    } else if (words.length <= 4) {
      replaceWord(words, 1, ['pause', 'music', 'media'], corrections)
    }
    return
  }

  if (command === 'stop') replaceWord(words, 1, ['speaking'], corrections)
  if (command === 'disable') replaceWord(words, 1, ['orbit'], corrections)
  if (command === 'clear') replaceWord(words, 1, ['conversation'], corrections)
}

export function normalizeVoiceCommand(
  rawText: string,
  applicationAliases: ApplicationAliases = {}
): VoiceTranscript {
  const cleaned = rawText.trim().replace(/\s+/g, ' ')
  if (!cleaned) return { rawText: '', normalizedText: '', corrections: [] }

  const trailingPunctuation = cleaned.match(/[.!?]+$/)?.[0] ?? ''
  const body = trailingPunctuation ? cleaned.slice(0, -trailingPunctuation.length).trim() : cleaned
  const words = body.split(/\s+/)
  const corrections: VoiceCorrection[] = []

  const leading = uniqueClosest(
    words[0],
    LEADING_COMMANDS.map((command) => ({ match: command, replacement: command }))
  )
  if (!leading) return { rawText: cleaned, normalizedText: cleaned, corrections }

  const leadingWasCorrected = comparable(words[0]) !== comparable(leading.replacement)
  recordCorrection(corrections, words[0], leading.replacement, 'command')
  if (leadingWasCorrected) words[0] = leading.replacement
  normalizeFixedGrammar(words, applicationAliases, corrections)

  return {
    rawText: cleaned,
    normalizedText: `${words.join(' ')}${trailingPunctuation}`,
    corrections
  }
}
