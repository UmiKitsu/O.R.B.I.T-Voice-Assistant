import { randomUUID } from 'node:crypto'
import type { NativeImage } from 'electron'
import { z } from 'zod'
import type { ActionResult, VisualTargetPreview } from '../../shared/types'
import {
  captureForegroundWindow,
  type ForegroundWindowCapture
} from './foregroundWindowCaptureService'
import { structuredVisionChat } from './ollamaService'
import { getSettings } from './settingsService'
import {
  clearScreenAwarenessPhase,
  requireScreenAwareness,
  setScreenAwarenessPhase
} from './screenAwarenessService'
import { inspectActiveTarget, windowsController, type WindowController } from './windowInputService'

const VISUAL_REF_TTL_MS = 60_000
const MIN_TARGET_CONFIDENCE = 0.7
const MAX_TARGETS = 20
const SIGNATURE_EDGE = 16
const MAX_SIGNATURE_DIFFERENCE = 28

const normalizedBoundsSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1)
  })
  .strict()
  .refine((bounds) => bounds.x + bounds.width <= 1.001 && bounds.y + bounds.height <= 1.001)
const visionOutputSchema = z
  .object({
    summary: z.string().trim().min(1).max(1_000),
    targets: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(200),
            role: z.string().trim().min(1).max(80),
            confidence: z.number().min(0).max(1),
            bounds: normalizedBoundsSchema
          })
          .strict()
      )
      .max(MAX_TARGETS)
  })
  .strict()

type NormalizedBounds = z.infer<typeof normalizedBoundsSchema>
type VisualReference = {
  ref: string
  expiresAt: number
  windowHandle: number
  windowTitle: string
  processName: string
  label: string
  role: string
  confidence: number
  bounds: NormalizedBounds
  signature: number[]
  preview: VisualTargetPreview
}

export type VisualInspection = {
  windowTitle: string
  processName: string
  capturedAt: number
  summary: string
  targets: Array<{ ref: string; label: string; role: string; confidence: number }>
}

const references = new Map<string, VisualReference>()

function failure<T>(code: string, message: string): ActionResult<T> {
  return { ok: false, code, message, recoverable: true }
}

function cropForBounds(image: NativeImage, bounds: NormalizedBounds): NativeImage | null {
  const size = image.getSize()
  const x = Math.max(0, Math.min(size.width - 1, Math.floor(bounds.x * size.width)))
  const y = Math.max(0, Math.min(size.height - 1, Math.floor(bounds.y * size.height)))
  const width = Math.max(1, Math.min(size.width - x, Math.ceil(bounds.width * size.width)))
  const height = Math.max(1, Math.min(size.height - y, Math.ceil(bounds.height * size.height)))
  if (width <= 0 || height <= 0) return null
  return image.crop({ x, y, width, height })
}

function imageSignature(image: NativeImage, bounds: NormalizedBounds): number[] | null {
  const cropped = cropForBounds(image, bounds)
  if (!cropped || cropped.isEmpty()) return null
  const tiny = cropped.resize({ width: SIGNATURE_EDGE, height: SIGNATURE_EDGE, quality: 'good' })
  const bitmap = tiny.toBitmap()
  if (bitmap.length < SIGNATURE_EDGE * SIGNATURE_EDGE * 4) return null
  const signature: number[] = []
  for (let offset = 0; offset + 3 < bitmap.length; offset += 4) {
    signature.push(Math.round((bitmap[offset] + bitmap[offset + 1] + bitmap[offset + 2]) / 3))
  }
  return signature.slice(0, SIGNATURE_EDGE * SIGNATURE_EDGE)
}

function previewFor(
  capture: ForegroundWindowCapture,
  target: z.infer<typeof visionOutputSchema>['targets'][number]
): VisualTargetPreview | null {
  const cropped = cropForBounds(capture.image, target.bounds)
  if (!cropped || cropped.isEmpty()) return null
  const size = cropped.getSize()
  const scale = Math.min(1, 360 / Math.max(size.width, size.height))
  const previewImage =
    scale < 1
      ? cropped.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'good'
        })
      : cropped
  const png = previewImage.toPNG()
  if (png.length > 512 * 1024) return null
  return {
    application: capture.target.title || capture.target.processName,
    label: target.label,
    role: target.role,
    imageDataUrl: `data:image/png;base64,${png.toString('base64')}`
  }
}

