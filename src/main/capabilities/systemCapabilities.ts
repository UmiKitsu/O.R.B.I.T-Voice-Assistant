import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const noParametersSchema = z.object({}).strict()

const timeDataSchema = z.object({ isoTime: z.iso.datetime() }).strict()
const dateDataSchema = z.object({ isoDate: z.iso.date() }).strict()

type TimeData = z.infer<typeof timeDataSchema>
type DateData = z.infer<typeof dateDataSchema>

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function registerSystemCapabilities(
  registry: CapabilityRegistry,
  now: () => Date = () => new Date()
): void {
  const getTime: CapabilityDefinition<Record<string, never>, ActionResult<TimeData>> = {
    name: 'system.getTime',
    risk: 'automatic',
    timeoutMs: 1_000,
    execute: async (_parameters, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      const currentTime = now()
      const formattedTime = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      }).format(currentTime)

      return {
        ok: true,
        message: `It is ${formattedTime}.`,
        data: { isoTime: currentTime.toISOString() }
      }
    }
  }

  const getDate: CapabilityDefinition<Record<string, never>, ActionResult<DateData>> = {
    name: 'system.getDate',
    risk: 'automatic',
    timeoutMs: 1_000,
    execute: async (_parameters, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      const currentDate = now()
      const formattedDate = new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      }).format(currentDate)

      return {
        ok: true,
        message: `Today is ${formattedDate}.`,
        data: { isoDate: localIsoDate(currentDate) }
      }
    }
  }

  registry.register(getTime, noParametersSchema, actionResultSchema(timeDataSchema))
  registry.register(getDate, noParametersSchema, actionResultSchema(dateDataSchema))
}
