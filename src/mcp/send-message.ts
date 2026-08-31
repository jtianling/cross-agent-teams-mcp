import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'
import type { AutoPokeSkipReason, FanoutDeps } from './auto-poke-fanout.js'
import { parseDeliveryRow, type DeliverySpec } from '../lib/delivery-spec.js'
import { runFanoutWithRetry } from './fanout-with-retry.js'
import { recordInitialDeliveryStatuses } from './delivery-status.js'
import { isMessageRead } from './message-read.js'
import { ACK_DEADLINE_MS } from './unread-watchdog.js'

export type { AutoPokeFn, AutoPokeSkipReason } from './auto-poke-fanout.js'

export type SendMessageDeps = FanoutDeps

export interface SendInput {
  from: string
  to_agent_id?: string
  to_agent_name?: string
  to_team?: string
  subject?: string
  body: string
  auto_poke?: boolean
  need_reply?: boolean
  /**
   * Seconds to wait for the recipient to read the message before returning.
   *
   * Undefined means no wait at all — the 10-second default belongs to the MCP
   * tool schema, not here.  Callers that are not agent-facing (the REST
   * fallback, tests) would otherwise pay a ten-second stall on every send to a
   * recipient that was never going to read, and the default exists to help
   * agents, not HTTP clients.
   */
  await_ack_s?: number
}

export type AckStatus = 'read' | 'not_yet'

export interface AckResult {
  status: AckStatus
  waited_ms: number
}

interface SuccessResult {
  message_id: string
  event_id: number
  recipients: string[]
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  retry_scheduled: boolean
  retry_delays_s?: number[]
  ack: AckResult
}

export type SendResult =
  | SuccessResult
  | { error: 'unknown_recipient' }
  | { error: 'ambiguous_recipient' }
  | { error: 'missing_recipient' }
  | { error: 'invalid_to_agent_name' }

interface RecipientPokeRow {
  agent_id: string
  tmux_pane_id: string | null
  delivery: DeliverySpec
}

interface RecipientLookupRow {
  agent_id: string
  team: string
  tmux_pane_id: string | null
  delivery_kind: string
  delivery_payload: string | null
}

export function parseToAgentName(
  raw: string,
  callerDevice: string
):
  | { ok: { name: string; device: string } }
  | { error: 'invalid_to_agent_name' } {
  const colon = raw.indexOf(':')
  if (colon < 0) {
    return { ok: { name: raw, device: callerDevice } }
  }
  const name = raw.slice(0, colon)
  const device = raw.slice(colon + 1)
  if (name.length === 0 || device.length === 0) {
    return { error: 'invalid_to_agent_name' }
  }
  return { ok: { name, device } }
}

export const ACK_POLL_INTERVAL_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll the read predicate until it holds or the window expires.
 *
 * Polling rather than a `get_inbox` callback keeps the read path and the send
 * path uncoupled: the predicate is one primary-key lookup against a synchronous
 * SQLite handle, so a full ten-second window costs at most forty of them.
 *
 * The loop can only return `not_yet` once `Date.now()` has passed the deadline,
 * so `waited_ms` never under-reports the requested window.
 */
