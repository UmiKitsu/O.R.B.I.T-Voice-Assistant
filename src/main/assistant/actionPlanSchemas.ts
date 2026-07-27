import { z } from 'zod'

export const actionSchema = z
  .object({
    capability: z.string(),
    parameters: z.record(z.string(), z.unknown())
  })
  .strict()

export const assistantOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('conversation'),
      response: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal('action_plan'),
      summary: z.string(),
      actions: z.array(actionSchema).min(1).max(5)
    })
    .strict()
])

export type AssistantOutput = z.infer<typeof assistantOutputSchema>
export type ActionPlan = Extract<AssistantOutput, { kind: 'action_plan' }>