function signaturesSimilar(left: readonly number[], right: readonly number[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false
  const meanDifference =
    left.reduce((sum, value, index) => sum + Math.abs(value - (right[index] ?? 255)), 0) /
    left.length
  return meanDifference <= MAX_SIGNATURE_DIFFERENCE
}

function removeExpiredReferences(): void {
  const now = Date.now()
  for (const [ref, value] of references) if (value.expiresAt <= now) references.delete(ref)
}

export function getVisualTargetPreview(ref: string): VisualTargetPreview | undefined {
  removeExpiredReferences()
  return references.get(ref)?.preview
}

export async function inspectForegroundVisually(
  goal: string,
  signal: AbortSignal
): Promise<ActionResult<VisualInspection>> {
  const enabled = requireScreenAwareness()
  if (!enabled.ok) return failure('SCREEN_AWARENESS_DISABLED', enabled.message)
  const settings = getSettings()
  setScreenAwarenessPhase('analyzing', 'Capturing and analyzing the foreground window locally.')
  let capture: ForegroundWindowCapture | undefined
  try {
    const captured = await captureForegroundWindow(signal)
    if (!captured.ok || !captured.data) return captured as ActionResult<VisualInspection>
    capture = captured.data
    const prompt = `User goal: ${goal.slice(0, 1_000)}\nDescribe the foreground window and identify only visible controls relevant to the goal. Return exactly {"summary":"...","targets":[{"label":"...","role":"button|link|textbox|tab|menu-item|control","confidence":0.0,"bounds":{"x":0.0,"y":0.0,"width":0.0,"height":0.0}}]}. Bounds are normalized to the supplied image. Return at most ${MAX_TARGETS} targets and no action, command, script, or instruction fields.`
    const response = await structuredVisionChat(
      prompt,
      capture.imageBase64,
      settings.visionModel,
      signal
    )
    if (!response.ok || !response.data) return response as ActionResult<VisualInspection>
    let parsed: unknown
    try {
      parsed = JSON.parse(response.data.response) as unknown
    } catch {
      return failure('VISION_INVALID_RESULT', 'The local vision model returned invalid JSON.')
    }
    const analysis = visionOutputSchema.safeParse(parsed)
    if (!analysis.success) {
      return failure(
        'VISION_INVALID_RESULT',
        'The local vision model returned data outside the safe schema.'
      )
    }

    references.clear()
    const targets: VisualInspection['targets'] = []
    for (const target of analysis.data.targets) {
      if (target.confidence < MIN_TARGET_CONFIDENCE) continue
      const signature = imageSignature(capture.image, target.bounds)
      const preview = previewFor(capture, target)
      if (!signature || !preview) continue
      const ref = randomUUID()
      references.set(ref, {
        ref,
        expiresAt: Date.now() + VISUAL_REF_TTL_MS,
        windowHandle: capture.target.windowHandle,
        windowTitle: capture.target.title,
        processName: capture.target.processName,
        label: target.label,
        role: target.role,
        confidence: target.confidence,
        bounds: target.bounds,
        signature,
        preview
      })
      targets.push({ ref, label: target.label, role: target.role, confidence: target.confidence })
    }
    return {
      ok: true,
      message: `Analyzed ${capture.target.title || capture.target.processName} locally.`,
      data: {
        windowTitle: capture.target.title.slice(0, 300),
        processName: capture.target.processName.slice(0, 200),
        capturedAt: capture.capturedAt,
        summary: analysis.data.summary,
        targets
      }
    }
  } finally {
    capture?.png.fill(0)
    clearScreenAwarenessPhase()
  }
}

export async function performConfirmedVisualClick(
  visualRef: string,
  signal: AbortSignal,
  controller: WindowController = windowsController
): Promise<ActionResult<{ label: string; application: string }>> {
  const enabled = requireScreenAwareness()
  if (!enabled.ok) return failure('SCREEN_AWARENESS_DISABLED', enabled.message)
  removeExpiredReferences()
  const reference = references.get(visualRef)
  if (!reference) {
    return failure(
      'VISUAL_TARGET_STALE',
      'That visual target expired. Orbit must inspect the window again.'
    )
  }
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
        : 'The foreground window changed before the visual click.'
    )
  }

  setScreenAwarenessPhase('inspecting', `Rechecking ${reference.label} before clicking.`)
  let capture: ForegroundWindowCapture | undefined
  try {
    const captured = await captureForegroundWindow(signal, controller)
    if (!captured.ok || !captured.data) {
      return captured as ActionResult<{ label: string; application: string }>
    }
    capture = captured.data
    const currentSignature = imageSignature(capture.image, reference.bounds)
    if (!currentSignature || !signaturesSimilar(reference.signature, currentSignature)) {
      return failure(
        'VISUAL_TARGET_CHANGED',
        'The visual target changed after confirmation. Orbit cancelled the click and must inspect again.'
      )
    }
    const bounds = controller.getWindowBounds(reference.windowHandle)
    if (!bounds)
      return failure('WINDOW_BOUNDS_UNAVAILABLE', 'The target window bounds are unavailable.')
    const x = Math.round(
      bounds.x + (reference.bounds.x + reference.bounds.width / 2) * bounds.width
    )
    const y = Math.round(
      bounds.y + (reference.bounds.y + reference.bounds.height / 2) * bounds.height
    )
    if (!controller.clickScreenPoint || !controller.clickScreenPoint(x, y)) {
      return failure('VISUAL_CLICK_FAILED', 'Windows rejected the confirmed visual click.')
    }
    return {
      ok: true,
      message: `Clicked “${reference.label}” in ${reference.windowTitle || reference.processName}.`,
      data: { label: reference.label, application: reference.windowTitle || reference.processName }
    }
  } finally {
    references.delete(visualRef)
    capture?.png.fill(0)
    clearScreenAwarenessPhase()
  }
}

export function resetDesktopVisionForTests(): void {
  references.clear()
}
