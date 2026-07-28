import { z } from 'zod'
import type {
  ActionResult,
  BrowserPageSnapshot
} from '../../shared/types'
import {
  MAX_EXTERNAL_URL_LENGTH,
  openExternalUrl,
  validateExternalUrl,
  type ExternalUrlOpener
} from '../services/browserService'
import {
  executeBrowserCommand,
  getBrowserStatus
} from '../services/browserBridgeService'
import { getSettings } from '../services/settingsService'
import type { CapabilityRegistry } from './capabilityRegistry'
import type { CapabilityDefinition } from './capabilityTypes'
import { actionResultSchema, emptyActionResultSchema } from './resultSchemas'

const safeUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_EXTERNAL_URL_LENGTH)
  .refine((value) => validateExternalUrl(value) !== null, 'The URL is not allowed.')

const urlParametersSchema = z.object({ url: safeUrlSchema }).strict()
const searchParametersSchema = z
  .object({ query: z.string().trim().min(1).max(500) })
  .strict()
const optionalUrlParametersSchema = z.object({ url: safeUrlSchema.optional() }).strict()
const emptyParametersSchema = z.object({}).strict()
const switchTabParametersSchema = z
  .object({ query: z.string().trim().min(1).max(200) })
  .strict()
const scrollParametersSchema = z
  .object({
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(100).max(5_000)
  })
  .strict()
const elementReferenceSchema = z
  .string()
  .trim()
  .min(8)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+$/)
const clickParametersSchema = z.object({ elementRef: elementReferenceSchema }).strict()
const consequentialParametersSchema = z
  .object({
    elementRef: elementReferenceSchema,
    confirmationText: z.string().trim().min(1).max(600)
  })
  .strict()
const typeParametersSchema = z
  .object({ elementRef: elementReferenceSchema, text: z.string().max(4_000) })
  .strict()
const selectParametersSchema = z
  .object({ elementRef: elementReferenceSchema, value: z.string().trim().min(1).max(500) })
  .strict()

const pageSnapshotSchema = z
  .object({
    origin: z.string().url(),
    url: z.string().url(),
    title: z.string().max(500),
    visibleText: z.string().max(12_000),
    domVersion: z.number().int().nonnegative(),
    elements: z
      .array(
        z
          .object({
            ref: elementReferenceSchema,
            role: z.string().max(100),
            name: z.string().max(500),
            text: z.string().max(1_000).optional(),
            disabled: z.boolean().optional()
          })
          .strict()
      )
      .max(100)
  })
  .strict()

type SearchParameters = z.infer<typeof searchParametersSchema>

function shouldUseExtension(): boolean {
  return getSettings().browserControlEnabled && getBrowserStatus().connected
}

async function openThroughExtensionOrFallback(
  capability: 'browser.openUrl' | 'browser.searchWeb' | 'browser.searchYouTube',
  parameters: Record<string, unknown>,
  fallbackUrl: string,
  fallbackMessage: string,
  signal: AbortSignal,
  opener?: ExternalUrlOpener
): Promise<ActionResult> {
  if (signal.aborted) {
    return { ok: false, code: 'ACTION_CANCELLED', message: 'The request was cancelled.', recoverable: true }
  }
  if (shouldUseExtension()) {
    const result = await executeBrowserCommand(capability, parameters, signal, 15_000)
    if (result.ok) return { ok: true, message: fallbackMessage }
    if (result.code !== 'BROWSER_EXTENSION_DISCONNECTED') return result
  }
  const fallback = await openExternalUrl(fallbackUrl, opener)
  return fallback.ok ? { ...fallback, message: fallbackMessage } : fallback
}

function automaticExtensionCapability<TParameters>(
  name:
    | 'browser.newTab'
    | 'browser.closeTab'
    | 'browser.switchTab'
    | 'browser.goBack'
    | 'browser.goForward'
    | 'browser.reload'
    | 'browser.scroll',
  successMessage: string,
  timeoutMs = 10_000
): CapabilityDefinition<TParameters, ActionResult> {
  return {
    name,
    risk: 'automatic',
    timeoutMs,
    execute: async (parameters, signal) => {
      const result = await executeBrowserCommand(
        name,
        parameters as Record<string, unknown>,
        signal,
        timeoutMs
      )
      return result.ok ? { ok: true, message: successMessage } : result
    }
  }
}

