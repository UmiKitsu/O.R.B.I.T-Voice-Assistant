import { z } from 'zod'

const capabilityNameSchema = z
  .string()
  .min(3)
  .max(100)
  .regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/)

export const actionSchema = z
  .object({
    capability: capabilityNameSchema,
    parameters: z.record(z.string(), z.unknown())
  })
  .strict()

export const assistantOutputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('conversation'),
      response: z.string().trim().min(1).max(8_000)
    })
    .strict(),
  z
    .object({
      kind: z.literal('action_plan'),
      summary: z.string().trim().min(1).max(500),
      actions: z.array(actionSchema).min(1).max(5)
    })
    .strict()
])

export type AssistantOutput = z.infer<typeof assistantOutputSchema>
export type ActionPlan = Extract<AssistantOutput, { kind: 'action_plan' }>
