import { z } from 'zod'
import type { CodexPanePreRegRepo } from './codex-pane-pre-register-repo.js'
import { describeRedactedError } from './log-redact.js'

export const preRegisterCodexPaneInputSchema = z
  .object({
    pane_id: z
      .string()
      .min(1)
      .refine(v => v.startsWith('%'), {
        message: 'pane_id must be a tmux pane id starting with "%"',
      }),
    xats_agent_id: z.string().min(1),
    identity_key: z.string().min(1).refine(v => v.trim().length > 0, {
      message: 'identity_key must not be empty',
    }).optional(),
    ttl_seconds: z.number().int().positive().optional(),
  })
  .strict()

export type PreRegisterCodexPaneInput = z.infer<typeof preRegisterCodexPaneInputSchema>

export type PreRegisterCodexPaneResult =
  | { ok: true; expires_at: string }
  | { error: 'invalid_arguments'; detail: string }

const DEFAULT_TTL_SECONDS = 120
const MIN_TTL_SECONDS = 1
const MAX_TTL_SECONDS = 600

function clampTtl(ttl: number | undefined): number {
  const raw = ttl ?? DEFAULT_TTL_SECONDS
  if (raw < MIN_TTL_SECONDS) return MIN_TTL_SECONDS
  if (raw > MAX_TTL_SECONDS) return MAX_TTL_SECONDS
  return raw
}

export interface AcceptedPreRegRow {
  pane_id: string
  xats_agent_id: string
  identity_key: string | null
  expires_at: string
}

export class PreRegisterCodexPaneService {
  constructor(
    private readonly repo: CodexPanePreRegRepo,
    private readonly now: () => Date = () => new Date(),
    private readonly onAccepted?: (row: AcceptedPreRegRow) => void,
    private readonly log?: (line: string) => void
  ) {}

  register(args: unknown): PreRegisterCodexPaneResult {
    const parsed = preRegisterCodexPaneInputSchema.safeParse(args)
    if (!parsed.success) {
      return {
        error: 'invalid_arguments',
        detail: parsed.error.issues
          .map(issue => {
            const path = issue.path.join('.')
            return path ? `${path}: ${issue.message}` : issue.message
          })
          .join('; '),
      }
    }

    const now = this.now()
    const ttl = clampTtl(parsed.data.ttl_seconds)
    const expires_at = new Date(now.getTime() + ttl * 1000).toISOString()
    this.repo.deleteExpired(now.toISOString())
    this.repo.upsert({
      pane_id: parsed.data.pane_id,
      xats_agent_id: parsed.data.xats_agent_id,
      identity_key: parsed.data.identity_key,
      expires_at,
    })
    // Recovery scheduling is a side channel: a hook failure must not turn an
    // accepted pre-registration into an error.
    try {
      this.onAccepted?.({
        pane_id: parsed.data.pane_id,
        xats_agent_id: parsed.data.xats_agent_id,
        identity_key: parsed.data.identity_key ?? null,
        expires_at,
      })
    } catch (error) {
      // The hook resolves the identity key, so a thrown message may embed it;
      // log only the error class plus a key-redacted message.
      this.log?.(
        `pre-register hook error: pane=${parsed.data.pane_id} ` +
        `stage=onAccepted ` +
        `error=${describeRedactedError(error, parsed.data.identity_key)}`
      )
    }
    return { ok: true, expires_at }
  }
}
