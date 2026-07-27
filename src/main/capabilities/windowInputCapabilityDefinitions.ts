import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import {
  moveOrResizeWindow,
  performWindowAction,
  sendConfirmedMessage,
  typeSafeText,
  windowsController,
  type WindowBounds,
  type WindowController
} from '../services/windowInputService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema, emptyActionResultSchema } from './resultSchemas'

const applicationSchema = z.object({ application: z.string().trim().min(1).max(120) }).strict()
const coordinateSchema = z.number().int().min(-32_768).max(32_768)
const dimensionSchema = z.number().int().min(100).max(16_384)
const moveSchema = z
  .object({
    application: z.string().trim().min(1).max(120),
    x: coordinateSchema,
    y: coordinateSchema
  })
  .strict()
const resizeSchema = z
  .object({
    application: z.string().trim().min(1).max(120),
    width: dimensionSchema,
    height: dimensionSchema
  })
  .strict()
function hasOnlyPlainText(text: string): boolean {
  return [...text].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint > 0x1f && codePoint !== 0x7f
  })
}

const plainTextSchema = z.string().min(1).max(4_000).refine(hasOnlyPlainText, {
  message: 'Text must not contain control characters.'
})
const typeTextSchema = z.object({ text: plainTextSchema }).strict()
const sendMessageSchema = z
  .object({
    recipient: z.string().trim().min(1).max(200),
    text: plainTextSchema
  })
  .strict()
const applicationDataSchema = z.object({ application: z.string().min(1) }).strict()
const boundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
  .strict()

function registerWindowAction(
  registry: CapabilityRegistry,
  name: string,
  action: 'focus' | 'minimize' | 'maximize' | 'restore' | 'closeSafe',
  controller: WindowController
): void {
  const definition: CapabilityDefinition<
    z.infer<typeof applicationSchema>,
    ActionResult<{ application: string }>
  > = {
    name,
    risk: 'automatic',
    timeoutMs: 5_000,
    execute: async ({ application }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return performWindowAction(action, application, controller)
    }
  }
  registry.register(definition, applicationSchema, actionResultSchema(applicationDataSchema))
}

export function registerWindowInputCapabilities(
  registry: CapabilityRegistry,
  controller: WindowController = windowsController
): void {
  registerWindowAction(registry, 'application.focus', 'focus', controller)
  registerWindowAction(registry, 'application.minimize', 'minimize', controller)
  registerWindowAction(registry, 'application.maximize', 'maximize', controller)
  registerWindowAction(registry, 'application.restore', 'restore', controller)
  registerWindowAction(registry, 'application.closeSafe', 'closeSafe', controller)

  const move: CapabilityDefinition<z.infer<typeof moveSchema>, ActionResult<WindowBounds>> = {
    name: 'window.move',
    risk: 'automatic',
    timeoutMs: 5_000,
    execute: async ({ application, x, y }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return moveOrResizeWindow(application, { x, y }, controller)
    }
  }
  registry.register(move, moveSchema, actionResultSchema(boundsSchema))

  const resize: CapabilityDefinition<z.infer<typeof resizeSchema>, ActionResult<WindowBounds>> = {
    name: 'window.resize',
    risk: 'automatic',
    timeoutMs: 5_000,
    execute: async ({ application, width, height }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return moveOrResizeWindow(application, { width, height }, controller)
    }
  }
  registry.register(resize, resizeSchema, actionResultSchema(boundsSchema))

  const typeText: CapabilityDefinition<z.infer<typeof typeTextSchema>, ActionResult> = {
    name: 'keyboard.typeSafeText',
    risk: 'automatic',
    timeoutMs: 10_000,
    execute: async ({ text }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return typeSafeText(text, controller)
    }
  }
  registry.register(typeText, typeTextSchema, emptyActionResultSchema)

  const sendMessage: CapabilityDefinition<z.infer<typeof sendMessageSchema>, ActionResult> = {
    name: 'communication.sendMessage',
    risk: 'confirmation-required',
    timeoutMs: 10_000,
    confirmationSummary: ({ recipient, text }) =>
      `This will send “${text}” to ${recipient}. Do you want to continue?`,
    execute: async ({ recipient, text }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return sendConfirmedMessage(recipient, text, controller)
    }
  }
  registry.register(sendMessage, sendMessageSchema, emptyActionResultSchema)
}
