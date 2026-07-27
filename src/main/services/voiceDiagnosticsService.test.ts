import { describe, expect, it } from 'vitest'
import { prepareVoiceTranscript, previewVoiceRoute } from './voiceDiagnosticsService'

describe('voice diagnostics', () => {
  it('normalizes Filipino-accent wake and application spellings', () => {
    expect(prepareVoiceTranscript('Taytan, open Spotfy.')).toEqual({
      rawText: 'open Spotfy.',
      normalizedText: 'open Spotify.',
      corrections: [
        { from: 'Taytan', to: 'Titan', kind: 'wake-word' },
        { from: 'Spotfy', to: 'Spotify', kind: 'application' }
      ]
    })
  })

  it('previews a deterministic route without executing it', () => {
    expect(previewVoiceRoute('open Spotify')).toEqual({
      kind: 'deterministic',
      summary: 'Open a registered application',
      capability: 'application.launch',
      parameters: { application: 'Spotify' }
    })
  })

  it('reports that flexible conversation would require local AI interpretation', () => {
    expect(previewVoiceRoute('Explain photosynthesis')).toMatchObject({ kind: 'ai-required' })
  })
})
