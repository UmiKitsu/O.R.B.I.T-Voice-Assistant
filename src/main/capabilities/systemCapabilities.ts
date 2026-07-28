import { arch, cpus, freemem, hostname, platform, release, totalmem } from 'node:os'
import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import { runFixedWindowsOperation } from '../services/windowsFixedOperationRunner'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema } from './resultSchemas'

const noParametersSchema = z.object({}).strict()

const timeDataSchema = z.object({ isoTime: z.iso.datetime() }).strict()
const dateDataSchema = z.object({ isoDate: z.iso.date() }).strict()
const systemInformationDataSchema = z
  .object({
    platform: z.string().max(50),
    release: z.string().max(100),
    architecture: z.string().max(50),
    hostname: z.string().max(255),
    cpuModel: z.string().max(300),
    logicalCpuCount: z.number().int().positive(),
    totalMemoryBytes: z.number().nonnegative(),
    freeMemoryBytes: z.number().nonnegative()
  })
  .strict()
const batteryDataSchema = z.discriminatedUnion('present', [
  z.object({ present: z.literal(false) }).strict(),
  z
    .object({
      present: z.literal(true),
      percent: z.number().int().min(0).max(100),
      charging: z.boolean()
    })
    .strict()
])
const networkDataSchema = z
  .object({
    online: z.boolean(),
    interfaces: z
      .array(
        z
          .object({
            name: z.string().max(200),
            status: z.string().max(100),
            linkSpeed: z.string().max(100)
          })
          .strict()
      )
      .max(20)
  })
  .strict()
const brightnessDataSchema = z.object({ percent: z.number().int().min(0).max(100) }).strict()
const acceptedDataSchema = z.object({ accepted: z.literal(true) }).strict()

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

  registry.register(
    {
      name: 'system.getInformation',
      risk: 'automatic',
      timeoutMs: 2_000,
      execute: async (_parameters, signal) => {
        if (signal.aborted) throw new Error('The action was cancelled.')
        const cpuList = cpus()
        const data = {
          platform: platform(),
          release: release(),
          architecture: arch(),
          hostname: hostname(),
          cpuModel: cpuList[0]?.model ?? 'Unknown CPU',
          logicalCpuCount: Math.max(1, cpuList.length),
          totalMemoryBytes: totalmem(),
          freeMemoryBytes: freemem()
        }
        return { ok: true as const, message: 'Read bounded system information.', data }
      }
    },
    noParametersSchema,
    actionResultSchema(systemInformationDataSchema)
  )

  registry.register(
    {
      name: 'system.getBattery',
      risk: 'automatic',
      timeoutMs: 15_000,
      execute: async (_parameters, signal) => {
        const result = await runFixedWindowsOperation(
          'system.getBattery',
          {},
          batteryDataSchema,
          signal,
          { timeoutMs: 12_000 }
        )
        if (!result.ok || !result.data) return result
        return {
          ok: true as const,
          message: result.data.present
            ? `Battery is at ${result.data.percent} percent${result.data.charging ? ' and charging' : ''}.`
            : 'No battery was detected.',
          data: result.data
        }
      }
    },
    noParametersSchema,
    actionResultSchema(batteryDataSchema)
  )

  registry.register(
    {
      name: 'system.getNetworkStatus',
      risk: 'automatic',
      timeoutMs: 15_000,
      execute: async (_parameters, signal) => {
        const result = await runFixedWindowsOperation(
          'system.getNetworkStatus',
          {},
          networkDataSchema,
          signal,
          { timeoutMs: 12_000 }
        )
        if (!result.ok || !result.data) return result
        return {
          ok: true as const,
          message: result.data.online ? 'At least one network adapter is online.' : 'No physical network adapter is online.',
          data: result.data
        }
      }
    },
    noParametersSchema,
    actionResultSchema(networkDataSchema)
  )

  const brightnessParameters = z.object({ percent: z.number().int().min(0).max(100) }).strict()
  registry.register(
    {
      name: 'display.setBrightness',
      risk: 'automatic',
      timeoutMs: 15_000,
      execute: async ({ percent }, signal) => {
        const result = await runFixedWindowsOperation(
          'display.setBrightness',
          { percent },
          brightnessDataSchema,
          signal,
          { timeoutMs: 12_000 }
        )
        if (!result.ok || !result.data) return result
        return {
          ok: true as const,
          message: `Set display brightness to ${result.data.percent} percent.`,
          data: result.data
        }
      }
    },
    brightnessParameters,
    actionResultSchema(brightnessDataSchema)
  )

  const powerCapabilities = [
    ['system.lock', 'Lock this Windows session now.', 'Windows accepted the lock request.'],
    ['system.signOut', 'Sign out of Windows now. Open applications may close.', 'Windows accepted the sign-out request.'],
    ['system.restart', 'Restart Windows now. Open applications may close.', 'Windows accepted the restart request.'],
    ['system.shutdown', 'Shut down Windows now. Open applications may close.', 'Windows accepted the shutdown request.']
  ] as const

  for (const [name, summary, successMessage] of powerCapabilities) {
    registry.register(
      {
        name,
        risk: 'confirmation-required',
        timeoutMs: 10_000,
        confirmationSummary: () => summary,
        execute: async (_parameters, signal) => {
          const result = await runFixedWindowsOperation(
            name,
            {},
            acceptedDataSchema,
            signal,
            { timeoutMs: 8_000 }
          )
          return result.ok ? { ...result, message: successMessage } : result
        }
      },
      noParametersSchema,
      actionResultSchema(acceptedDataSchema)
    )
  }
}
