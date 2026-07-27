export const WAKE_ACKNOWLEDGEMENT_MS = 900
export const TRANSCRIPT_READY_HOLD_MS = 4_000

export function remainingWakeAcknowledgement(detectedAt: number, now: number): number {
  return Math.max(0, WAKE_ACKNOWLEDGEMENT_MS - Math.max(0, now - detectedAt))
}
