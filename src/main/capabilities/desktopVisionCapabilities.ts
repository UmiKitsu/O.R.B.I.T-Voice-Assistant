import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import {
  getVisualTargetPreview,
  inspectForegroundVisually,
  performConfirmedVisualClick,
  type VisualInspection
} from '../services/desktopVisionService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const inspectSchema = z.object({ goal: z.string().trim().min(1).max(1_000) }).strict()
const visualRefSchema = z.object({ visualRef: z.string().uuid() }).strict()
const targetSchema = z
  .object({
    ref: z.string().uuid(),
    label: z.string().max(200),
    role: z.string().max(80),
    confidence: z.number().min(0).max(1)
  })
  .strict()
const inspectionResultSchema = z
  .object({
    windowTitle: z.string().max(300),
    processName: z.string().max(200),
    capturedAt: z.number().int(),
    summary: z.string().max(1_000),
    targets: z.array(targetSchema).max(20)
  })
  .strict()
const clickDataSchema = z
  .object({ label: z.string().max(200), application: z.string().max(300) })
  .strict()

export function registerDesktopVisionCapabilities(registry: CapabilityRegistry): void {
  const inspect: CapabilityDefinition<
    z.infer<typeof inspectSchema>,
    ActionResult<VisualInspection>
  > = {
    name: 'desktop.inspectVisually',
    risk: 'automatic',
    timeoutMs: 120_000,
    execute: async ({ goal }, signal) => inspectForegroundVisually(goal, signal)
  }
  registry.register(inspect, inspectSchema, actionResultSchema(inspectionResultSchema))

  const click: CapabilityDefinition<
    z.infer<typeof visualRefSchema>,
    ActionResult<z.infer<typeof clickDataSchema>>
  > = {
    name: 'desktop.visualClick',
    risk: 'confirmation-required',
    timeoutMs: 30_000,
    confirmationSummary: ({ visualRef }) => {
      const preview = getVisualTargetPreview(visualRef)
      return preview
        ? `This will click “${preview.label}” in ${preview.application} using visual coordinates. Do you want to continue?`
        : 'This will perform one coordinate-based visual click in the foreground window. Do you want to continue?'
    },
    confirmationVisualTarget: ({ visualRef }) => getVisualTargetPreview(visualRef),
    execute: async ({ visualRef }, signal) => performConfirmedVisualClick(visualRef, signal)
  }
  registry.register(click, visualRefSchema, actionResultSchema(clickDataSchema))
}
