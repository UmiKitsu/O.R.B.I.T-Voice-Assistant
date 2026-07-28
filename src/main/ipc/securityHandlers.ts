import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/ipcChannels'
import type { ActionResult, SecurityPinStatus } from '../../shared/types'
import {
  changeSecurityPin,
  createSecurityPin,
  getSecurityPinStatus
} from '../security/securityPinService'

const PIN_PATTERN = /^\d{4}$/

function parseCreateRequest(value: unknown): { pin: string; confirmation: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).length !== 2) return null
  return typeof candidate.pin === 'string' &&
    PIN_PATTERN.test(candidate.pin) &&
    typeof candidate.confirmation === 'string' &&
    PIN_PATTERN.test(candidate.confirmation)
    ? { pin: candidate.pin, confirmation: candidate.confirmation }
    : null
}

function parseChangeRequest(
  value: unknown
): { currentPin: string; nextPin: string; confirmation: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).length !== 3) return null
  return typeof candidate.currentPin === 'string' &&
    PIN_PATTERN.test(candidate.currentPin) &&
    typeof candidate.nextPin === 'string' &&
    PIN_PATTERN.test(candidate.nextPin) &&
    typeof candidate.confirmation === 'string' &&
    PIN_PATTERN.test(candidate.confirmation)
    ? {
        currentPin: candidate.currentPin,
        nextPin: candidate.nextPin,
        confirmation: candidate.confirmation
      }
    : null
}

export function registerSecurityHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.securityPinStatus, (): ActionResult<SecurityPinStatus> => ({
    ok: true,
    message: 'Security PIN status loaded.',
    data: getSecurityPinStatus()
  }))

  ipcMain.handle(
    IPC_CHANNELS.securityPinCreate,
    async (_event, request: unknown): Promise<ActionResult<SecurityPinStatus>> => {
      const parsed = parseCreateRequest(request)
      if (!parsed) {
        return {
          ok: false,
          code: 'INVALID_PIN_REQUEST',
          message: 'Enter and confirm exactly four digits.',
          recoverable: true
        }
      }

      try {
        return {
          ok: true,
          message: 'Security PIN created.',
          data: await createSecurityPin(parsed.pin, parsed.confirmation)
        }
      } catch (error: unknown) {
        return {
          ok: false,
          code: 'PIN_CREATE_FAILED',
          message: error instanceof Error ? error.message : 'Orbit could not create the security PIN.',
          recoverable: true
        }
      }
    }
  )

  ipcMain.handle(
    IPC_CHANNELS.securityPinChange,
    async (_event, request: unknown): Promise<ActionResult<SecurityPinStatus>> => {
      const parsed = parseChangeRequest(request)
      if (!parsed) {
        return {
          ok: false,
          code: 'INVALID_PIN_REQUEST',
          message: 'Enter the current PIN and confirm a new four-digit PIN.',
          recoverable: true
        }
      }

      try {
        return {
          ok: true,
          message: 'Security PIN changed.',
          data: await changeSecurityPin(
            parsed.currentPin,
            parsed.nextPin,
            parsed.confirmation
          )
        }
      } catch (error: unknown) {
        return {
          ok: false,
          code: 'PIN_CHANGE_FAILED',
          message: error instanceof Error ? error.message : 'Orbit could not change the security PIN.',
          recoverable: true
        }
      }
    }
  )
}
