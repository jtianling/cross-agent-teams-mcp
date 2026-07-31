import { z } from 'zod'
import type { CodexPanePreRegRepo } from './codex-pane-pre-register-repo.js'
import { describeRedactedError } from './log-redact.js'
import {
  argvContainsUuid,
  defaultForegroundProbeSync,
  defaultPaneTtySync,
  isCodexRemoteProcess,
} from './auto-bind-codex-pane.js'

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
  | { error: 'pane_claimed'; detail: string }

/**
 * Positive proof that the row's OWN launch still exists on that pane: a
 * `codex --remote` process on the pane's tty whose argv carries that row's
 * uuid.  Deliberately NOT the foreground-carrier proof — that one answers "is
 * it safe to paste here", which is a different question.  A codex suspended
 * with Ctrl-Z is still that launch, and its row has no reason to become
 * overwritable at that moment.
 */
export type CarrierAliveProbe = (paneId: string, uuid: string) => boolean

export function defaultCarrierAlive(paneId: string, uuid: string): boolean {
  try {
    const tty = defaultPaneTtySync(paneId)
    if (tty === undefined) return false
    return defaultForegroundProbeSync(tty).some(
      line => isCodexRemoteProcess(line) && argvContainsUuid(line, uuid)
    )
  } catch {
    // Probe failure is NOT treated as "still alive".  Everywhere else in this
    // codebase unknown liveness reads as protective, but the asymmetry flips
    // here: this guard's refusal blocks a LAUNCHER on the critical path just
    // before `exec codex`, so a transient tmux/ps hiccup would break agent
    // startup — a far likelier and more damaging outcome than the overwrite it
    // guards against.  Protection therefore requires positive proof.
    return false
  }
}

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
    private readonly log?: (line: string) => void,
    private readonly carrierAlive: CarrierAliveProbe = defaultCarrierAlive
  ) {}

  /**
   * A pending row's identity_key is that identity's ONLY handle for surviving
   * a restart, and this write path has never had any arbitration: measured,
   * a stranger overwriting another pane's row destroys the victim's key, makes
   * the victim fail to bind (the row now carries someone else's uuid), and
   * blocks the victim's own pane through pane_has_pending_prereg — while the
   * victim's register_agent still returns success.  It needs no malice: the
   * tool description says to call with $TMUX_PANE, and a `--remote` model
   * reads a value that points at somebody else's pane.
   *
   * The key on the row is the write credential, because the launcher has it
   * and a model provably cannot (its tools run in a shared app-server).  Not
   * "carries A key" — measured, a DIFFERENT key overwrites just as freely, and
   * keys do leak through that same app-server environment.
   *
   * Protection lasts only while the row's own launch is still there.  Without
   * that, a tmux server restart — which reissues pane ids from %0 while old
   * rows linger for their TTL — would refuse a whole batch of legitimate
   * relaunches for up to ten minutes, right after an incident, which is
   * exactly when agents most need to reach each other.
   */
  private refuseReason(
    paneId: string,
    incomingKey: string | undefined,
    nowIso: string
  ): string | undefined {
    const existing = this.repo.getByPaneId(paneId)
    if (existing === undefined) return undefined
    if (existing.identity_key === null) return undefined
    if (existing.expires_at <= nowIso) return undefined
    if (incomingKey !== undefined && incomingKey === existing.identity_key) {
      return undefined
    }
    if (!this.carrierAlive(paneId, existing.xats_agent_id)) return undefined
    return incomingKey === undefined ? 'no_key' : 'key_mismatch'
  }

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
    const nowIso = now.toISOString()
    const refused = this.refuseReason(
      parsed.data.pane_id, parsed.data.identity_key, nowIso
    )
    if (refused !== undefined) {
      this.log?.(
        `pre-register refused: pane=${parsed.data.pane_id} reason=${refused}`
      )
      return {
        error: 'pane_claimed',
        detail:
          `pane ${parsed.data.pane_id} still holds a live pre-registration for ` +
          'another identity; supply that identity_key to replace it',
      }
    }

    const ttl = clampTtl(parsed.data.ttl_seconds)
    const expires_at = new Date(now.getTime() + ttl * 1000).toISOString()
    this.repo.deleteExpired(nowIso)
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
