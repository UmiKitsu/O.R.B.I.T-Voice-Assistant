import { createHash, randomUUID } from 'node:crypto'
import type { ActionAuthorization, VisualTargetPreview } from '../../shared/types'

export type PendingConfirmation = {
  requestId: string
  capability: string
  parameterFingerprint: string
  summary: string
  expiresAt: number
  authorization: ActionAuthorization
  pinConfigured: boolean
  visualTarget?: VisualTargetPreview
}

type CreateConfirmationRequest = {
  capability: string
  parameters: unknown
  summary: string
  timeoutMs: number
  authorization: ActionAuthorization
  pinConfigured: boolean
  visualTarget?: VisualTargetPreview
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`

  const object = value as Record<string, unknown>
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
  return `{${entries.join(',')}}`
}

export function fingerprintParameters(parameters: unknown): string {
  return createHash('sha256').update(canonicalize(parameters)).digest('hex')
}

export class ConfirmationManager {
  private readonly pending = new Map<string, PendingConfirmation>()
  private readonly approved = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  create(request: CreateConfirmationRequest): PendingConfirmation {
    this.removeExpired()
    const confirmation: PendingConfirmation = {
      requestId: randomUUID(),
      capability: request.capability,
      parameterFingerprint: fingerprintParameters(request.parameters),
      summary: request.summary,
      expiresAt: this.now() + request.timeoutMs,
      authorization: request.authorization,
      pinConfigured: request.pinConfigured,
      ...(request.visualTarget ? { visualTarget: request.visualTarget } : {})
    }
    this.pending.set(confirmation.requestId, confirmation)
    return confirmation
  }

  get(requestId: string): PendingConfirmation | undefined {
    this.removeExpired()
    return this.pending.get(requestId)
  }

  confirm(requestId: string, authorization?: ActionAuthorization): boolean {
    this.removeExpired()
    const pending = this.pending.get(requestId)
    if (!pending || (authorization !== undefined && pending.authorization !== authorization))
      return false
    this.approved.add(requestId)
    return true
  }

  cancel(requestId: string): boolean {
    this.approved.delete(requestId)
    return this.pending.delete(requestId)
  }

  consume(requestId: string, capability: string, parameters: unknown): boolean {
    this.removeExpired()
    const confirmation = this.pending.get(requestId)
    if (
      !confirmation ||
      !this.approved.has(requestId) ||
      confirmation.capability !== capability ||
      confirmation.parameterFingerprint !== fingerprintParameters(parameters)
    ) {
      return false
    }

    this.pending.delete(requestId)
    this.approved.delete(requestId)
    return true
  }

  private removeExpired(): void {
    const currentTime = this.now()
    for (const [requestId, confirmation] of this.pending) {
      if (confirmation.expiresAt <= currentTime) {
        this.pending.delete(requestId)
        this.approved.delete(requestId)
      }
    }
  }
}
