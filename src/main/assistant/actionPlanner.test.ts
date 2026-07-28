import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import type { CapabilityDefinition } from '../capabilities/capabilityTypes'
import { emptyActionResultSchema } from '../capabilities/resultSchemas'
import { ConfirmationManager } from '../security/confirmationManager'
import { PolicyEngine } from '../security/policyEngine'
import { executeActionPlan } from './actionPlanExecutor'
import type { ActionPlan } from './actionPlanSchemas'
import {
  createPlanningSystemMessage,
  describeRegisteredCapabilities,
  parseAndValidateAssistantOutput
} from './actionPlanner'
import { ORBIT_BRIEF_RESPONSE_STYLE, ORBIT_CONVERSATION_PERSONALITY } from './personality'

function registerTestCapability(
  registry: CapabilityRegistry,
  name: string,
  execute: CapabilityDefinition<{ value: string }, unknown>['execute'],
  risk: CapabilityDefinition<unknown, unknown>['risk'] = 'automatic'
): void {
  registry.register(
    {
      name,
      risk,
      timeoutMs: 1_000,
      execute
    },
    z.object({ value: z.string() }).strict(),
    emptyActionResultSchema
  )
}

describe('structured action planning', () => {
  it('uses the centralized personality while retaining the exact JSON protocol', () => {
    const prompt = createPlanningSystemMessage(new CapabilityRegistry()).content

    expect(prompt).toContain(ORBIT_CONVERSATION_PERSONALITY)
    expect(prompt).toContain(ORBIT_BRIEF_RESPONSE_STYLE)
    expect(prompt).toContain('Apply the personality instructions only to conversational responses.')
    expect(prompt).toContain('Keep action-plan summaries plain, precise, and operational.')
    expect(prompt).toContain('{"kind":"conversation","response":')
    expect(prompt).toContain('{"kind":"action_plan","summary":"What will be attempted","actions":')
    expect(prompt).toContain('{"kind":"browser_task","goal":"The user\'s exact browsing goal"}')
    expect(prompt).toContain('Return exactly one JSON object')
  })

  it('strictly validates the top-level output shape and action count', () => {
    const registry = new CapabilityRegistry()

    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({ kind: 'conversation', response: 'Hello.', extra: true }),
        registry
      )
    ).toBeNull()
    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({ kind: 'action_plan', summary: 'Nothing', actions: [] }),
        registry
      )
    ).toBeNull()
    expect(parseAndValidateAssistantOutput('{not-json', registry)).toBeNull()
    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({ kind: 'conversation', response: '   ' }),
        registry
      )
    ).toBeNull()
    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({
          kind: 'action_plan',
          summary: '',
          actions: [{ capability: 'test.first', parameters: {} }]
        }),
        registry
      )
    ).toBeNull()
    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({
          kind: 'action_plan',
          summary: 'Too many actions',
          actions: Array.from({ length: 6 }, () => ({
            capability: 'test.first',
            parameters: {}
          }))
        }),
        registry
      )
    ).toBeNull()
  })

  it('rejects unknown capabilities and invalid capability parameters', () => {
    const registry = new CapabilityRegistry()
    registerTestCapability(
      registry,
      'test.first',
      vi.fn(async () => ({ ok: true, message: 'ok' }))
    )

    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({
          kind: 'action_plan',
          summary: 'Unknown',
          actions: [{ capability: 'shell.execute', parameters: { value: 'no' } }]
        }),
        registry
      )
    ).toBeNull()
    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({
          kind: 'action_plan',
          summary: 'Wrong parameters',
          actions: [{ capability: 'test.first', parameters: { value: 42 } }]
        }),
        registry
      )
    ).toBeNull()
    expect(
      parseAndValidateAssistantOutput(
        JSON.stringify({
          kind: 'action_plan',
          summary: 'Executable field injection',
          actions: [
            {
              capability: 'test.first',
              parameters: { value: 'safe' },
              command: 'powershell.exe'
            }
          ]
        }),
        registry
      )
    ).toBeNull()
  })

  it('describes only registered names and their parameter JSON schemas', () => {
    const registry = new CapabilityRegistry()
    registerTestCapability(
      registry,
      'test.first',
      vi.fn(async () => ({ ok: true, message: 'ok' }))
    )

    expect(describeRegisteredCapabilities(registry)).toEqual([
      {
        name: 'test.first',
        parameters: expect.objectContaining({
          type: 'object',
          required: ['value'],
          additionalProperties: false
        })
      }
    ])
  })

  it('executes steps sequentially and stops after the first failed result', async () => {
    const registry = new CapabilityRegistry()
    const order: string[] = []
    const first = vi.fn(async () => {
      order.push('first')
      return {
        ok: false as const,
        code: 'FIRST_FAILED',
        message: 'First failed.',
        recoverable: true
      }
    })
    const second = vi.fn(async () => {
      order.push('second')
      return { ok: true as const, message: 'Second succeeded.' }
    })
    registerTestCapability(registry, 'test.first', first)
    registerTestCapability(registry, 'test.second', second)
    const engine = new PolicyEngine(registry, new ConfirmationManager())
    const plan: ActionPlan = {
      kind: 'action_plan',
      summary: 'Run two steps',
      actions: [
        { capability: 'test.first', parameters: { value: 'one' } },
        { capability: 'test.second', parameters: { value: 'two' } }
      ]
    }

    await expect(executeActionPlan(plan, engine)).resolves.toMatchObject({
      ok: false,
      code: 'FIRST_FAILED'
    })
    expect(order).toEqual(['first'])
    expect(second).not.toHaveBeenCalled()
  })

  it('does not continue while a step is awaiting confirmation', async () => {
    const registry = new CapabilityRegistry()
    const first = vi.fn(async () => ({ ok: true as const, message: 'First succeeded.' }))
    const second = vi.fn(async () => ({ ok: true as const, message: 'Second succeeded.' }))
    registerTestCapability(registry, 'test.confirm', first, 'confirmation-required')
    registerTestCapability(registry, 'test.second', second)
    const engine = new PolicyEngine(registry, new ConfirmationManager())
    const plan: ActionPlan = {
      kind: 'action_plan',
      summary: 'Confirm the first step',
      actions: [
        { capability: 'test.confirm', parameters: { value: 'one' } },
        { capability: 'test.second', parameters: { value: 'two' } }
      ]
    }

    await expect(executeActionPlan(plan, engine)).resolves.toMatchObject({
      ok: false,
      code: 'ACTION_CONFIRMATION_REQUIRED',
      message: 'Confirm the first step'
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })
})
