import { z } from 'zod'
import type { ActionResult, DesktopWindowSnapshot } from '../../shared/types'
import {
  getDesktopElementDescription,
  inspectActiveDesktopWindow,
  performDesktopElementAction
} from '../services/desktopAutomationService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

function hasOnlyPlainText(text: string): boolean {
  return [...text].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint > 0x1f && codePoint !== 0x7f
  })
}

const elementRefSchema = z.string().uuid()
const elementSchema = z.object({ elementRef: elementRefSchema }).strict()
const setTextSchema = z
  .object({
    elementRef: elementRefSchema,
    text: z
      .string()
      .min(1)
      .max(4_000)
      .refine(hasOnlyPlainText, 'Text must not contain control characters.')
  })
  .strict()
const scrollSchema = z
  .object({
    elementRef: elementRefSchema,
    direction: z.enum(['up', 'down']),
    amount: z.enum(['small', 'medium', 'large'])
  })
  .strict()
const boundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int()
  })
  .strict()
const desktopElementSchema = z
  .object({
    ref: elementRefSchema,
    role: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    offscreen: z.boolean(),
    bounds: boundsSchema,
    patterns: z.array(z.enum(['invoke', 'toggle', 'select', 'value', 'scroll']))
  })
  .strict()
const snapshotSchema = z
  .object({
    windowTitle: z.string(),
    processName: z.string(),
    capturedAt: z.number().int(),
    treeVersion: z.string().uuid(),
    truncated: z.boolean(),
    elements: z.array(desktopElementSchema)
  })
  .strict()
const actionDataSchema = z
  .object({ name: z.string(), role: z.string(), action: z.string() })
  .strict()

export function registerDesktopCapabilities(registry: CapabilityRegistry): void {
  const inspect: CapabilityDefinition<
    Record<string, never>,
    ActionResult<DesktopWindowSnapshot>
  > = {
    name: 'desktop.inspectActiveWindow',
    risk: 'automatic',
    timeoutMs: 20_000,
    execute: async (_parameters, signal) => inspectActiveDesktopWindow(signal)
  }
  registry.register(inspect, z.object({}).strict(), actionResultSchema(snapshotSchema))

  for (const action of ['invoke', 'toggle', 'select'] as const) {
    const definition: CapabilityDefinition<
      z.infer<typeof elementSchema>,
      ActionResult<z.infer<typeof actionDataSchema>>
    > = {
      name: `desktop.${action}`,
      risk: 'automatic',
      timeoutMs: 15_000,
      execute: async ({ elementRef }, signal) =>
        performDesktopElementAction(action, { elementRef }, signal)
    }
    registry.register(definition, elementSchema, actionResultSchema(actionDataSchema))
  }

  for (const action of ['invoke', 'toggle', 'select'] as const) {
    const consequential: CapabilityDefinition<
      z.infer<typeof elementSchema>,
      ActionResult<z.infer<typeof actionDataSchema>>
    > = {
      name: `desktop.${action}Consequential`,
      risk: 'confirmation-required',
      timeoutMs: 15_000,
      confirmationSummary: ({ elementRef }) => {
        const target = getDesktopElementDescription(elementRef)
        return target
          ? `This will ${action} "${target.name || target.role}" in the foreground application. Do you want to continue?`
          : `This will ${action} a consequential foreground control. Do you want to continue?`
      },
      execute: async ({ elementRef }, signal) =>
        performDesktopElementAction(action, { elementRef }, signal, { allowConsequential: true })
    }
    registry.register(consequential, elementSchema, actionResultSchema(actionDataSchema))
  }

  const setText: CapabilityDefinition<
    z.infer<typeof setTextSchema>,
    ActionResult<z.infer<typeof actionDataSchema>>
  > = {
    name: 'desktop.setText',
    risk: 'automatic',
    timeoutMs: 15_000,
    execute: async ({ elementRef, text }, signal) =>
      performDesktopElementAction('setText', { elementRef, text }, signal)
  }
  registry.register(setText, setTextSchema, actionResultSchema(actionDataSchema))

  const scroll: CapabilityDefinition<
    z.infer<typeof scrollSchema>,
    ActionResult<z.infer<typeof actionDataSchema>>
  > = {
    name: 'desktop.scroll',
    risk: 'automatic',
    timeoutMs: 15_000,
    execute: async ({ elementRef, direction, amount }, signal) =>
      performDesktopElementAction('scroll', { elementRef, direction, amount }, signal)
  }
  registry.register(scroll, scrollSchema, actionResultSchema(actionDataSchema))
}
