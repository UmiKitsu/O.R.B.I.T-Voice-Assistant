import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import {
  performMediaControl,
  setAudioVolume,
  type AudioMuteController,
  type AudioVolumeController,
  type MediaControlAction,
  type MediaKeySender
} from '../services/mediaControlService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { emptyActionResultSchema } from './resultSchemas'

const noParametersSchema = z.object({}).strict()

const capabilityActions = {
  'media.playPause': 'playPause',
  'media.next': 'next',
  'media.previous': 'previous',
  'audio.volumeUp': 'volumeUp',
  'audio.volumeDown': 'volumeDown',
  'audio.mute': 'mute',
  'audio.unmute': 'unmute'
} as const satisfies Record<string, MediaControlAction>

export function registerMediaCapabilities(
  registry: CapabilityRegistry,
  sender?: MediaKeySender,
  muteController?: AudioMuteController,
  volumeController?: AudioVolumeController
): void {
  for (const [name, action] of Object.entries(capabilityActions)) {
    const definition: CapabilityDefinition<Record<string, never>, ActionResult> = {
      name,
      risk: 'automatic',
      timeoutMs: 2_000,
      execute: async (_parameters, signal) => {
        if (signal.aborted) throw new Error('The action was cancelled.')
        return performMediaControl(action, sender, muteController)
      }
    }

    registry.register(definition, noParametersSchema, emptyActionResultSchema)
  }

  const setVolume: CapabilityDefinition<{ volume: number }, ActionResult> = {
    name: 'audio.setVolume',
    risk: 'automatic',
    timeoutMs: 2_000,
    execute: async ({ volume }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return setAudioVolume(volume, volumeController)
    }
  }
  registry.register(
    setVolume,
    z.object({ volume: z.number().int().min(0).max(100) }).strict(),
    emptyActionResultSchema
  )
}
