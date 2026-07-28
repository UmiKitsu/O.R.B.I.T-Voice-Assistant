import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import type { CapabilityDefinition } from '../capabilities/capabilityTypes'
import { ConfirmationManager } from '../security/confirmationManager'
import { PolicyEngine } from '../security/policyEngine'
import { ConfirmationFlow, parseConfirmationResponse } from './confirmationFlow'

describe('ConfirmationFlow', () => {
  it('binds approval to the sender and resumes the exact pending action once', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, message: 'Message sent.' }))
    const definition: CapabilityDefinition<
      { text: string },
      Awaited<ReturnType<typeof execute>>
    > = {
      name: 'communication.sendMessage',
      risk: 'confirmation-required',
      timeoutMs: 1_000,
      confirmationSummary: ({ text }) => `Send “${text}”?`,
      execute
    }
    const registry = new CapabilityRegistry()
    registry.register(
      definition,
      z.object({ text: z.string() }).strict(),
      z.object({ ok: z.literal(true), message: z.string() }).strict()
    )
    const flow = new ConfirmationFlow(new PolicyEngine(registry, new ConfirmationManager()))
    const plan = {
      kind: 'action_plan' as const,
      summary: 'Send',
      actions: [{ capability: 'communication.sendMessage', parameters: { text: 'hello' } }]
    }

    const pending = await flow.execute(plan, 10)
    const requestId = pending.ok ? pending.data?.confirmation?.requestId : undefined
    expect(requestId).toBeTruthy()
    expect(execute).not.toHaveBeenCalled()

    await expect(flow.respond(11, requestId ?? '', true)).resolves.toMatchObject({
      ok: false,
      code: 'CONFIRMATION_NOT_FOUND'
    })
    await expect(flow.respond(10, requestId ?? '', true)).resolves.toMatchObject({
      ok: true,
      data: { response: 'Message sent.' }
    })
    expect(execute).toHaveBeenCalledOnce()
    await expect(flow.respond(10, requestId ?? '', true)).resolves.toMatchObject({
      ok: false,
      code: 'CONFIRMATION_NOT_FOUND'
    })
  })

  it('keeps a protected action pending after a wrong PIN and executes it after the correct PIN', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, message: 'Deleted safely.' }))
    const definition: CapabilityDefinition<
      { path: string },
      Awaited<ReturnType<typeof execute>>
    > = {
      name: 'filesystem.delete',
      risk: 'pin-required',
      timeoutMs: 1_000,
      confirmationSummary: ({ path }) => `Delete ${path}?`,
      execute
    }
    const registry = new CapabilityRegistry()
    registry.register(
      definition,
      z.object({ path: z.string() }).strict(),
      z.object({ ok: z.literal(true), message: z.string() }).strict()
    )
    const flow = new ConfirmationFlow(
      new PolicyEngine(registry, new ConfirmationManager(), 20_000, {
        hasPin: () => true,
        verify: async (pin) =>
          pin === '1234'
            ? { ok: true }
            : { ok: false, code: 'PIN_INVALID', message: 'Incorrect PIN.' }
      })
    )
    const plan = {
      kind: 'action_plan' as const,
      summary: 'Delete',
      actions: [{ capability: 'filesystem.delete', parameters: { path: 'C:\\file.txt' } }]
    }

    const pending = await flow.execute(plan, 20)
    expect(pending).toMatchObject({
      ok: true,
      data: { confirmation: { authorization: 'pin', pinConfigured: true } }
    })
    const requestId = pending.ok ? pending.data?.confirmation?.requestId : undefined

    await expect(flow.respond(20, requestId ?? '', true, '0000')).resolves.toMatchObject({
      ok: false,
      code: 'PIN_INVALID'
    })
    expect(execute).not.toHaveBeenCalled()

    await expect(flow.respond(20, requestId ?? '', true, '1234')).resolves.toMatchObject({
      ok: true,
      data: { response: 'Deleted safely.' }
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('strictly validates renderer confirmation payloads', () => {
    expect(parseConfirmationResponse({ requestId: 'abc', approved: true })).toEqual({
      requestId: 'abc',
      approved: true
    })
    expect(parseConfirmationResponse({ requestId: 'abc', approved: true, pin: '1234' })).toEqual({
      requestId: 'abc',
      approved: true,
      pin: '1234'
    })
    expect(parseConfirmationResponse({ requestId: 'abc', approved: true, pin: '12' })).toBeNull()
    expect(parseConfirmationResponse({ requestId: 'abc', approved: true, extra: 1 })).toBeNull()
    expect(parseConfirmationResponse({ requestId: 'abc', approved: 'yes' })).toBeNull()
  })
})
