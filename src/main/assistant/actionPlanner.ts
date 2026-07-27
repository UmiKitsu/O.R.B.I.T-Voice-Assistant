import { z } from 'zod'
import type { ActionResult, AssistantProgress, ChatMessage } from '../../shared/types'
import type { CapabilityRegistry } from '../capabilities/capabilityRegistry'
import { structuredChat } from '../services/ollamaService'
import { assistantOutputSchema, type AssistantOutput } from './actionPlanSchemas'

export const INVALID_ACTION_REQUEST_MESSAGE = 'I could not safely understand that action request.'

type CapabilityDescription = {
  name: string
  parameters: unknown
}

function compactJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactJsonSchema)
  if (typeof value !== 'object' || value === null) return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['\u0024schema', 'title', 'description', 'default'].includes(key))
      .map(([key, nested]) => [key, compactJsonSchema(nested)])
  )
}

export function describeRegisteredCapabilities(
  registry: CapabilityRegistry
): CapabilityDescription[] {
  return registry.list().map((capability) => ({
    name: capability.name,
    parameters: compactJsonSchema(z.toJSONSchema(capability.parameterSchema))
  }))
}

export function createPlanningSystemMessage(registry: CapabilityRegistry): ChatMessage {
  const capabilities = describeRegisteredCapabilities(registry)

  return {
    role: 'system',
    content: `You are Orbit, a local Windows voice assistant.

Use exactly one of these two output shapes and do not add other top-level keys:
{"kind":"conversation","response":"A clear, brief response"}
{"kind":"action_plan","summary":"What will be attempted","actions":[{"capability":"registered.name","parameters":{}}]}
An action plan must contain between 1 and 5 actions.

Return exactly one JSON object matching one of the shapes above.
Use kind "conversation" when no computer action is needed.
Use kind "action_plan" only when every requested action can be represented by the registered capabilities below.
Use only the listed capability names and match their parameter schemas exactly.
Never report an action as successful; the application executes plans and reports results.
Do not output shell commands, scripts, code, registry commands, executable paths, or unlisted capabilities.
Keep conversational responses clear and reasonably brief.

Registered capabilities:
${JSON.stringify(capabilities)}`
  }
}

export function parseAndValidateAssistantOutput(
  content: string,
  registry: CapabilityRegistry
): AssistantOutput | null {
  let parsedJson: unknown

  try {
    parsedJson = JSON.parse(content)
  } catch {
    return null
  }

  const parsedOutput = assistantOutputSchema.safeParse(parsedJson)
  if (!parsedOutput.success) return null

  if (parsedOutput.data.kind === 'action_plan') {
    for (const action of parsedOutput.data.actions) {
      const capability = registry.get(action.capability)
      if (!capability || !capability.parameterSchema.safeParse(action.parameters).success) {
        return null
      }
    }
  }

  return parsedOutput.data
}

export async function planAssistantRequest(
  messages: ChatMessage[],
  registry: CapabilityRegistry,
  signal?: AbortSignal,
  onProgress?: (progress: AssistantProgress) => void
): Promise<ActionResult<AssistantOutput>> {
  const result = await structuredChat(
    [createPlanningSystemMessage(registry), ...messages],
    z.toJSONSchema(assistantOutputSchema),
    signal,
    onProgress
  )

  if (!result.ok) return result

  const output = parseAndValidateAssistantOutput(result.data?.response ?? '', registry)
  if (!output) {
    return {
      ok: false,
      code: 'INVALID_ACTION_PLAN',
      message: INVALID_ACTION_REQUEST_MESSAGE,
      recoverable: true
    }
  }

  return {
    ok: true,
    message: 'Orbit produced a valid response.',
    data: output
  }
}
