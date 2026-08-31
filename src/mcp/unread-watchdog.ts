import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { isMessageRead } from './message-read.js'
import { pokeAsDaemon, type PokeResult } from './poke.js'

export const ACK_DEADLINE_MS = 15 * 60 * 1000
export const ACK_DEADLINE_MINUTES = ACK_DEADLINE_MS / 60_000

/**
 * Rows examined per scan.  Each tmux-bound alert parks for the quiet guard, so
 * an unbounded batch can outlast the scan interval and let rounds overlap, each
 * spawning its own tmux probes.  Leftovers are not lost: they stay due and the
 * next tick takes them.
 *
 * Ordering is by `ack_deadline_at`, which a release does not change, so rows
 * being retried keep sorting ahead of newer ones.  A full batch of retrying
 * rows can therefore delay a fresh arrival by up to the retry window.  Bounded
 * and acceptable — the retrying set only shrinks — but it is head-of-line
 * blocking, not merely deferral.
 */
export const SCAN_BATCH_LIMIT = 20

/**
 * How long past the deadline a transient alert failure keeps being retried.
 *
 * Mirrors the span of the ordinary poke retry ladder (30s/180s/600s = 10 min),
 * so the alert gets roughly the same patience as the wake-up it is reporting
 * on.  The bound needs no attempt counter: the window plus the scan interval
 * decide how many tries happen, and `ack_deadline_at` is already stored.
 */
export const ALERT_RETRY_WINDOW_MS = 10 * 60 * 1000

/**
 * Failures worth another pass, mirroring what the poke retry scheduler treats
 * as deferrals rather than dead ends.
 *
 * `guard_failed` is the important one: the alert goes through the ordinary
 * quiet guard, so a sender that happens to be mid-turn when the watchdog fires
 * yields it, and that clears itself within seconds.  Giving up there would
 * drop the alert for the most ordinary reason imaginable — the recipient of
 * the alert was busy — which is the exact silent stall this capability exists
 * to remove.  `channel_sink_failed` joins it now that a throwing sink is
 * reported instead of swallowed.
 *
 * MEMBERSHIP RULE — read this before adding anything.  A retry re-sends the
 * whole alert text, so a reason may only join if it guarantees that NOTHING
 * reached the sender's pane.  All three members satisfy it: `guard_failed`
 * returns in `tmuxPokeImpl` before `capture_before` / `load_buffer` /
 * `paste_buffer` ever run, and the two server-side reasons never touch a pane
 * at all.
 *
 * Two neighbouring reasons look equally transient and MUST NOT be added:
 * `ownership_lost` (the text was pasted, only the Enter was withheld) and
 * `tmux_cmd_failed` raised at the `send_keys` / `capture_after` stages (the
 * throw came after the paste).  Retrying either puts a SECOND copy of the
 * alert in the sender's pane, and nothing would catch it — `alerted` still
 * counts 1 and every test stays green.  `pokeWroteContent` in poke.ts is the
 * predicate that decides this; `transient-set-writes-nothing` in
 * message-read-ack-watchdog.test.ts is the guard that fails if this rule is
 * broken.
 *
 * `kimi_pending_interaction` is deliberately absent for a different reason: it
 * waits on a human approval and cannot clear on a timer.
 */
export const TRANSIENT_ALERT_FAILURES: ReadonlySet<string> = new Set([
  'guard_failed',
  'kimi_session_busy',
  'channel_sink_failed',
])

/**
 * Poke failures that leave the alert text sitting in the target pane.  Kept
 * next to the set above so the two are read together; enforced by test.
 */
export const CONTENT_WRITING_POKE_FAILURES: readonly string[] = [
  'ownership_lost',
  'tmux_cmd_failed',
]

export interface UnreadWatchdogRunner {
  /** Runs one scan unless this runner is stopped or already scanning. */
  run: () => Promise<UnreadWatchdogResult>
  /** One-way gate: no further scan starts, and one in flight stops early. */
  stop: () => void
}

/**
 * Owns the scheduling state for one daemon.
 *
 * The gate is per-runner rather than module-level on purpose: a one-way
 * "stopped" latch shared by the whole process would be tripped by the first
 * server to shut down and would silently disable every server started
 * afterwards in that process — which is exactly the shape of a test run.
 * Serialising scans keeps overlapping rounds from multiplying concurrent tmux
 * probes, and the same flag doubles as the shutdown interlock so a tick fired
 * moments before `db.close()` cannot start new work.
 */
