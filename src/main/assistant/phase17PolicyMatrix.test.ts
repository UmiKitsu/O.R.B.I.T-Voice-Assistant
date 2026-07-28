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

const permanentlyBlocked = [
  'browser.download',
  'browser.upload',
  'archive.extract',
  'powershell.execute',
  'software.uninstall',
  'security.bypassUac'
] as const

const pinProtected = [
  [
    'Delete C:\\Users\\Test\\Downloads\\old.txt.',
    'filesystem.delete',
    { path: 'C:\\Users\\Test\\Downloads\\old.txt' }
  ],
  [
    'Move C:\\Users\\Test\\old.txt to C:\\Users\\Test\\Desktop\\old.txt.',
    'filesystem.move',
    {
      source: 'C:\\Users\\Test\\old.txt',
      destination: 'C:\\Users\\Test\\Desktop\\old.txt'
    }
  ],
  [
    'Copy C:\\Users\\Test\\old.txt to C:\\Users\\Test\\Desktop\\copy.txt.',
    'filesystem.copy',
    {
      source: 'C:\\Users\\Test\\old.txt',
      destination: 'C:\\Users\\Test\\Desktop\\copy.txt'
    }
  ],
  [
    'Rename C:\\Users\\Test\\old.txt to new.txt.',
    'filesystem.rename',
    { source: 'C:\\Users\\Test\\old.txt', newName: 'new.txt' }
  ],
  [
    'Create folder C:\\Users\\Test\\Desktop\\New Folder.',
    'filesystem.createDirectory',
    { path: 'C:\\Users\\Test\\Desktop\\New Folder' }
  ],
  [
    'Install C:\\Users\\Test\\Downloads\\setup.exe.',
    'software.install',
    { installerPath: 'C:\\Users\\Test\\Downloads\\setup.exe' }
  ],
  [
    'Append hello to C:\\Users\\Test\\Documents\\notes.txt.',
    'filesystem.append',
    { content: 'hello', path: 'C:\\Users\\Test\\Documents\\notes.txt' }
  ]
] as const

const requiredConfirmations = [
  ['Restart the computer.', 'system.restart'],
  ['Shut down the computer.', 'system.shutdown'],
  ['Close all applications.', 'application.closeAll'],
  ['Turn off Wi-Fi.', 'network.disableWifi'],
  ['Send this message.', 'communication.sendMessage'],
  ['Stop process 777.', 'process.stopUser']
] as const

const requiredAllowed = [
  ['Open Spotify.', 'application.launch', { application: 'Spotify' }],
  ['Open YouTube.', 'browser.openUrl', { url: 'https://www.youtube.com' }],
  ['Open Calculator.', 'application.launch', { application: 'Calculator' }],
  ['Search Google.', 'browser.openUrl', { url: 'https://www.google.com' }],
  ['Set volume to 30 percent.', 'audio.setVolume', { volume: 30 }],
  ['Pause the music.', 'media.playPause', {}],
  ['Tell me the time.', 'system.getTime', {}],
  ['Maximize Chrome.', 'application.maximize', { application: 'Chrome' }],
  ['Open PowerShell.', 'application.launch', { application: 'powershell' }],
  ['Show system information.', 'system.getInformation', {}],
  ['Show battery status.', 'system.getBattery', {}],
  ['Show network status.', 'system.getNetworkStatus', {}],
  ['List running processes.', 'process.listUser', { limit: 50 }],
  ['List available applications.', 'application.listAvailable', { limit: 50 }]
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
    risk: 'automatic',
    timeoutMs: 1_000,
    execute
  }
  registry.register(definition, z.object({}).strict(), emptyActionResultSchema)
  return execute
}

describe('Protected capability policy matrix', () => {
  it.each(permanentlyBlocked)('keeps %s permanently blocked', (capability) => {
    expect(blockedCapabilities.has(capability)).toBe(true)
  })

  it('opens a blank PowerShell window but blocks command-entry requests', () => {
    expect(routeDeterministicCommand('Open PowerShell.')?.actions).toEqual([
      { capability: 'application.launch', parameters: { application: 'powershell' } }
    ])
    expect(routeDeterministicCommand('Open PowerShell and run whoami.')?.actions).toEqual([
      { capability: 'powershell.execute', parameters: {} }
    ])
    expect(blockedCapabilities.has('powershell.execute')).toBe(true)
  })

  it.each(pinProtected)('routes %s as an exact PIN-protected action', async (message, capability, parameters) => {
    const plan = routeDeterministicCommand(message)
    expect(plan?.actions).toEqual([{ capability, parameters }])

    const registered = createCapabilityRegistry().get(capability)
    expect(registered?.risk).toBe('pin-required')
    expect(registered?.parameterSchema.safeParse(parameters).success).toBe(true)

    await expect(executeDeterministicAction(message)).resolves.toMatchObject({
      ok: false,
      code: 'ACTION_CONFIRMATION_REQUIRED'
    })
  })

  it.each(requiredConfirmations)('requires confirmation: %s', async (_message, capability) => {
    const registry = new CapabilityRegistry()
    const execute = registerConfirmationCapability(registry, capability)
    const engine = new PolicyEngine(registry, new ConfirmationManager())

    await expect(
      engine.evaluateAndExecute({ capability, parameters: {}, summary: `Confirm ${capability}` })
    ).resolves.toMatchObject({
      status: 'confirmation-required',
      confirmation: { authorization: 'confirmation' }
    })
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
