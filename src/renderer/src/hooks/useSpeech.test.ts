import { describe, expect, it } from 'vitest'
import { isSafeToSpeak } from './useSpeech'

describe('safe local speech filtering', () => {
  it('allows normal assistant responses', () => {
    expect(isSafeToSpeak('Opening Spotify.')).toBe(true)
    expect(isSafeToSpeak('The current time is 8:30 PM.')).toBe(true)
  })

  it('blocks structured action plans and capability JSON', () => {
    expect(
      isSafeToSpeak('{"kind":"action_plan","actions":[{"capability":"application.launch"}]}')
    ).toBe(false)
    expect(isSafeToSpeak('{"capability":"browser.openUrl"}')).toBe(false)
  })

  it('blocks stack traces and internal diagnostics', () => {
    expect(isSafeToSpeak('TypeError: broken\n    at run (app.ts:10:2)')).toBe(false)
    expect(isSafeToSpeak('Diagnostic details: backend path unavailable')).toBe(false)
  })

  it('blocks large fenced code while permitting a short spoken snippet', () => {
    expect(isSafeToSpeak(`\`\`\`json\n${'x'.repeat(260)}\n\`\`\``)).toBe(false)
    expect(isSafeToSpeak('Use `npm test` to run the tests.')).toBe(true)
  })
})