export function createUnreadWatchdogRunner(
  deps: UnreadWatchdogDeps
): UnreadWatchdogRunner {
  let inFlight = false
  let stopped = false
  return {
    stop: () => { stopped = true },
    run: async () => {
      if (stopped || inFlight) return { examined: 0, alerted: 0, retrying: 0 }
      inFlight = true
      try {
        return await runUnreadWatchdogScan({ ...deps, shouldStop: () => stopped })
      } finally {
        inFlight = false
      }
    },
  }
}

interface DueRow {
  id: string
  from_agent_id: string
  to_agent_id: string
  ack_deadline_at: string
  sender_exists: number
  recipient_name: string | null
  recipient_team: string | null
  subject: string | null
  skip_reason: string | null
}

export interface UnreadWatchdogDeps {
  db: Database.Database
  channelWakeFanout?: ChannelWakeFanout
  localDevice?: string
  now?: () => number
  /** Seam for tests; production routes through the shared poke dispatcher. */
  pokeFn?: (targetAgentId: string, prompt: string) => Promise<PokeResult>
  /** Checked between rows so a shutdown mid-scan abandons the remainder. */
  shouldStop?: () => boolean
  log?: (line: string) => void
}

export interface UnreadWatchdogResult {
  examined: number
  alerted: number
  /** Rows whose alert failed transiently and were left due for a later scan. */
  retrying: number
}

/**
 * The alert rides the same transport as a wake-up hint, so it has to be
 * unmistakably NOT one.  The existing hint reads `新邮件 from <sender> → ...,
 * 请调 get_inbox 查看`; an alert shaped like that would send the woken sender
 * to an inbox that holds nothing for it.
 *
 * `skip_reason` is the most actionable part: `pane_reassigned` / `no_pane`
 * means a human has to re-register the recipient, while no skip reason at all
 * means every poke landed and the recipient's own agent is stuck.  An absent
 * reason is stated explicitly rather than omitted, because a missing field
 * reads as "not looked up" instead of "looked up and there was none".
 *
 * The subject is carried even though the wake-up hint carries neither subject
 * nor body.  A sender with several messages outstanding to the same recipient
 * has no other way to tell which one stalled, so an alert without it is half an
 * alert.  Safety does not rest on the semantic argument that an author is only
 * shown its own words: the alert goes out through `pokeAsDaemon`, which keeps
 * the full pane-ownership recheck (`stillOwnsPane`, `verifyPaneHost`, and the
 * codex foreground-carrier proof), so a reassigned pane is refused by the same
 * mechanism that protects ordinary mail.  The body stays out: it is the bulk,
 * and the alert is a pointer, not a redelivery.
 */
export function buildUnreadAlert(args: {
  recipientName: string | null
  recipientTeam: string | null
  subject: string | null
  skipReason: string | null
}): string {
  const who = `${args.recipientName ?? '(未知)'}@${args.recipientTeam ?? '(未知)'}`
  const subject = args.subject === null || args.subject.length === 0
    ? '(无 subject)'
    : args.subject
  const reason = args.skipReason === null
    ? '无 skip reason (poke 派发全部成功)'
    : args.skipReason
  return [
    `xats 投递告警 (这不是新邮件, 无需调 get_inbox)`,
    `你发给 ${who} 的消息 (subject: ${subject}) 已 ${ACK_DEADLINE_MINUTES} 分钟未被读取.`,
    `最后投递状态: ${reason}.`,
    `对方可能已失联, 请自行决定是否接管后续工作.`,
  ].join('\n')
}

/**
 * Evaluate every message whose read deadline has passed and that the watchdog
 * has not yet examined.
 *
 * `ack_alerted_at` is written in BOTH outcomes: it marks "the watchdog is done
 * with this row", not "an alert was sent".  That keeps the due set shrinking
 * monotonically and lets the scan query stay a single indexed predicate.  The
 * conditional UPDATE makes the claim atomic, so overlapping scans cannot alert
 * twice for one message.
 *
 * The scan is driven by persisted state alone, so a deadline that came due
 * while the daemon was down is picked up by the next run rather than lost —
 * unlike the in-memory poke retry schedule, which evaporates on restart.
 */
