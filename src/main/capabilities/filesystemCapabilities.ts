import { z } from 'zod'
import {
  copyFilePath,
  createDirectoryPath,
  movePath,
  renamePath,
  trashPath,
  validateAbsolutePath,
  writeTextFile,
  type TrashController
} from '../services/filesystemService'
import type { CapabilityRegistry } from './capabilityRegistry'
import { actionResultSchema } from './resultSchemas'

const absolutePathSchema = z
  .string()
  .trim()
  .min(3)
  .max(1_024)
  .refine((value) => validateAbsolutePath(value) !== null, 'A complete absolute path is required.')

const pathDataSchema = z.object({ path: z.string() }).strict()
const transferDataSchema = z.object({ source: z.string(), destination: z.string() }).strict()

export function registerFilesystemCapabilities(
  registry: CapabilityRegistry,
  trashController?: TrashController
): void {
  const deleteParameters = z.object({ path: absolutePathSchema }).strict()
  registry.register(
    {
      name: 'filesystem.delete',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ path }) => `Move ${path} to the Recycle Bin.`,
      execute: ({ path }) => trashPath(path, trashController)
    },
    deleteParameters,
    actionResultSchema(pathDataSchema)
  )

  const moveParameters = z
    .object({ source: absolutePathSchema, destination: absolutePathSchema })
    .strict()
  registry.register(
    {
      name: 'filesystem.move',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ source, destination }) => `Move ${source} to ${destination}.`,
      execute: ({ source, destination }) => movePath(source, destination)
    },
    moveParameters,
    actionResultSchema(transferDataSchema)
  )

  const renameParameters = z
    .object({ source: absolutePathSchema, newName: z.string().trim().min(1).max(255) })
    .strict()
  registry.register(
    {
      name: 'filesystem.rename',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ source, newName }) => `Rename ${source} to ${newName}.`,
      execute: ({ source, newName }) => renamePath(source, newName)
    },
    renameParameters,
    actionResultSchema(transferDataSchema)
  )

  const copyParameters = z
    .object({ source: absolutePathSchema, destination: absolutePathSchema })
    .strict()
  registry.register(
    {
      name: 'filesystem.copy',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ source, destination }) => `Copy ${source} to ${destination}.`,
      execute: ({ source, destination }) => copyFilePath(source, destination)
    },
    copyParameters,
    actionResultSchema(transferDataSchema)
  )

  const createDirectoryParameters = z.object({ path: absolutePathSchema }).strict()
  registry.register(
    {
      name: 'filesystem.createDirectory',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ path }) => `Create the folder ${path}.`,
      execute: ({ path }) => createDirectoryPath(path)
    },
    createDirectoryParameters,
    actionResultSchema(pathDataSchema)
  )

  const createFileParameters = z
    .object({ path: absolutePathSchema, content: z.string().max(100_000).default('') })
    .strict()
  registry.register(
    {
      name: 'filesystem.create',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ path }) => `Create the file ${path}.`,
      execute: ({ path, content }) => writeTextFile(path, content, false)
    },
    createFileParameters,
    actionResultSchema(pathDataSchema)
  )

  const writeFileParameters = z
    .object({ path: absolutePathSchema, content: z.string().max(100_000) })
    .strict()
  registry.register(
    {
      name: 'filesystem.write',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ path }) => `Overwrite the file ${path}.`,
      execute: ({ path, content }) => writeTextFile(path, content, true)
    },
    writeFileParameters,
    actionResultSchema(pathDataSchema)
  )
}
