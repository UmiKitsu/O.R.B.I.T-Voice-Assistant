import type {
  ActionResult,
  MicrophoneTestResult,
  VoiceDiagnostics,
  VoiceRoutePreview,
  VoiceTranscript
} from '../../shared/types'
import { routeDeterministicCommand } from '../assistant/commandRouter'
import { getSettings } from './settingsService'
import { analyzePcm16Samples } from './speechToTextValidation'
import { transcribeRecording } from './speechToTextService'
import { normalizeVoiceCommand } from './voiceCommandNormalizer'
import { stripWakePhraseDetails } from './wakeWordValidation'

export function previewVoiceRoute(text: string): VoiceRoutePreview {
  const plan = routeDeterministicCommand(text)
  const action = plan?.actions[0]
  if (!plan || !action) {
    return {
      kind: 'ai-required',
      summary:
        'No deterministic command matched; normal use would ask the local AI to interpret it.'
    }
  }

  return {
    kind: 'deterministic',
    summary: plan.summary,
    capability: action.capability,
    parameters: { ...action.parameters }
  }
}

export function prepareVoiceTranscript(rawText: string): VoiceTranscript | null {
  const stripped = stripWakePhraseDetails(rawText)
  if (!stripped.text) return null

  const transcript = normalizeVoiceCommand(stripped.text, getSettings().applicationAliases)
  if (stripped.wakeWord) {
    transcript.corrections.unshift({
      from: stripped.wakeWord.from,
      to: stripped.wakeWord.to,
      kind: 'wake-word'
    })
  }
  return transcript
}

export async function diagnoseVoiceRecording(
  audio: Uint8Array,
  signal: AbortSignal
): Promise<ActionResult<MicrophoneTestResult>> {
  const stats = analyzePcm16Samples(audio)
  if (!stats) {
    return {
      ok: false,
      code: 'INVALID_RECORDING',
      message: 'The microphone test was not valid 16 kHz mono audio.',
      recoverable: true
    }
  }

  const startedAt = performance.now()
  const result = await transcribeRecording(audio, signal)
  const transcriptionLatencyMs = Math.round(performance.now() - startedAt)
  if (!result.ok) return result
  if (!result.data?.text) {
    return {
      ok: false,
      code: 'TRANSCRIPTION_UNCLEAR',
      message: 'I could not understand the recording.',
      recoverable: true
    }
  }

  const transcript = prepareVoiceTranscript(result.data.text)
  if (!transcript) {
    return {
      ok: false,
      code: 'EMPTY_WAKE_WORD_COMMAND',
      message: 'Orbit heard the wake phrase, but no command followed it.',
      recoverable: true
    }
  }

  const diagnostics: VoiceDiagnostics = {
    ...stats,
    transcriptionLatencyMs,
    detectedLanguage: result.data.detectedLanguage,
    route: previewVoiceRoute(transcript.normalizedText)
  }
  return {
    ok: true,
    message: 'Microphone test transcribed locally. No action was executed.',
    data: { transcript, diagnostics }
  }
}