export async function runUnreadWatchdogScan(
  deps: UnreadWatchdogDeps
): Promise<UnreadWatchdogResult> {
  const now = (deps.now ?? Date.now)()
  const nowIso = new Date(now).toISOString()
  const due = deps.db
    .prepare(
      `SELECT m.id            AS id,
              m.from_agent_id AS from_agent_id,
              m.to_agent_id   AS to_agent_id,
              m.subject       AS subject,
              m.ack_deadline_at AS ack_deadline_at,
              a.name          AS recipient_name,
              a.team          AS recipient_team,
              s.skip_reason   AS skip_reason,
              CASE WHEN f.agent_id IS NULL THEN 0 ELSE 1 END AS sender_exists
         FROM messages m
         LEFT JOIN agents a ON a.agent_id = m.to_agent_id
         LEFT JOIN agents f ON f.agent_id = m.from_agent_id
         LEFT JOIN message_delivery_status s
                ON s.message_id = m.id AND s.agent_id = m.to_agent_id
        WHERE m.ack_deadline_at IS NOT NULL
          AND m.ack_alerted_at IS NULL
          AND m.ack_deadline_at <= ?
          AND m.to_agent_id IS NOT NULL
        ORDER BY m.ack_deadline_at ASC
        LIMIT ?`
    )
    .all(nowIso, SCAN_BATCH_LIMIT) as DueRow[]

  // Hoisted: the fallback closure is identical for every row, and rebuilding it
  // inside the loop allocates one per due message for no reason.
  const poke = deps.pokeFn ?? ((targetAgentId: string, text: string) => pokeAsDaemon(
    {
      db: deps.db,
      channelWakeFanout: deps.channelWakeFanout,
      localDevice: deps.localDevice,
    },
    { target_agent_id: targetAgentId, prompt: text }
  ))

  let alerted = 0
  let retrying = 0
  for (const row of due) {
    if (deps.shouldStop?.()) break
    if (!claimRow(deps.db, row.id, nowIso)) continue
    if (isMessageRead(deps.db, row.id, row.to_agent_id)) continue
    // Checked here rather than left to the transport's unknown_target: the
    // "no alert for a vanished sender" rule is the watchdog's own, and routing
    // it through the poke layer would make it depend on that layer's errors.
    if (row.sender_exists === 0) continue
    const prompt = buildUnreadAlert({
      recipientName: row.recipient_name,
      recipientTeam: row.recipient_team,
      subject: row.subject,
      skipReason: row.skip_reason,
    })
    let failure: string | undefined
    try {
      const res = await poke(row.from_agent_id, prompt)
      if ('ok' in res && res.ok) {
        alerted += 1
        continue
      }
      failure = (res as { error?: string }).error ?? 'unknown'
    } catch {
      // A throw carries no classifiable reason, so it is treated as terminal
      // rather than retried blindly.
      deps.log?.(`unread-watchdog alert threw message=${row.id}`)
      continue
    }
    // Clock re-read here rather than reusing the scan-start value: each
    // tmux-bound alert parks on the quiet guard, so a long batch would
    // otherwise stretch the window past its stated bound for later rows.
    if (retryWindowOpen(row, (deps.now ?? Date.now)()) && TRANSIENT_ALERT_FAILURES.has(failure)) {
      // Release the claim so the next scan picks the row up again.  Claiming
      // across the poke is what makes concurrent scans unable to double-alert;
      // releasing afterwards is what keeps a momentary failure from being
      // mistaken for a verdict.
      releaseRow(deps.db, row.id, nowIso)
      retrying += 1
      deps.log?.(`unread-watchdog alert deferred message=${row.id} error=${failure}`)
      continue
    }
    deps.log?.(`unread-watchdog alert undelivered message=${row.id} error=${failure}`)
  }
  return { examined: due.length, alerted, retrying }
}

function retryWindowOpen(row: DueRow, now: number): boolean {
  const deadline = Date.parse(row.ack_deadline_at)
  return Number.isFinite(deadline) && now < deadline + ALERT_RETRY_WINDOW_MS
}

/**
 * Claim the row before doing anything observable.  A vanished sender still
 * consumes its claim: the alert is impossible, and leaving the row unclaimed
 * would re-examine it on every future scan forever.
 *
 * The claim is deliberately taken BEFORE the poke, which means a crash between
 * the two abandons that alert permanently — no later scan reconsiders a claimed
 * row.  That is the same best-effort bargain as a failed poke, and it is the
 * price of making double-alerting impossible without a second state column.
 */
function claimRow(db: Database.Database, messageId: string, nowIso: string): boolean {
  const res = db
    .prepare(`UPDATE messages SET ack_alerted_at=? WHERE id=? AND ack_alerted_at IS NULL`)
    .run(nowIso, messageId)
  return res.changes === 1
}

/**
 * Undo a claim so the row becomes due again on the next scan.
 *
 * Conditioned on the claim token this scan wrote, so the statement can only
 * ever release its OWN claim.  Today that is already guaranteed by the call
 * graph — no one reaches here without a successful `claimRow` — but proving it
 * requires tracing the caller, whereas the condition makes it locally evident.
 */
function releaseRow(db: Database.Database, messageId: string, claimToken: string): void {
  db.prepare(`UPDATE messages SET ack_alerted_at=NULL WHERE id=? AND ack_alerted_at=?`)
    .run(messageId, claimToken)
}
