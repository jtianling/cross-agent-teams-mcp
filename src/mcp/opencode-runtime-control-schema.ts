import { z } from 'zod'
import { canonicalOpencodeBaseUrl } from '../lib/opencode-url.js'

export const runtimeGenerationSchema = z.number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

const protocolVersionSchema = z.number().int()

const reserveFields = {
  identity_key: z.string().min(1).refine(
    value => value.trim().length > 0
  ),
  runtime_generation: runtimeGenerationSchema,
}

const commitFields = {
  base_url: z.string().url().refine(value => {
    try {
      canonicalOpencodeBaseUrl(value)
      return true
    } catch {
      return false
    }
  }, {
    message: 'base_url must be an http(s) URL without query, '
      + 'fragment, or userinfo',
  }),
  session_id: z.string().trim().min(1).refine(
    value => value.startsWith('ses'),
    { message: 'session_id must start with "ses"' }
  ),
}

export const reserveOpencodeRuntimeSchema = z.object({
  ...reserveFields,
  protocol_version: protocolVersionSchema.optional(),
}).strict()

export const commitOpencodeRuntimeSchema =
  reserveOpencodeRuntimeSchema.extend(commitFields)

export const reserveOpencodeRuntimeRestSchema = z.object({
  ...reserveFields,
  protocol_version: protocolVersionSchema,
}).strict()

export const commitOpencodeRuntimeRestSchema =
  reserveOpencodeRuntimeRestSchema.extend(commitFields)

export type ReserveOpencodeRuntimeRestInput = z.infer<
  typeof reserveOpencodeRuntimeRestSchema
>

export type CommitOpencodeRuntimeRestInput = z.infer<
  typeof commitOpencodeRuntimeRestSchema
>
