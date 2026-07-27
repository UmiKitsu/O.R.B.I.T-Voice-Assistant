import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import type { CapabilityDefinition, CapabilityRisk } from '../capabilities/capabilityTypes'
import { ConfirmationManager } from './confirmationManager'
import { PolicyEngine } from './policyEngine'

const permanentlyBlocked = [
  'filesystem.delete',
  'filesystem.move',
  'browser.download',
  'shell.execute',
  'powershell.execute',
  'software.install'
]

const confirmationRequired = [
  'system.restart',
  'system.shutdown',
  'network.disableWifi',
  'communication.sendMessage'
]

function registerCapability(
  registry: CapabilityRegistry,
  name: string,
  risk: CapabilityRisk,
  execute = vi.fn(async () => ({ completed: true }))
): void {
  const definition: CapabilityDefinition<{ target: string }, { completed: boolean }> = {
    name,
    risk,
    timeoutMs: 1_000,
    execute
  }

  registry.register(
    definition,
    z.object({ target: z.string() }).strict(),
    z.object({ completed: z.boolean() }).strict()
  )
}

describe('PolicyEngine', () => {
  it.each(permanentlyBlocked)('blocks %s before registration is considered', async (name) => {
    const engine = new PolicyEngine(new CapabilityRegistry(), new ConfirmationManager())

    await expect(
      engine.evaluateAndExecute({ capability: name, parameters: {}, summary: `Run ${name}` })
    ).resolves.toMatchObject({ status: 'blocked' })
  })

  it.each(confirmationRequired)('requires a matching confirmation for %s', async (name) => {
    const registry = new CapabilityRegistry()
    const confirmations = new ConfirmationManager()
    const execute = vi.fn(async () => ({ completed: true }))
    registerCapability(registry, name, 'confirmation-required', execute)
    const engine = new PolicyEngine(registry, confirmations)
    const request = {
      capability: name,
      parameters: { target: 'current-device' },
      summary: `Confirm ${name}`
    }

    const firstResult = await engine.evaluateAndExecute(request)
    expect(firstResult.status).toBe('confirmation-required')
    expect(execute).not.toHaveBeenCalled()

    if (firstResult.status !== 'confirmation-required') {
      throw new Error('Expected a confirmation request.')
    }

    expect(confirmations.confirm(firstResult.confirmation.requestId)).toBe(true)
    await expect(
      engine.evaluateAndExecute({
        ...request,
        confirmationRequestId: firstResult.confirmation.requestId
      })
    ).resolves.toMatchObject({ status: 'executed' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('validates parameters before requesting confirmation', async () => {
    const registry = new CapabilityRegistry()
    registerCapability(registry, 'system.restart', 'confirmation-required')
    const engine = new PolicyEngine(registry, new ConfirmationManager())

    await expect(
      engine.evaluateAndExecute({
        capability: 'system.restart',
        parameters: { target: 42 },
        summary: 'Restart this device'
      })
    ).resolves.toMatchObject({ status: 'invalid-parameters' })
  })

  it('matches parameters and consumes a confirmation once', async () => {
    const registry = new CapabilityRegistry()
    const confirmations = new ConfirmationManager()
    registerCapability(registry, 'system.shutdown', 'confirmation-required')
    const engine = new PolicyEngine(registry, confirmations)
    const request = {
      capability: 'system.shutdown',
      parameters: { target: 'current-device' },
      summary: 'Shut down this device'
    }
    const firstResult = await engine.evaluateAndExecute(request)

    if (firstResult.status !== 'confirmation-required') {
      throw new Error('Expected a confirmation request.')
    }

    const requestId = firstResult.confirmation.requestId
    confirmations.confirm(requestId)

    await expect(
      engine.evaluateAndExecute({
        ...request,
        parameters: { target: 'another-device' },
        confirmationRequestId: requestId
      })
    ).resolves.toMatchObject({ status: 'confirmation-invalid' })

    await expect(
      engine.evaluateAndExecute({ ...request, confirmationRequestId: requestId })
    ).resolves.toMatchObject({ status: 'executed' })

    await expect(
      engine.evaluateAndExecute({ ...request, confirmationRequestId: requestId })
    ).resolves.toMatchObject({ status: 'confirmation-invalid' })
  })

  it('expires and cancels confirmations', async () => {
    let now = 1_000
    const confirmations = new ConfirmationManager(() => now)
    const registry = new CapabilityRegistry()
    registerCapability(registry, 'network.disableWifi', 'confirmation-required')
    const engine = new PolicyEngine(registry, confirmations, 20)
    const request = {
      capability: 'network.disableWifi',
      parameters: { target: 'wifi' },
      summary: 'Disable Wi-Fi'
    }

    const expiring = await engine.evaluateAndExecute(request)
    if (expiring.status !== 'confirmation-required') {
      throw new Error('Expected a confirmation request.')
    }
    confirmations.confirm(expiring.confirmation.requestId)
    now += 20

    await expect(
      engine.evaluateAndExecute({
        ...request,
        confirmationRequestId: expiring.confirmation.requestId
      })
    ).resolves.toMatchObject({ status: 'confirmation-invalid' })

    const cancelled = await engine.evaluateAndExecute(request)
    if (cancelled.status !== 'confirmation-required') {
      throw new Error('Expected a confirmation request.')
    }
    expect(confirmations.cancel(cancelled.confirmation.requestId)).toBe(true)
    expect(confirmations.confirm(cancelled.confirmation.requestId)).toBe(false)
  })
})
