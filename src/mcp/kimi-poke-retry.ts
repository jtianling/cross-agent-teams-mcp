import { RETRY_DELAYS_MS } from './poke-retry.js'

// The delay ladder is shared with the tmux path; only the scheduling loop is
// separate. poke-retry's loop requires a tmux pane id and abandons any agent
// whose tmux_pane_id is null, which is every kimi-code agent.
export const KIMI_RETRY_DELAYS_MS = RETRY_DELAYS_MS

export type KimiPokeAttemptResult =
  | { ok: true }
  | { ok: false; reason: string }

export interface KimiRetryContext {
  agentId: string
  messageId: string
  /** Re-runs the full precondition check and, if it passes, the injection. */
  attemptFn: () => Promise<KimiPokeAttemptResult>
  /**
   * Read-receipt check run at the start of every tick: returns true when the
   * recipient's get_inbox cursor has already passed this message's event_id.
   * A deferred wake-up whose mail was already read only produces a phantom
   * "new mail" notification against an empty inbox, so the gradient stops.
   */
  alreadyReadFn?: () => boolean
  updateStatusFn?: (args: {
    agentId: string
    wake_status: 'delivered' | 'retrying' | 'skipped' | 'failed'
    skip_reason?: 'kimi_session_busy' | 'retry_exhausted' | 'already_read' | null
    retry_attempts?: number
    delivered_at?: string | null
  }) => void
}

interface KimiRetryEntry {
  timer?: ReturnType<typeof setTimeout>
  attempt: number
  ctx: KimiRetryContext
}

const retryMap = new Map<string, KimiRetryEntry>()

function keyOf(ctx: KimiRetryContext): string {
  return `${ctx.messageId}:${ctx.agentId}`
}

export function scheduleKimiRetry(ctx: KimiRetryContext): void {
  const key = keyOf(ctx)
  cancelKimiRetry(key)
  retryMap.set(key, { attempt: 0, ctx })
  enqueueNext(key)
}

function enqueueNext(key: string): void {
  const entry = retryMap.get(key)
  if (!entry) return
  if (entry.attempt >= KIMI_RETRY_DELAYS_MS.length) {
    retryMap.delete(key)
    return
  }
  const delay = KIMI_RETRY_DELAYS_MS[entry.attempt]
  entry.timer = setTimeout(() => { void tick(key) }, delay)
}

async function tick(key: string): Promise<void> {
  const entry = retryMap.get(key)
  if (!entry) return
  const { ctx } = entry
  try {
    // Read while the retry was pending: the wake-up would announce mail the
    // recipient's inbox no longer holds.
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
    const result = await ctx.attemptFn()
    if (result.ok) {
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
    // Only a busy session can clear on its own. Anything else — notably
    // kimi_pending_interaction, which waits on a human — cannot succeed on a
    // later attempt, so the gradient is abandoned rather than burned.
    if (result.reason !== 'kimi_session_busy') {
      retryMap.delete(key)
      return
    }
    entry.attempt += 1
    if (entry.attempt >= KIMI_RETRY_DELAYS_MS.length) {
      // Exhaustion does nothing further: no forced injection, no tmux
      // fallback. The mailbox row is durable and readable via get_inbox.
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
      skip_reason: 'kimi_session_busy',
      retry_attempts: entry.attempt,
    })
    enqueueNext(key)
  } catch {
    ctx.updateStatusFn?.({
      agentId: ctx.agentId,
      wake_status: 'failed',
      skip_reason: 'retry_exhausted',
      retry_attempts: entry.attempt,
    })
    retryMap.delete(key)
  }
}

export function cancelKimiRetry(key: string): void {
  const entry = retryMap.get(key)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  retryMap.delete(key)
}

export function clearAllKimiRetries(): void {
  for (const [, v] of retryMap) if (v.timer) clearTimeout(v.timer)
  retryMap.clear()
}

export function __peekKimiRetryMap(): Map<string, { attempt: number; ctx: KimiRetryContext }> {
  const view = new Map<string, { attempt: number; ctx: KimiRetryContext }>()
  for (const [k, v] of retryMap) view.set(k, { attempt: v.attempt, ctx: v.ctx })
  return view
}
