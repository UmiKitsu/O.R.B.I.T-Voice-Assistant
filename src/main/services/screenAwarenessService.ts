import type { ScreenAwarenessPhase, ScreenAwarenessStatus } from '../../shared/types'
import { getExactModelHealth } from './ollamaService'
import { getSettings } from './settingsService'

export type ScreenAwarenessListener = (status: ScreenAwarenessStatus) => void

const listeners = new Set<ScreenAwarenessListener>()
let phaseOverride: { phase: ScreenAwarenessPhase; message: string } | undefined
let visionSnapshot: Pick<ScreenAwarenessStatus, 'visionReady' | 'visionWarm' | 'processor'> = {
  visionReady: false,
  visionWarm: false,
  processor: 'unknown'
}

function createStatus(): ScreenAwarenessStatus {
  const settings = getSettings()
  if (!settings.screenAwarenessEnabled) {
    return {
      enabled: false,
      phase: 'off',
      uiAutomationReady: process.platform === 'win32',
      visionReady: false,
      visionModel: settings.visionModel,
      visionWarm: false,
      message: 'Screen awareness is off.'
    }
  }

  const defaultPhase: ScreenAwarenessPhase = visionSnapshot.visionReady ? 'ready' : 'degraded'
  const defaultMessage = visionSnapshot.visionReady
    ? visionSnapshot.visionWarm
      ? 'The local vision fallback is loaded and ready for the active window.'
      : 'The local vision fallback is installed and idle. It will load only when needed.'
    : `Windows controls remain available. Install the vision fallback with: ollama pull ${settings.visionModel}`
  return {
    enabled: true,
    phase: phaseOverride?.phase ?? defaultPhase,
    uiAutomationReady: process.platform === 'win32',
    visionReady: visionSnapshot.visionReady,
    visionModel: settings.visionModel,
    visionWarm: visionSnapshot.visionWarm,
    ...(visionSnapshot.processor ? { processor: visionSnapshot.processor } : {}),
    message: phaseOverride?.message ?? defaultMessage
  }
}

function publish(): ScreenAwarenessStatus {
  const status = createStatus()
  for (const listener of listeners) {
    try {
      listener(status)
    } catch {
      // A closed renderer must not interrupt a local screen-awareness operation.
    }
  }
  return status
}

export function getScreenAwarenessStatus(): ScreenAwarenessStatus {
  return createStatus()
}

export function subscribeScreenAwarenessStatus(listener: ScreenAwarenessListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setScreenAwarenessPhase(
  phase: ScreenAwarenessPhase,
  message: string
): ScreenAwarenessStatus {
  phaseOverride = { phase, message: message.slice(0, 500) }
  return publish()
}

export function clearScreenAwarenessPhase(): ScreenAwarenessStatus {
  phaseOverride = undefined
  return publish()
}

export function requireScreenAwareness(): { ok: true } | { ok: false; message: string } {
  if (getSettings().screenAwarenessEnabled) return { ok: true }
  return {
    ok: false,
    message: 'Screen awareness is off. Enable it in Orbit before inspecting an application.'
  }
}

export async function refreshScreenAwarenessStatus(
  signal?: AbortSignal
): Promise<ScreenAwarenessStatus> {
  const settings = getSettings()
  phaseOverride = undefined
  if (!settings.screenAwarenessEnabled) {
    visionSnapshot = { visionReady: false, visionWarm: false, processor: 'unknown' }
    return publish()
  }

  const health = await getExactModelHealth(settings.visionModel, signal)
  visionSnapshot = {
    visionReady:
      health.connected && health.modelInstalled && health.activeModel === settings.visionModel,
    visionWarm: health.activeModel === settings.visionModel && health.warm,
    processor: health.processor ?? 'unknown'
  }
  phaseOverride = undefined
  return publish()
}

export function resetScreenAwarenessForTests(): void {
  phaseOverride = undefined
  visionSnapshot = { visionReady: false, visionWarm: false, processor: 'unknown' }
  listeners.clear()
}
