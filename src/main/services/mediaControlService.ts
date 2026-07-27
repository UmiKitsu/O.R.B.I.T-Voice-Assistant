import * as koffi from 'koffi'
import loudness from 'loudness'
import type { ActionResult } from '../../shared/types'

export type MediaControlAction =
  'playPause' | 'next' | 'previous' | 'volumeUp' | 'volumeDown' | 'mute' | 'unmute'

export type MediaKeyAction = Exclude<MediaControlAction, 'mute' | 'unmute'>
export type MediaKeySender = (action: MediaKeyAction) => boolean
export type AudioMuteController = (muted: boolean) => Promise<void>
export type AudioVolumeController = (volume: number) => Promise<void>

const virtualKeys: Record<MediaKeyAction, number> = {
  playPause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  volumeUp: 0xaf,
  volumeDown: 0xae
}

const messages: Record<MediaControlAction, string> = {
  playPause: 'Sent the play or pause media key.',
  next: 'Sent the next-track media key.',
  previous: 'Sent the previous-track media key.',
  volumeUp: 'Sent the volume-up key.',
  volumeDown: 'Sent the volume-down key.',
  mute: 'Audio muted.',
  unmute: 'Audio unmuted.'
}

type KeyboardInputEvent = {
  type: number
  u: {
    ki: {
      wVk: number
      wScan: number
      dwFlags: number
      time: number
      dwExtraInfo: number
    }
  }
}

type SendInputFunction = (count: number, inputs: KeyboardInputEvent[], inputSize: number) => number

let sendInputFunction: SendInputFunction | undefined
let inputSize: number | undefined

function getSendInput(): { sendInput: SendInputFunction; size: number } {
  if (process.platform !== 'win32') {
    throw new Error('Media controls are available only on Windows.')
  }

  if (!sendInputFunction || !inputSize) {
    const user32 = koffi.load('user32.dll')
    const mouseInput = koffi.struct('TITAN_MOUSEINPUT', {
      dx: 'long',
      dy: 'long',
      mouseData: 'uint32_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t'
    })
    const keyboardInput = koffi.struct('TITAN_KEYBDINPUT', {
      wVk: 'uint16_t',
      wScan: 'uint16_t',
      dwFlags: 'uint32_t',
      time: 'uint32_t',
      dwExtraInfo: 'uintptr_t'
    })
    const hardwareInput = koffi.struct('TITAN_HARDWAREINPUT', {
      uMsg: 'uint32_t',
      wParamL: 'uint16_t',
      wParamH: 'uint16_t'
    })
    const input = koffi.struct('TITAN_INPUT', {
      type: 'uint32_t',
      u: koffi.union({ mi: mouseInput, ki: keyboardInput, hi: hardwareInput })
    })

    sendInputFunction = user32.func(
      'unsigned int __stdcall SendInput(unsigned int cInputs, TITAN_INPUT *pInputs, int cbSize)'
    ) as SendInputFunction
    inputSize = koffi.sizeof(input)
  }

  return { sendInput: sendInputFunction, size: inputSize }
}

export const sendWindowsMediaKey: MediaKeySender = (action) => {
  const { sendInput, size } = getSendInput()
  const key = virtualKeys[action]
  const keyboardEvent = (keyUp: boolean): KeyboardInputEvent => ({
    type: 1,
    u: {
      ki: {
        wVk: key,
        wScan: 0,
        dwFlags: keyUp ? 0x2 : 0,
        time: 0,
        dwExtraInfo: 0
      }
    }
  })

  return sendInput(2, [keyboardEvent(false), keyboardEvent(true)], size) === 2
}

export const setWindowsAudioMuted: AudioMuteController = async (muted) => {
  await loudness.setMuted(muted)
}

export const setWindowsAudioVolume: AudioVolumeController = async (volume) => {
  await loudness.setVolume(volume)
}

export async function setAudioVolume(
  volume: number,
  controller: AudioVolumeController = setWindowsAudioVolume
): Promise<ActionResult> {
  try {
    await controller(volume)
    return { ok: true, message: `Volume set to ${volume} percent.` }
  } catch {
    return {
      ok: false,
      code: 'AUDIO_VOLUME_FAILED',
      message: 'The volume could not be changed.',
      recoverable: true
    }
  }
}

export async function performMediaControl(
  action: MediaControlAction,
  sender: MediaKeySender = sendWindowsMediaKey,
  muteController: AudioMuteController = setWindowsAudioMuted
): Promise<ActionResult> {
  try {
    if (action === 'mute' || action === 'unmute') {
      await muteController(action === 'mute')
    } else if (!sender(action)) {
      return {
        ok: false,
        code: 'MEDIA_KEY_NOT_SENT',
        message: 'Windows did not accept the media-control input.',
        recoverable: true
      }
    }

    return { ok: true, message: messages[action] }
  } catch {
    return {
      ok: false,
      code: 'MEDIA_CONTROL_FAILED',
      message: 'The media control could not be sent.',
      recoverable: true
    }
  }
}