async function waitForRead(
  db: Database.Database,
  messageId: string,
  agentId: string,
  seconds: number
): Promise<AckResult> {
  if (!Number.isFinite(seconds) || seconds <= 0) return { status: 'not_yet', waited_ms: 0 }
  const started = Date.now()
  const deadline = started + seconds * 1000
  for (;;) {
    if (isMessageRead(db, messageId, agentId)) {
      return { status: 'read', waited_ms: Date.now() - started }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { status: 'not_yet', waited_ms: Date.now() - started }
    await delay(Math.min(ACK_POLL_INTERVAL_MS, remaining))
  }
}

export class SendMessageService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox,
    private deps: SendMessageDeps = {}
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    const hasId = typeof input.to_agent_id === 'string' && input.to_agent_id.length > 0
    const hasName = typeof input.to_agent_name === 'string' && input.to_agent_name.length > 0
    if (!hasId && !hasName) return { error: 'missing_recipient' }
    if (hasId && hasName) return { error: 'ambiguous_recipient' }
    const fromRow = this.agents.findById(input.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const fromTeam = fromRow.team
    const toTeam = input.to_team ?? fromTeam

    let resolvedId: string
    if (hasId) {
      resolvedId = input.to_agent_id!
    } else {
      const parsed = parseToAgentName(input.to_agent_name!, fromRow.device)
      if ('error' in parsed) return parsed
      const hit = this.agents.findByIdentity({
        device: parsed.ok.device,
        team: toTeam,
        name: parsed.ok.name,
      })
      if (!hit) return { error: 'unknown_recipient' }
      resolvedId = hit.agent_id
    }

    const rcpt = this.db.prepare(
      `SELECT
         agent_id,
         team,
         tmux_pane_id,
         delivery_kind,
         delivery_payload
       FROM agents
       WHERE agent_id=?`
    )
      .get(resolvedId) as RecipientLookupRow | undefined
    if (!rcpt || rcpt.team !== toTeam) return { error: 'unknown_recipient' }
    const recipientRow: RecipientPokeRow = {
      agent_id: rcpt.agent_id,
      tmux_pane_id: rcpt.tmux_pane_id,
      delivery: parseDeliveryRow(rcpt),
    }

    const baseResult = this.insert({ fromTeam, toTeam, from: input.from, toAgentId: rcpt.agent_id, input })

    const autoPokeEnabled = input.auto_poke !== false
    if (!autoPokeEnabled) {
      recordInitialDeliveryStatuses(this.db, {
        messageId: baseResult.message_id,
        recipients: [rcpt.agent_id],
        delivered: new Set(),
        skipped: [],
        autoPokeDisabled: true,
      })
      const ack = await waitForRead(
        this.db, baseResult.message_id, rcpt.agent_id, input.await_ack_s ?? 0
      )
      return { ...baseResult, poked: false, retry_scheduled: false, ack }
    }

    const envelope = await runFanoutWithRetry({
      db: this.db,
      team: toTeam,
      fromAgentId: input.from,
      recipients: [recipientRow],
      body: input.body,
      deps: this.deps,
      messageId: baseResult.message_id,
      sentAt: baseResult.sent_at
    })
    const ack = await waitForRead(
      this.db, baseResult.message_id, rcpt.agent_id, input.await_ack_s ?? 0
    )
    return {
      message_id: baseResult.message_id,
      event_id: baseResult.event_id,
      recipients: baseResult.recipients,
      ...envelope,
      ack
    }
  }

  private insert(args: {
    fromTeam: string; toTeam: string; from: string; toAgentId: string; input: SendInput
  }): { message_id: string; event_id: number; recipients: string[]; sent_at: string } {
    const tx = this.db.transaction(() => {
      const needReply = args.input.need_reply !== false ? 1 : 0
      const event_id = this.events.append({
        from_team: args.fromTeam, to_team: args.toTeam,
        event_type: 'message_sent', actor_agent_id: args.from,
        payload: {
          recipients: [args.toAgentId],
          subject: args.input.subject ?? null,
          need_reply: needReply === 1,
        }
      })
      const sentAtMs = Date.now()
      const sent_at = new Date(sentAtMs).toISOString()
      // Armed only for reply-expecting private sends, and independent of
      // auto_poke / await_ack_s: the watchdog reports on receipt, not dispatch.
      const ackDeadline = needReply === 1
        ? new Date(sentAtMs + ACK_DEADLINE_MS).toISOString()
        : null
      const id = randomUUID()
      this.db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, need_reply, sent_at, ack_deadline_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(id, event_id, args.fromTeam, args.toTeam, args.from,
        args.toAgentId,
        null, args.input.subject ?? null, args.input.body, needReply, sent_at, ackDeadline)
      return { message_id: id, event_id, sent_at }
    })
    const { message_id, event_id, sent_at } = tx()
    return { message_id, event_id, recipients: [args.toAgentId], sent_at }
  }
}
