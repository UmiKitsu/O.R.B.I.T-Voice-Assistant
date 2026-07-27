import { z } from 'zod'
import type { ActionResult } from '../../shared/types'

export const actionFailureSchema = z
  .object({
    ok: z.literal(false),
    code: z.string().min(1),
    message: z.string().min(1),
    recoverable: z.boolean()
  })
  .strict()

export function actionResultSchema<TData extends z.ZodType>(
  dataSchema: TData
): z.ZodType<ActionResult<z.infer<TData>>> {
  return z.discriminatedUnion('ok', [
    z
      .object({
        ok: z.literal(true),
        message: z.string().min(1),
        data: dataSchema.optional()
      })
      .strict(),
    actionFailureSchema
  ])
}

export const emptyActionResultSchema = actionResultSchema(z.undefined())
