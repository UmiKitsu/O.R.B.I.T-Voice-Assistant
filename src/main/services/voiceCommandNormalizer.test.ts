import { describe, expect, it } from 'vitest'
import { routeDeterministicCommand } from '../assistant/commandRouter'
import { damerauLevenshteinDistance, normalizeVoiceCommand } from './voiceCommandNormalizer'

describe('voice command normalization', () => {
  it('uses bounded Damerau-Levenshtein matching for command words', () => {
    expect(damerauLevenshteinDistance('oppen', 'open')).toBe(1)
    expect(damerauLevenshteinDistance('dwon', 'down')).toBe(1)
  })

  it.each([
    ['oppen YouTube', 'open YouTube'],
    ['volum dawn', 'volume down'],
    ['delate this file', 'delete this file'],
    ['resart the computer', 'restart the computer'],
    ['open Spotfy', 'open Spotify']
  ])('corrects known command vocabulary in %s', (input, expected) => {
    const transcript = normalizeVoiceCommand(input)
    expect(transcript.normalizedText).toBe(expected)
    expect(transcript.corrections.length).toBeGreaterThan(0)
  })

  it('routes a corrected destructive verb into the blocked policy path', () => {
    const transcript = normalizeVoiceCommand('delate this file')
    expect(routeDeterministicCommand(transcript.normalizedText)).toMatchObject({
      actions: [{ capability: 'filesystem.delete' }]
    })
  })
  it('normalizes known multi-word applications', () => {
    expect(normalizeVoiceCommand('open you tube').normalizedText).toBe('open YouTube')
    expect(normalizeVoiceCommand('search you tube for TypeScript').normalizedText).toBe(
      'search YouTube for TypeScript'
    )
  })

  it('uses configured aliases only in application argument positions', () => {
    expect(normalizeVoiceCommand('open obsidan', { notes: ['obsidian'] }).normalizedText).toBe(
      'open obsidian'
    )
  })

  it.each([
    'Explain volumetric lighting in simple words.',
    'Search Google for Taitanic facts.',
    'play Taitan Dreams on Spotify',
    'Tell me why YouTube is popular.'
  ])('preserves free-form content in %s', (input) => {
    const transcript = normalizeVoiceCommand(input)
    if (input.startsWith('play ')) {
      expect(transcript.normalizedText).toContain('Taitan Dreams')
    } else if (input.startsWith('Search ')) {
      expect(transcript.normalizedText).toContain('Taitanic facts')
    } else {
      expect(transcript.normalizedText).toBe(input)
    }
  })

  it('rejects an ambiguous fuzzy correction', () => {
    const transcript = normalizeVoiceCommand('sent this message')
    expect(transcript.normalizedText).toBe('sent this message')
    expect(transcript.corrections).toEqual([])
  })
})
