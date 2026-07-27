import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePcm16Wav } from './wakeWordValidation'

const mocks = vi.hoisted(() => ({
  transcribeRecording: vi.fn()
}))

vi.mock('./speechToTextService', () => ({
  transcribeRecording: mocks.transcribeRecording
}))

import {
  diagnoseWakeCandidateRecording,
  prepareVoiceTranscript,
  previewVoiceRoute
} from './voiceDiagnosticsService'

function audibleWakeCandidate(): Uint8Array {
  return encodePcm16Wav(new Float32Array(3_200).fill(0.05))
}

beforeEach(() => {
  mocks.transcribeRecording.mockReset()
})

describe('voice diagnostics', () => {
  it('normalizes Filipino-accent wake and application spellings', () => {
    expect(prepareVoiceTranscript('Or bit, open Spotfy.')).toEqual({
      rawText: 'open Spotfy.',
      normalizedText: 'open Spotify.',
      corrections: [
        { from: 'Or bit', to: 'Orbit', kind: 'wake-word' },
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

  it('accepts exact leading wake variants and reuses the same command transcription', async () => {
    mocks.transcribeRecording.mockResolvedValue({
      ok: true,
      message: 'Recording transcribed locally.',
      data: {
        text: 'Or bit, open Spotfy.',
        detectedLanguage: 'en',
        backend: 'cpu-small',
        model: 'small'
      }
    })

    const result = await diagnoseWakeCandidateRecording(
      audibleWakeCandidate(),
      new AbortController().signal
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        detected: true,
        heardText: 'Or bit, open Spotfy.',
        wakePhrase: 'Or bit',
        transcript: {
          rawText: 'open Spotfy.',
          normalizedText: 'open Spotify.'
        },
        diagnostics: {
          detectedLanguage: 'en',
          transcriptionBackend: 'cpu-small',
          transcriptionModel: 'small',
          route: {
            kind: 'deterministic',
            capability: 'application.launch',
            parameters: { application: 'Spotify' }
          }
        }
      }
    })
    expect(mocks.transcribeRecording).toHaveBeenCalledOnce()
    expect(mocks.transcribeRecording).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(AbortSignal),
      'wake-candidate'
    )
  })

  it('accepts Orbit alone without constructing a route', async () => {
    mocks.transcribeRecording.mockResolvedValue({
      ok: true,
      message: 'Recording transcribed locally.',
      data: { text: 'Orbit', backend: 'cpu-small', model: 'small' }
    })

    const result = await diagnoseWakeCandidateRecording(
      audibleWakeCandidate(),
      new AbortController().signal
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        detected: true,
        heardText: 'Orbit',
        wakePhrase: 'Orbit'
      }
    })
    if (result.ok) {
      expect(result.data?.transcript).toBeUndefined()
      expect(result.data?.diagnostics).toBeUndefined()
    }
  })

  it('discards speech that does not begin with a trusted wake variant', async () => {
    mocks.transcribeRecording.mockResolvedValue({
      ok: true,
      message: 'Recording transcribed locally.',
      data: {
        text: 'Please explain orbital mechanics',
        backend: 'cpu-small',
        model: 'small'
      }
    })

    const result = await diagnoseWakeCandidateRecording(
      audibleWakeCandidate(),
      new AbortController().signal
    )

    expect(result).toMatchObject({
      ok: true,
      data: {
        detected: false,
        heardText: 'Please explain orbital mechanics'
      }
    })
    if (result.ok) expect(result.data?.diagnostics).toBeUndefined()
  })
})
