import { describe, expect, it } from 'vitest'
import { deriveVoiceStartupStatus } from './voiceStartupState'

describe('deriveVoiceStartupStatus', () => {
  it('shows Preparing Voice until the microphone has produced samples', () => {
    expect(
      deriveVoiceStartupStatus({ microphone: 'pending', ollama: 'pending' })
    ).toBe('preparing-voice')
    expect(
      deriveVoiceStartupStatus({ microphone: 'pending', ollama: 'ready' })
    ).toBe('preparing-voice')
  })

  it('shows Preparing AI after voice preparation finishes first', () => {
    expect(
      deriveVoiceStartupStatus({ microphone: 'prepared', ollama: 'pending' })
    ).toBe('preparing-ai')
  })

  it('does not report Ready until both systems are confirmed', () => {
    expect(
      deriveVoiceStartupStatus({ microphone: 'prepared', ollama: 'ready' })
    ).toBe('preparing-voice')
    expect(
      deriveVoiceStartupStatus({ microphone: 'ready', ollama: 'ready' })
    ).toBe('ready')
  })

  it('shows Error when either startup subsystem fails', () => {
    expect(
      deriveVoiceStartupStatus({ microphone: 'error', ollama: 'ready' })
    ).toBe('error')
    expect(
      deriveVoiceStartupStatus({ microphone: 'prepared', ollama: 'error' })
    ).toBe('error')
  })
})
