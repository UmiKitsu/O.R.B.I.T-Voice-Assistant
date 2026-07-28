import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ActionResult, DesktopElement, DesktopWindowSnapshot } from '../../shared/types'
import { inspectActiveTarget, windowsController, type WindowController } from './windowInputService'
import {
  runFixedWindowsOperation,
  type WindowsFixedOperationId
} from './windowsFixedOperationRunner'
import {
  clearScreenAwarenessPhase,
  requireScreenAwareness,
  setScreenAwarenessPhase
} from './screenAwarenessService'

const REF_TTL_MS = 60_000
const MAX_ELEMENTS = 120
const MAX_DEPTH = 10

const boundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().min(0),
    height: z.number().int().min(0)
  })
  .strict()
const patternSchema = z.enum(['invoke', 'toggle', 'select', 'value', 'scroll'])
const rawElementSchema = z
  .object({
    runtimeId: z.array(z.number().int()).min(1).max(32),
    role: z.string().max(80),
    name: z.string().max(300),
    enabled: z.boolean(),
    offscreen: z.boolean(),
    isPassword: z.boolean(),
    depth: z.number().int().min(0).max(12),
    bounds: boundsSchema,
    patterns: z.array(patternSchema).max(5)
  })
  .strict()
const treeSchema = z
  .object({
    windowHandle: z.number().int().positive(),
    elements: z.array(rawElementSchema).max(150),
    truncated: z.boolean()
  })
  .strict()
const actionDataSchema = z
  .object({ name: z.string().max(300), role: z.string().max(80), action: z.string().max(20) })
  .strict()

type RawElement = z.infer<typeof rawElementSchema>
type ElementReference = {
  ref: string
  expiresAt: number
  windowHandle: number
  windowTitle: string
  processName: string
  treeVersion: string
  element: RawElement
}

type OperationRunner = <TData>(
  operationId: WindowsFixedOperationId,
  parameters: unknown,
  schema: z.ZodType<TData>,
  signal: AbortSignal
) => Promise<ActionResult<TData>>

const references = new Map<string, ElementReference>()

function failure<T>(code: string, message: string): ActionResult<T> {
  return { ok: false, code, message, recoverable: true }
}

function removeExpiredReferences(now = Date.now()): void {
  for (const [ref, value] of references) if (value.expiresAt <= now) references.delete(ref)
}

function hasOnlyPlainText(text: string): boolean {
  return [...text].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint > 0x1f && codePoint !== 0x7f
  })
}

function isConsequentialName(name: string): boolean {
  return /\b(?:buy|checkout|purchase|pay|send|post|publish|submit|delete|remove|erase|save|export|install|uninstall|allow|accept|agree|enable|disable|turn on|turn off|reset|clear|format|connect|disconnect|join|leave|download|upload|sign out|restart|shut ?down|close)\b/iu.test(
    name
  )
}

function publicElement(reference: ElementReference): DesktopElement {
  const { element } = reference
  return {
    ref: reference.ref,
    role: element.role,
    name: element.name,
    enabled: element.enabled,
    offscreen: element.offscreen,
    bounds: element.bounds,
    patterns: element.patterns
  }
}

export function getDesktopElementDescription(ref: string): { name: string; role: string } | null {
  removeExpiredReferences()
  const reference = references.get(ref)
  return reference ? { name: reference.element.name, role: reference.element.role } : null
}

export async function inspectActiveDesktopWindow(
  signal: AbortSignal,
  controller: WindowController = windowsController,
  runner: OperationRunner = runFixedWindowsOperation
): Promise<ActionResult<DesktopWindowSnapshot>> {
  const enabled = requireScreenAwareness()
  if (!enabled.ok) return failure('SCREEN_AWARENESS_DISABLED', enabled.message)
  const inspection = inspectActiveTarget(controller)
  if (!inspection) return failure('NO_ACTIVE_TARGET', 'Orbit could not identify the active window.')
  if (inspection.decision.protected) {
    return failure('PROTECTED_TARGET', inspection.decision.message)
  }

  setScreenAwarenessPhase(
    'inspecting',
    `Inspecting ${inspection.target.title || inspection.target.processName}.`
  )
  try {
    const result = await runner(
      'desktop.inspectActiveWindow',
      {
        windowHandle: inspection.target.windowHandle,
        maxElements: MAX_ELEMENTS,
        maxDepth: MAX_DEPTH
      },
      treeSchema,
      signal
    )
    if (!result.ok || !result.data) return result as ActionResult<DesktopWindowSnapshot>

    const after = controller.getForegroundTarget()
    if (!after || after.windowHandle !== inspection.target.windowHandle) {
      return failure('DESKTOP_WINDOW_CHANGED', 'The foreground window changed during inspection.')
    }

    references.clear()
    const capturedAt = Date.now()
    const treeVersion = randomUUID()
    const elements = result.data.elements
      .filter((element) => !element.isPassword)
      .map((element) => {
        const ref = randomUUID()
        const reference: ElementReference = {
          ref,
          expiresAt: capturedAt + REF_TTL_MS,
          windowHandle: inspection.target.windowHandle,
          windowTitle: inspection.target.title,
          processName: inspection.target.processName,
          treeVersion,
          element
        }
        references.set(ref, reference)
        return publicElement(reference)
      })
    return {
      ok: true,
      message: `Inspected ${inspection.target.title || inspection.target.processName}.`,
      data: {
        windowTitle: inspection.target.title.slice(0, 300),
        processName: inspection.target.processName.slice(0, 200),
        capturedAt,
        treeVersion,
        truncated: result.data.truncated,
        elements
      }
    }
  } finally {
    clearScreenAwarenessPhase()
  }
}

