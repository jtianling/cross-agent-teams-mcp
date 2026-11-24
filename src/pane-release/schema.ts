import { z } from 'zod'
import { tmuxCoordinatesSchema } from '../pane-lookup/schema.js'

export const paneReleaseTargetSchema = z.object({
  tmux: tmuxCoordinatesSchema,
  identity_key: z.string().min(1)
    .refine(value => value.trim().length > 0).optional(),
  opencode_session_id: z.string().min(1).startsWith('ses').optional(),
  allow_dead_if_identity_unclaimed: z.literal(true).optional(),
}).strict().superRefine((target, context) => {
  if (target.allow_dead_if_identity_unclaimed
    && (target.identity_key === undefined || target.opencode_session_id !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Dead key absence requires an identity key and no OpenCode session' })
  }
})
export const paneReleaseSchema = z.object({
  protocol_version: z.literal(1),
  targets: z.array(paneReleaseTargetSchema).min(1).max(16),
}).strict().superRefine(({ targets }, context) => {
  const panes = targets.map(({ tmux }) => JSON.stringify(tmux))
  const keys = targets.flatMap(target =>
    target.identity_key === undefined ? [] : [target.identity_key])
  if (new Set(panes).size !== panes.length || new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom,
      message: 'Targets must have distinct panes and identity keys' })
  }
})
export type PaneReleaseInput = z.infer<typeof paneReleaseSchema>
export type PaneReleaseTarget = z.infer<typeof paneReleaseTargetSchema>

export function releaseFailure(error: string, detail: string,
  targetIndex: number | null = null, retryable = false,
) {
  return { ok: false as const, protocol_version: 1 as const,
    error, detail, target_index: targetIndex, retryable }
}
export type ReleaseFailure = ReturnType<typeof releaseFailure>
