import { desktopCapturer, type NativeImage } from 'electron'
import type { ActionResult } from '../../shared/types'
import type { ForegroundTarget } from '../security/protectedTargets'
import {
  inspectActiveTarget,
  windowsController,
  type WindowBounds,
  type WindowController
} from './windowInputService'

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const MAX_CAPTURE_EDGE = 1_600
const MIN_CAPTURE_EDGE = 640

export type ForegroundWindowCapture = {
  target: ForegroundTarget
  bounds: WindowBounds
  image: NativeImage
  png: Buffer
  imageBase64: string
  capturedAt: number
}

type CaptureSource = Awaited<ReturnType<typeof desktopCapturer.getSources>>[number]
type SourceProvider = () => Promise<CaptureSource[]>

function failure(code: string, message: string): ActionResult<ForegroundWindowCapture> {
  return { ok: false, code, message, recoverable: true }
}

export function sourceMatchesWindow(
  source: Pick<CaptureSource, 'id' | 'name'>,
  windowHandle: number,
  title: string
): boolean {
  const idParts = source.id.split(':')
  if (idParts[0] === 'window' && idParts[1] === String(windowHandle)) return true
  return Boolean(title && source.name.trim() === title.trim())
}

function resizeWithinLimit(image: NativeImage): { image: NativeImage; png: Buffer } | null {
  let candidate = image
  let edge = MAX_CAPTURE_EDGE
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const size = candidate.getSize()
    if (size.width <= 0 || size.height <= 0) return null
    const scale = Math.min(1, edge / Math.max(size.width, size.height))
    if (scale < 1) {
      candidate = candidate.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
        quality: 'good'
      })
    }
    const png = candidate.toPNG()
    if (png.length <= MAX_CAPTURE_BYTES) return { image: candidate, png }
    edge = Math.max(MIN_CAPTURE_EDGE, Math.floor(edge * 0.75))
  }
  return null
}

export async function captureForegroundWindow(
  signal: AbortSignal,
  controller: WindowController = windowsController,
  sourceProvider: SourceProvider = () =>
    desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: MAX_CAPTURE_EDGE, height: MAX_CAPTURE_EDGE },
      fetchWindowIcons: false
    })
): Promise<ActionResult<ForegroundWindowCapture>> {
  if (signal.aborted) return failure('ACTION_CANCELLED', 'The screen capture was cancelled.')
  const inspection = inspectActiveTarget(controller)
  if (!inspection) return failure('NO_ACTIVE_TARGET', 'Orbit could not identify the active window.')
  if (inspection.decision.protected) return failure('PROTECTED_TARGET', inspection.decision.message)
  const bounds = controller.getWindowBounds(inspection.target.windowHandle)
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    return failure(
      'WINDOW_BOUNDS_UNAVAILABLE',
      'Orbit could not read the foreground-window bounds.'
    )
  }

  const sources = await sourceProvider()
  if (signal.aborted) return failure('ACTION_CANCELLED', 'The screen capture was cancelled.')
  const exactId = sources.find((source) => {
    const parts = source.id.split(':')
    return parts[0] === 'window' && parts[1] === String(inspection.target.windowHandle)
  })
  const titleMatches = sources.filter(
    (source) => source.name.trim() === inspection.target.title.trim()
  )
  const source = exactId ?? (titleMatches.length === 1 ? titleMatches[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) {
    return failure(
      'WINDOW_CAPTURE_UNAVAILABLE',
      'Windows did not provide a safe image of the foreground window.'
    )
  }

  const after = controller.getForegroundTarget()
  if (!after || after.windowHandle !== inspection.target.windowHandle) {
    return failure('DESKTOP_WINDOW_CHANGED', 'The foreground window changed during capture.')
  }
  const resized = resizeWithinLimit(source.thumbnail)
  if (!resized) {
    return failure(
      'WINDOW_CAPTURE_TOO_LARGE',
      'The foreground-window image exceeded the safety limit.'
    )
  }
  return {
    ok: true,
    message: `Captured ${inspection.target.title || inspection.target.processName} in memory.`,
    data: {
      target: inspection.target,
      bounds,
      image: resized.image,
      png: resized.png,
      imageBase64: resized.png.toString('base64'),
      capturedAt: Date.now()
    }
  }
}
