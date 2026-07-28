import { z } from 'zod'
import {
  appendTextFile,
  copyFilePath,
  createDirectoryPath,
  getFilesystemMetadata,
  listDirectoryBounded,
  movePath,
  navigateFolderReadOnly,
  openFileReadOnly,
  readTextFileBounded,
  renamePath,
  searchFilesystemBounded,
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
const readTextDataSchema = z
  .object({ path: z.string(), text: z.string().max(64_000), truncated: z.boolean() })
  .strict()
const directoryListDataSchema = z
  .object({
    path: z.string(),
    entries: z
      .array(
        z
          .object({
            name: z.string().max(255),
            type: z.enum(['file', 'directory', 'other']),
            size: z.number().nonnegative().optional()
          })
          .strict()
      )
      .max(100),
    truncated: z.boolean()
  })
  .strict()
const searchDataSchema = z
  .object({ root: z.string(), matches: z.array(z.string()).max(50), truncated: z.boolean() })
  .strict()
const metadataDataSchema = z
  .object({
    path: z.string(),
    type: z.enum(['file', 'directory', 'other']),
    size: z.number().nonnegative(),
    createdAt: z.iso.datetime(),
    modifiedAt: z.iso.datetime()
  })
  .strict()

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

  const appendParameters = z
    .object({ path: absolutePathSchema, content: z.string().max(100_000) })
    .strict()
  registry.register(
    {
      name: 'filesystem.append',
      risk: 'pin-required',
      timeoutMs: 30_000,
      confirmationSummary: ({ path }) => `Append text to ${path}.`,
      execute: ({ path, content }) => appendTextFile(path, content)
    },
    appendParameters,
    actionResultSchema(pathDataSchema)
  )

  const readParameters = z
    .object({ path: absolutePathSchema, maxBytes: z.number().int().min(1).max(64_000).default(32_000) })
    .strict()
  registry.register(
    {
      name: 'filesystem.readText',
      risk: 'automatic',
      timeoutMs: 10_000,
      execute: ({ path, maxBytes }) => readTextFileBounded(path, maxBytes)
    },
    readParameters,
    actionResultSchema(readTextDataSchema)
  )

  const listParameters = z
    .object({ path: absolutePathSchema, limit: z.number().int().min(1).max(100).default(50) })
    .strict()
  registry.register(
    {
      name: 'filesystem.listDirectory',
      risk: 'automatic',
      timeoutMs: 10_000,
      execute: ({ path, limit }) => listDirectoryBounded(path, limit)
    },
    listParameters,
    actionResultSchema(directoryListDataSchema)
  )

  const searchParameters = z
    .object({
      root: absolutePathSchema,
      query: z.string().trim().min(1).max(200),
      maxResults: z.number().int().min(1).max(50).default(25),
      maxDepth: z.number().int().min(0).max(8).default(5)
    })
    .strict()
  registry.register(
    {
      name: 'filesystem.search',
      risk: 'automatic',
      timeoutMs: 20_000,
      execute: ({ root, query, maxResults, maxDepth }) =>
        searchFilesystemBounded(root, query, maxResults, maxDepth)
    },
    searchParameters,
    actionResultSchema(searchDataSchema)
  )

  const metadataParameters = z.object({ path: absolutePathSchema }).strict()
  registry.register(
    {
      name: 'filesystem.getMetadata',
      risk: 'automatic',
      timeoutMs: 5_000,
      execute: ({ path }) => getFilesystemMetadata(path)
    },
    metadataParameters,
    actionResultSchema(metadataDataSchema)
  )

  registry.register(
    {
      name: 'file.openReadOnly',
      risk: 'automatic',
      timeoutMs: 10_000,
      execute: ({ path }) => openFileReadOnly(path)
    },
    metadataParameters,
    actionResultSchema(pathDataSchema)
  )

  registry.register(
    {
      name: 'folder.navigateReadOnly',
      risk: 'automatic',
      timeoutMs: 10_000,
      execute: ({ path }) => navigateFolderReadOnly(path)
    },
    metadataParameters,
    actionResultSchema(pathDataSchema)
  )
}
