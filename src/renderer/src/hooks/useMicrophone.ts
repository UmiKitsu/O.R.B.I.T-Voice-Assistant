import { useRef } from 'react'
import type { ActionResult, Transcription } from '../../../shared/types'
import { recordingBlobToWav } from '../audioEncoding'

const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

function microphoneFailure(error: unknown): ActionResult {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return {
      ok: false,
      code: 'NO_MICROPHONE',
      message: 'No microphone was detected.',
      recoverable: true
    }
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return {
      ok: false,
      code: 'MICROPHONE_PERMISSION_DENIED',
      message: 'Microphone permission was denied.',
      recoverable: true
    }
  }
  return {
    ok: false,
    code: 'MICROPHONE_UNAVAILABLE',
    message: 'The microphone could not be started.',
    recoverable: true
  }
}

function preferredMimeType(): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((type) =>
    MediaRecorder.isTypeSupported(type)
  )
}

export type MicrophoneController = {
  startRecording: () => Promise<ActionResult>
  stopAndTranscribe: () => Promise<ActionResult<Transcription>>
  cancelRecording: () => ActionResult
  cancelTranscription: () => Promise<ActionResult>
}

export function useMicrophone(): MicrophoneController {
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const cancelledRef = useRef(false)

  const releaseStream = (): void => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const startRecording = async (): Promise<ActionResult> => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return {
        ok: false,
        code: 'NO_MICROPHONE',
        message: 'No microphone was detected.',
        recoverable: true
      }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS })
      const mimeType = preferredMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      chunksRef.current = []
      cancelledRef.current = false
      streamRef.current = stream
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.start(250)
      void window.titan.recordingStarted().catch(() => undefined)
      return { ok: true, message: 'Recording started.' }
    } catch (error) {
      releaseStream()
      return microphoneFailure(error)
    }
  }

  const stopAndTranscribe = async (): Promise<ActionResult<Transcription>> => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      return {
        ok: false,
        code: 'NO_ACTIVE_RECORDING',
        message: 'There is no active recording.',
        recoverable: true
      }
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType }))
      recorder.onerror = () => reject(new Error('MediaRecorder failed'))
      recorder.stop()
    }).finally(() => {
      recorderRef.current = null
      releaseStream()
    })

    if (blob.size === 0) {
      return {
        ok: false,
        code: 'NO_SPEECH_DETECTED',
        message: 'No speech was detected.',
        recoverable: true
      }
    }

    try {
      const wav = await recordingBlobToWav(blob)
      if (cancelledRef.current) {
        return {
          ok: false,
          code: 'TRANSCRIPTION_CANCELLED',
          message: 'The recording was cancelled.',
          recoverable: true
        }
      }
      return await window.titan.transcribeAudio(wav)
    } catch {
      return {
        ok: false,
        code: 'TRANSCRIPTION_FAILED',
        message: 'I could not understand the recording.',
        recoverable: true
      }
    } finally {
      chunksRef.current = []
    }
  }

  const cancelRecording = (): ActionResult => {
    const recorder = recorderRef.current
    cancelledRef.current = true
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.stop()
    }
    recorderRef.current = null
    chunksRef.current = []
    releaseStream()
    return { ok: true, message: 'The recording was cancelled.' }
  }

  return {
    startRecording,
    stopAndTranscribe,
    cancelRecording,
    cancelTranscription: () => {
      cancelledRef.current = true
      return window.titan.cancelTranscription()
    }
  }
}
