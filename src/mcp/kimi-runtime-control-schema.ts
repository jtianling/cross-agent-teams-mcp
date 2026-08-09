import { z } from 'zod'

export const KIMI_RUNTIME_COMMIT_PROTOCOL_VERSION = 1

// kimi session ids are only required to be non-blank: registration never
// enforced a prefix, so this boundary must not either.
export const commitKimiRuntimeRestSchema = z.object({
  protocol_version: z.number().int(),
  identity_key: z.string().min(1).refine(
    value => value.trim().length > 0,
    { message: 'identity_key must not be blank' }
  ),
  base_url: z.string().url().refine(value => {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }, { message: 'base_url must be an http(s) URL' }),
  session_id: z.string().trim().min(1, {
    message: 'session_id must not be blank',
  }),
}).strict()

export type CommitKimiRuntimeRestInput = z.infer<
  typeof commitKimiRuntimeRestSchema
>
