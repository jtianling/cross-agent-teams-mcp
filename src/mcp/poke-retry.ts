export const RETRY_DELAYS_MS = [30_000, 180_000, 600_000] as const
export const RETRY_DELAYS_S = [30, 180, 600] as const

export interface RetryPokeArgs {
  team: string
  fromAgentId: string
  targetAgentId: string
  paneId: string
  body: string
}

export interface RetryAgentLookup {
  agent_id: string
  tmux_pane_id: string | null
  last_seen_at: string
}

export interface RetryContext {
  agentId: string
  messageId: string
  fromAgentId: string
  body: string
  team: string
  sentAt: string
  paneId: string
  paneGuardFn: (paneId: string) => Promise<'pass' | 'fail'>
  // `void` keeps pre-existing callers valid and is read as "delivered".
  pokeFn: (args: RetryPokeArgs) => Promise<{ ok: true } | { ok: false; reason?: string } | void>
  lookupAgentFn: (agentId: string) => RetryAgentLookup | undefined
  /**
   * Read-receipt check run at the start of every tick: returns true when the
   * recipient's get_inbox cursor has already passed this message's event_id,
   * meaning the mail was read while the retry was pending and waking the
   * recipient now would only produce a phantom "new mail" notification.
   */
  alreadyReadFn?: () => boolean
  updateStatusFn?: (args: {
    agentId: string
    wake_status: 'delivered' | 'retrying' | 'skipped' | 'failed'
    skip_reason?: 'guard_failed' | 'no_pane' | 'recipient_active' | 'retry_exhausted' | 'already_read' | TerminalSkipReason | null
    retry_attempts?: number
    delivered_at?: string | null
  }) => void
}

interface RetryEntry {
  timer?: ReturnType<typeof setTimeout>
  attempt: number
  ctx: RetryContext
}

const retryMap = new Map<string, RetryEntry>()

type TerminalSkipReason = 'no_pane' | 'pane_reassigned' | 'tmux_unavailable'

/**
 * Failures that no amount of waiting reverses. Anything else — including an
 * unrecognised reason — keeps the normal backoff and ends at retry_exhausted,
 * so an unknown failure is never mistaken for a delivery.
 */
function terminalSkipReason(reason: string | undefined): TerminalSkipReason | undefined {
  return reason === 'pane_reassigned' || reason === 'no_pane' || reason === 'tmux_unavailable'
    ? reason
    : undefined
}

function keyOf(ctx: RetryContext): string {
  return `${ctx.messageId}:${ctx.agentId}`
}

// Retry tick resolves the recipient via ctx.lookupAgentFn (caller-provided), which is team-agnostic; cross-team retries are supported.
export function scheduleRetry(ctx: RetryContext): void {
  const key = keyOf(ctx)
  cancelRetry(key)
  retryMap.set(key, { attempt: 0, ctx })
  enqueueNext(key)
}

function enqueueNext(key: string): void {
  const entry = retryMap.get(key)
  if (!entry) return
  if (entry.attempt >= RETRY_DELAYS_MS.length) {
    retryMap.delete(key)
    return
  }
  const delay = RETRY_DELAYS_MS[entry.attempt]
  entry.timer = setTimeout(() => { void tick(key) }, delay)
}

// A tick may be superseded while suspended in an await: cancellation or a
// re-schedule can remove/replace its map entry. After every await the tick
// must re-verify it still owns the key before any mutation or status write;
// a failed identity check means a newer owner exists and the tick goes silent.
function superseded(key: string, entry: RetryEntry): boolean {
  return retryMap.get(key) !== entry
}

async function tick(key: string): Promise<void> {
  const entry = retryMap.get(key)
  if (!entry) return
  const { ctx } = entry
  try {
    // The recipient already read the mail while the retry was pending: a
    // wake-up now would announce mail its inbox no longer has.
    if (ctx.alreadyReadFn?.()) {
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: 'skipped',
        skip_reason: 'already_read',
        retry_attempts: entry.attempt,
      })
      retryMap.delete(key)
      return
    }
    const agent = ctx.lookupAgentFn(ctx.agentId)
    if (!agent || !agent.tmux_pane_id) {
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: 'failed',
        skip_reason: 'no_pane',
        retry_attempts: entry.attempt,
      })
      retryMap.delete(key)
      return
    }
    if (new Date(agent.last_seen_at).getTime() > new Date(ctx.sentAt).getTime()) {
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: 'skipped',
        skip_reason: 'recipient_active',
        retry_attempts: entry.attempt,
      })
      retryMap.delete(key)
      return
    }
    const guard = await ctx.paneGuardFn(agent.tmux_pane_id)
    if (superseded(key, entry)) return
    if (guard === 'pass') {
      const outcome = await ctx.pokeFn({
        team: ctx.team,
        fromAgentId: ctx.fromAgentId,
        targetAgentId: ctx.agentId,
        paneId: agent.tmux_pane_id,
        body: ctx.body
      })
      if (superseded(key, entry)) return
      // Only an explicit success — or a legacy `void` caller — means the pane
      // was written to. Every `ok:false` injected nothing and must never be
      // recorded as delivered, whatever the reason.
      const injected = !outcome || outcome.ok
      if (injected) {
        ctx.updateStatusFn?.({
          agentId: ctx.agentId,
          wake_status: 'delivered',
          skip_reason: null,
          retry_attempts: entry.attempt + 1,
          delivered_at: new Date().toISOString(),
        })
        retryMap.delete(key)
        return
      }
      // A host that changed, vanished, or has no tmux does not come back on a
      // timer, so those stop here like no_pane does. Everything else (including
      // guard_failed) falls through to the normal backoff below.
      const terminal = terminalSkipReason(outcome.reason)
      if (terminal !== undefined) {
        ctx.updateStatusFn?.({
          agentId: ctx.agentId,
          wake_status: 'skipped',
          skip_reason: terminal,
          retry_attempts: entry.attempt + 1,
        })
        retryMap.delete(key)
        return
      }
    }
    entry.attempt += 1
    if (entry.attempt >= RETRY_DELAYS_MS.length) {
      ctx.updateStatusFn?.({
        agentId: ctx.agentId,
        wake_status: 'failed',
        skip_reason: 'retry_exhausted',
        retry_attempts: entry.attempt,
      })
      retryMap.delete(key)
      return
    }
    ctx.updateStatusFn?.({
      agentId: ctx.agentId,
      wake_status: 'retrying',
      skip_reason: 'guard_failed',
      retry_attempts: entry.attempt,
    })
    enqueueNext(key)
  } catch {
    if (superseded(key, entry)) return
    ctx.updateStatusFn?.({
      agentId: ctx.agentId,
      wake_status: 'failed',
      skip_reason: 'retry_exhausted',
      retry_attempts: entry.attempt,
    })
    retryMap.delete(key)
  }
}

export function cancelRetry(key: string): void {
  const entry = retryMap.get(key)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  retryMap.delete(key)
}

export function clearAllRetries(): void {
  for (const [, v] of retryMap) if (v.timer) clearTimeout(v.timer)
  retryMap.clear()
}

export function __peekRetryMap(): Map<string, { attempt: number; ctx: RetryContext }> {
  const view = new Map<string, { attempt: number; ctx: RetryContext }>()
  for (const [k, v] of retryMap) view.set(k, { attempt: v.attempt, ctx: v.ctx })
  return view
}
