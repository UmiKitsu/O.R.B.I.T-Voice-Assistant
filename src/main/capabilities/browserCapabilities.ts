import { z } from 'zod'
import type { ActionResult } from '../../shared/types'
import {
  MAX_EXTERNAL_URL_LENGTH,
  openExternalUrl,
  validateExternalUrl,
  type ExternalUrlOpener
} from '../services/browserService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { emptyActionResultSchema } from './resultSchemas'

const urlParametersSchema = z
  .object({
    url: z
      .string()
      .trim()
      .min(1)
      .max(MAX_EXTERNAL_URL_LENGTH)
      .refine((value) => validateExternalUrl(value) !== null, 'The URL is not allowed.')
  })
  .strict()

const searchParametersSchema = z
  .object({
    query: z.string().trim().min(1).max(500)
  })
  .strict()

type UrlParameters = z.infer<typeof urlParametersSchema>
type SearchParameters = z.infer<typeof searchParametersSchema>

function browserCapability(
  name: string,
  buildUrl: (parameters: SearchParameters) => string,
  opener?: ExternalUrlOpener
): CapabilityDefinition<SearchParameters, ActionResult> {
  return {
    name,
    risk: 'automatic',
    timeoutMs: 10_000,
    execute: async (parameters, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      const result = await openExternalUrl(buildUrl(parameters), opener)
      if (result.ok) {
        return {
          ...result,
          message: name === 'browser.searchWeb' ? 'Searching the web.' : 'Searching YouTube.'
        }
      }
      return result
    }
  }
}

export function registerBrowserCapabilities(
  registry: CapabilityRegistry,
  opener?: ExternalUrlOpener
): void {
  const openUrl: CapabilityDefinition<UrlParameters, ActionResult> = {
    name: 'browser.openUrl',
    risk: 'automatic',
    timeoutMs: 10_000,
    execute: async ({ url }, signal) => {
      if (signal.aborted) throw new Error('The action was cancelled.')
      return openExternalUrl(url, opener)
    }
  }

  registry.register(openUrl, urlParametersSchema, emptyActionResultSchema)
  registry.register(
    browserCapability(
      'browser.searchWeb',
      ({ query }) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      opener
    ),
    searchParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    browserCapability(
      'browser.searchYouTube',
      ({ query }) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
      opener
    ),
    searchParametersSchema,
    emptyActionResultSchema
  )
}
