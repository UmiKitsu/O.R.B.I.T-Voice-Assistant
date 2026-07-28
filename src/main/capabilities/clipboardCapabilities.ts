import { clipboard } from 'electron'
import { z } from 'zod'
import type { CapabilityRegistry } from './capabilityRegistry'
import { actionResultSchema } from './resultSchemas'

const MAX_CLIPBOARD_TEXT_LENGTH = 16_000
const noParametersSchema = z.object({}).strict()
const clipboardTextDataSchema = z.object({ text: z.string().max(MAX_CLIPBOARD_TEXT_LENGTH) }).strict()

export function registerClipboardCapabilities(registry: CapabilityRegistry): void {
  registry.register(
    {
      name: 'clipboard.readText',
      risk: 'automatic',
      timeoutMs: 2_000,
      execute: async (_parameters, signal) => {
        if (signal.aborted) throw new Error('The action was cancelled.')
        const text = clipboard.readText().slice(0, MAX_CLIPBOARD_TEXT_LENGTH)
        return {
          ok: true as const,
          message: text ? 'Read bounded text from the clipboard.' : 'The clipboard does not contain text.',
          data: { text }
        }
      }
    },
    noParametersSchema,
    actionResultSchema(clipboardTextDataSchema)
  )

  const writeParametersSchema = z.object({ text: z.string().max(MAX_CLIPBOARD_TEXT_LENGTH) }).strict()
  registry.register(
    {
      name: 'clipboard.writeText',
      risk: 'automatic',
      timeoutMs: 2_000,
      execute: async ({ text }, signal) => {
        if (signal.aborted) throw new Error('The action was cancelled.')
        clipboard.writeText(text)
        return {
          ok: true as const,
          message: 'Copied the requested text to the clipboard.',
          data: { text: '' }
        }
      }
    },
    writeParametersSchema,
    actionResultSchema(clipboardTextDataSchema)
  )
}
