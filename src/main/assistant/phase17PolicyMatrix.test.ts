import { describe, expect, it, vi } from 'vitest'
import type { ActionResult } from '../../shared/types'
import { z } from 'zod'
import { routeDeterministicCommand } from './commandRouter'
import { executeDeterministicAction } from './deterministicActionExecutor'
import { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import { createCapabilityRegistry } from '../capabilities/capabilityRuntime'
import type { CapabilityDefinition } from '../capabilities/capabilityTypes'
import { emptyActionResultSchema } from '../capabilities/resultSchemas'
import { blockedCapabilities } from '../security/blockedCapabilities'
import { ConfirmationManager } from '../security/confirmationManager'
import { PolicyEngine } from '../security/policyEngine'

const requiredRejections = [
  ['Delete my Downloads folder.', 'filesystem.delete'],
  ['Move this file to Desktop.', 'filesystem.move'],
  ['Rename this file.', 'filesystem.rename'],
  ['Download that installer.', 'browser.download'],
  ['Upload this image.', 'browser.upload'],
  ['Extract this ZIP file.', 'archive.extract'],
  ['Open PowerShell and run this command.', 'powershell.execute'],
  ['Install Spotify.', 'software.install'],
  ['Save this document.', 'filesystem.write']
] as const

const requiredConfirmations = [
  ['Restart the computer.', 'system.restart'],
  ['Shut down the computer.', 'system.shutdown'],
  ['Close all applications.', 'application.closeAll'],
  ['Turn off Wi-Fi.', 'network.disableWifi'],
  ['Send this message.', 'communication.sendMessage']
] as const

const requiredAllowed = [
  ['Open Spotify.', 'application.launch', { application: 'Spotify' }],
  ['Open YouTube.', 'browser.openUrl', { url: 'https://www.youtube.com' }],
  ['Open Calculator.', 'application.launch', { application: 'Calculator' }],
  ['Search Google.', 'browser.openUrl', { url: 'https://www.google.com' }],
  ['Set volume to 30 percent.', 'audio.setVolume', { volume: 30 }],
  ['Pause the music.', 'media.playPause', {}],
  ['Tell me the time.', 'system.getTime', {}],
  ['Maximize Chrome.', 'application.maximize', { application: 'Chrome' }]
] as const

function registerConfirmationCapability(
  registry: CapabilityRegistry,
  name: string
): ReturnType<typeof vi.fn> {
  const execute = vi.fn(async () => ({
    ok: true as const,
    message: 'Executed after confirmation.'
  }))
  const definition: CapabilityDefinition<Record<string, never>, ActionResult> = {
    name,
    // The centralized policy must override an accidentally permissive definition.
    risk: 'automatic',
    timeoutMs: 1_000,
    execute
  }
  registry.register(definition, z.object({}).strict(), emptyActionResultSchema)
  return execute
}

describe('Phase 17 required policy matrix', () => {
  it.each(requiredRejections)('always rejects: %s', async (message, capability) => {
    const plan = routeDeterministicCommand(message)
    expect(plan?.actions).toEqual([{ capability, parameters: {} }])
    expect(blockedCapabilities.has(capability)).toBe(true)
    await expect(executeDeterministicAction(message)).resolves.toMatchObject({
      ok: false,
      code: 'ACTION_BLOCKED'
    })
  })

  it.each(requiredConfirmations)('requires confirmation: %s', async (_message, capability) => {
    const registry = new CapabilityRegistry()
    const execute = registerConfirmationCapability(registry, capability)
    const engine = new PolicyEngine(registry, new ConfirmationManager())

    await expect(
      engine.evaluateAndExecute({ capability, parameters: {}, summary: `Confirm ${capability}` })
    ).resolves.toMatchObject({ status: 'confirmation-required' })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each(requiredAllowed)(
    'routes as an automatic action: %s',
    (message, capability, parameters) => {
      const plan = routeDeterministicCommand(message)
      expect(plan?.actions).toEqual([{ capability, parameters }])

      const registered = createCapabilityRegistry().get(capability)
      expect(registered?.risk).toBe('automatic')
      expect(registered?.parameterSchema.safeParse(parameters).success).toBe(true)
    }
  )
})
