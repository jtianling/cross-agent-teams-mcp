import { isAbsolute } from 'node:path'
import { z } from 'zod'

const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const tmuxCoordinatesSchema = z.object({
  socket_path: z.string().min(1).max(4096)
    .refine(value => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)),
  server_pid: positiveInteger,
  server_started_at: positiveInteger,
  pane_id: z.string().max(32).regex(/^%\d+$/),
}).strict()
export const paneLookupSchema = z.object({
  protocol_version: z.literal(1),
  tmux: tmuxCoordinatesSchema,
}).strict()
export type TmuxCoordinates = z.infer<typeof tmuxCoordinatesSchema>
export type PaneLookupInput = z.infer<typeof paneLookupSchema>
export type IdentityStatus =
  | 'verified' | 'unbound' | 'unverifiable' | 'ambiguous' | 'stale'
export type RuntimeStatus = 'ready' | 'not_ready' | 'unknown'
