import { z } from 'zod'
import { runFixedWindowsOperation } from '../services/windowsFixedOperationRunner'
import type { CapabilityRegistry } from './capabilityRegistry'
import { actionResultSchema } from './resultSchemas'

const processItemSchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string().trim().min(1).max(200),
    windowTitle: z.string().max(200)
  })
  .strict()
const processListDataSchema = z
  .object({ processes: z.array(processItemSchema).max(100), truncated: z.boolean() })
  .strict()
const stoppedProcessDataSchema = z
  .object({ pid: z.number().int().positive(), name: z.string().trim().min(1).max(200) })
  .strict()

export function registerProcessCapabilities(registry: CapabilityRegistry): void {
  const listParameters = z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict()
  registry.register(
    {
      name: 'process.listUser',
      risk: 'automatic',
      timeoutMs: 15_000,
      execute: async ({ limit }, signal) => {
        const result = await runFixedWindowsOperation(
          'process.listUser',
          { limit },
          processListDataSchema,
          signal,
          { timeoutMs: 12_000 }
        )
        if (!result.ok || !result.data) return result
        return {
          ok: true as const,
          message: `Found ${result.data.processes.length} ordinary user applications.`,
          data: result.data
        }
      }
    },
    listParameters,
    actionResultSchema(processListDataSchema)
  )

  const stopParameters = z.object({ pid: z.number().int().positive() }).strict()
  registry.register(
    {
      name: 'process.stopUser',
      risk: 'confirmation-required',
      timeoutMs: 15_000,
      confirmationSummary: ({ pid }) =>
        `Stop the ordinary current-user application with process ID ${pid}. Unsaved work may be lost.`,
      execute: async ({ pid }, signal) => {
        const result = await runFixedWindowsOperation(
          'process.stopUser',
          { pid, orbitPid: process.pid },
          stoppedProcessDataSchema,
          signal,
          { timeoutMs: 12_000 }
        )
        if (!result.ok || !result.data) return result
        return {
          ok: true as const,
          message: `Stopped ${result.data.name}.`,
          data: result.data
        }
      }
    },
    stopParameters,
    actionResultSchema(stoppedProcessDataSchema)
  )
}
