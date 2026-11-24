import { z } from 'zod'
import { runtimeSchema } from '../managed/schema.js'

export const handoffType = z.enum(['codex', 'claude-code', 'opencode'])
const label = z.string().trim().min(1).max(256)
const opaque = z.string().min(1).refine(value => value.trim().length > 0)
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const control = { protocol_version: z.literal(1), identity_key: opaque }
export const handoffFence = z.object({
  handoff_id: z.string().uuid(), register_generation: generation,
}).strict()
export const prepareHandoffSchema = z.object({
  ...control, request_id: z.string().uuid(), name: opaque, team: label,
  source_agent_type: handoffType, target_agent_type: handoffType,
  expected_source: z.object({
    pane_id: z.string().regex(/^%\d+$/).optional(),
    thread_id: z.string().uuid().optional(),
    launch_id: z.string().uuid().optional(),
  }).strict().optional(),
}).strict()
export const handoffControlSchema = z.object({
  ...control, fence: handoffFence,
}).strict()
export const handoffRuntimeSchema = z.union([
  runtimeSchema.options[0], runtimeSchema.options[2],
  z.object({ agent_type: z.literal('claude-code'),
    ui_pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    channel_session_id: label.optional(),
  }).strict(),
])
export const commitHandoffSchema = handoffControlSchema.extend({
  runtime: handoffRuntimeSchema,
})
export type PrepareHandoff = z.infer<typeof prepareHandoffSchema>
export type HandoffControl = z.infer<typeof handoffControlSchema>
export type CommitHandoff = z.infer<typeof commitHandoffSchema>
export type HandoffState = 'prepared' | 'committed' | 'aborted' | 'stale'

export function handoffFailure(error: string, detail: string, retryable = false) {
  return { ok: false as const, protocol_version: 1 as const,
    error, detail, retryable }
}
