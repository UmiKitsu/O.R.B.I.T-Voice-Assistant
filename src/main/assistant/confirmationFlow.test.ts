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

  it('strictly validates renderer confirmation payloads', () => {
    expect(parseConfirmationResponse({ requestId: 'abc', approved: true })).toEqual({
      requestId: 'abc',
      approved: true
    })
    expect(parseConfirmationResponse({ requestId: 'abc', approved: true, extra: 1 })).toBeNull()
    expect(parseConfirmationResponse({ requestId: 'abc', approved: 'yes' })).toBeNull()
  })
})