function guardedBrowserCapability<TParameters, TData = undefined>(
  name:
    | 'browser.readVisiblePage'
    | 'browser.clickSafe'
    | 'browser.typeSafeText'
    | 'browser.selectOption'
    | 'browser.submitConsequential',
  risk: 'automatic' | 'confirmation-required',
  successMessage: string,
  confirmationSummary?: (parameters: TParameters) => string
): CapabilityDefinition<TParameters, ActionResult<TData>> {
  return {
    name,
    risk,
    timeoutMs: 15_000,
    confirmationSummary:
      risk === 'confirmation-required'
        ? confirmationSummary ??
          (() => 'Submit the consequential browser action shown in the controlled tab.')
        : undefined,
    execute: async (parameters, signal) => {
      if (!getSettings().generalBrowserAutomationEnabled) {
        return {
          ok: false,
          code: 'GENERAL_BROWSER_AUTOMATION_DISABLED',
          message: 'General browser automation is disabled in Orbit settings.',
          recoverable: true
        }
      }
      const result = await executeBrowserCommand<TData>(
        name,
        parameters as Record<string, unknown>,
        signal,
        15_000
      )
      return result.ok ? { ...result, message: successMessage } : result
    }
  }
}

export function registerBrowserCapabilities(
  registry: CapabilityRegistry,
  opener?: ExternalUrlOpener
): void {
  const openUrl: CapabilityDefinition<z.infer<typeof urlParametersSchema>, ActionResult> = {
    name: 'browser.openUrl',
    risk: 'automatic',
    timeoutMs: 15_000,
    execute: ({ url }, signal) =>
      openThroughExtensionOrFallback(
        'browser.openUrl',
        { url },
        url,
        'Opening the requested page.',
        signal,
        opener
      )
  }

  registry.register(openUrl, urlParametersSchema, emptyActionResultSchema)
  registry.register(
    {
      name: 'browser.searchWeb',
      risk: 'automatic',
      timeoutMs: 15_000,
      execute: ({ query }: SearchParameters, signal) =>
        openThroughExtensionOrFallback(
          'browser.searchWeb',
          { query },
          `https://www.google.com/search?q=${encodeURIComponent(query)}`,
          'Searching the web.',
          signal,
          opener
        )
    },
    searchParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    {
      name: 'browser.searchYouTube',
      risk: 'automatic',
      timeoutMs: 15_000,
      execute: ({ query }: SearchParameters, signal) =>
        openThroughExtensionOrFallback(
          'browser.searchYouTube',
          { query },
          `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
          'Searching YouTube.',
          signal,
          opener
        )
    },
    searchParametersSchema,
    emptyActionResultSchema
  )

  registry.register(
    automaticExtensionCapability<z.infer<typeof optionalUrlParametersSchema>>(
      'browser.newTab',
      'Opened a new controlled browser tab.'
    ),
    optionalUrlParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    automaticExtensionCapability<z.infer<typeof emptyParametersSchema>>(
      'browser.closeTab',
      'Closed the controlled browser tab.'
    ),
    emptyParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    automaticExtensionCapability<z.infer<typeof switchTabParametersSchema>>(
      'browser.switchTab',
      'Switched the controlled browser tab.'
    ),
    switchTabParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    automaticExtensionCapability<z.infer<typeof emptyParametersSchema>>(
      'browser.goBack',
      'Went back in the controlled browser tab.'
    ),
    emptyParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    automaticExtensionCapability<z.infer<typeof emptyParametersSchema>>(
      'browser.goForward',
      'Went forward in the controlled browser tab.'
    ),
    emptyParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    automaticExtensionCapability<z.infer<typeof emptyParametersSchema>>(
      'browser.reload',
      'Reloaded the controlled browser tab.'
    ),
    emptyParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    automaticExtensionCapability<z.infer<typeof scrollParametersSchema>>(
      'browser.scroll',
      'Scrolled the controlled browser tab.'
    ),
    scrollParametersSchema,
    emptyActionResultSchema
  )

  registry.register(
    guardedBrowserCapability<z.infer<typeof emptyParametersSchema>, BrowserPageSnapshot>(
      'browser.readVisiblePage',
      'automatic',
      'Read the visible page.'
    ),
    emptyParametersSchema,
    actionResultSchema(pageSnapshotSchema)
  )
  registry.register(
    guardedBrowserCapability<z.infer<typeof clickParametersSchema>>(
      'browser.clickSafe',
      'automatic',
      'Clicked the safe page control.'
    ),
    clickParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    guardedBrowserCapability<z.infer<typeof typeParametersSchema>>(
      'browser.typeSafeText',
      'automatic',
      'Entered text in the safe page field.'
    ),
    typeParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    guardedBrowserCapability<z.infer<typeof selectParametersSchema>>(
      'browser.selectOption',
      'automatic',
      'Selected the requested page option.'
    ),
    selectParametersSchema,
    emptyActionResultSchema
  )
  registry.register(
    guardedBrowserCapability<z.infer<typeof consequentialParametersSchema>>(
      'browser.submitConsequential',
      'confirmation-required',
      'Submitted the confirmed browser action.',
      ({ confirmationText }) => confirmationText
    ),
    consequentialParametersSchema,
    emptyActionResultSchema
  )
}