export async function performDesktopElementAction(
  action: 'invoke' | 'toggle' | 'select' | 'setText' | 'scroll',
  parameters: {
    elementRef: string
    text?: string
    direction?: 'up' | 'down'
    amount?: 'small' | 'medium' | 'large'
  },
  signal: AbortSignal,
  options: {
    allowConsequential?: boolean
    controller?: WindowController
    runner?: OperationRunner
  } = {}
): Promise<ActionResult<{ name: string; role: string; action: string }>> {
  const enabled = requireScreenAwareness()
  if (!enabled.ok) return failure('SCREEN_AWARENESS_DISABLED', enabled.message)
  removeExpiredReferences()
  const reference = references.get(parameters.elementRef)
  if (!reference) {
    return failure(
      'DESKTOP_ELEMENT_STALE',
      'That control reference expired. Inspect the active window again.'
    )
  }
  const controller = options.controller ?? windowsController
  const current = inspectActiveTarget(controller)
  if (
    !current ||
    current.decision.protected ||
    current.target.windowHandle !== reference.windowHandle ||
    current.target.processName !== reference.processName ||
    current.target.title !== reference.windowTitle
  ) {
    return failure(
      current?.decision.protected ? 'PROTECTED_TARGET' : 'DESKTOP_WINDOW_CHANGED',
      current?.decision.protected
        ? current.decision.message
        : 'The foreground window changed. Orbit will not use a stale control reference.'
    )
  }
  if (!reference.element.enabled || reference.element.offscreen || reference.element.isPassword) {
    return failure(
      'DESKTOP_ELEMENT_UNAVAILABLE',
      'That control is not currently safe and available.'
    )
  }
  if (
    (action === 'invoke' || action === 'toggle' || action === 'select') &&
    (!reference.element.name || isConsequentialName(reference.element.name)) &&
    !options.allowConsequential
  ) {
    return failure(
      'DESKTOP_CONFIRMATION_REQUIRED',
      'That control may have a consequential effect. Use the confirmation-required desktop capability.'
    )
  }
  const requiredPattern = action === 'setText' ? 'value' : action
  if (!reference.element.patterns.includes(requiredPattern)) {
    return failure(
      'DESKTOP_PATTERN_UNAVAILABLE',
      `That control does not support ${requiredPattern}.`
    )
  }
  if (action === 'setText') {
    const text = parameters.text ?? ''
    if (!text || text.length > 4_000 || !hasOnlyPlainText(text)) {
      return failure('INVALID_SAFE_TEXT', 'The requested text is not safe plain text.')
    }
  }

  setScreenAwarenessPhase(
    'inspecting',
    `Using ${reference.element.name || reference.element.role}.`
  )
  try {
    const runner = options.runner ?? runFixedWindowsOperation
    return await runner(
      `desktop.${action}` as WindowsFixedOperationId,
      {
        windowHandle: reference.windowHandle,
        runtimeId: reference.element.runtimeId,
        ...(action === 'setText' ? { text: parameters.text } : {}),
        ...(action === 'scroll'
          ? { direction: parameters.direction ?? 'down', amount: parameters.amount ?? 'small' }
          : {})
      },
      actionDataSchema,
      signal
    )
  } finally {
    references.delete(reference.ref)
    clearScreenAwarenessPhase()
  }
}

export function resetDesktopAutomationForTests(): void {
  references.clear()
}
