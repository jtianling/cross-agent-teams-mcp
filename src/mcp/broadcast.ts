import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type {
  AutoPokeRecipient,
  AutoPokeSkipReason,
  FanoutDeps,
} from './auto-poke-fanout.js'
import { runFanoutWithRetry } from './fanout-with-retry.js'
import { parseDeliveryRow } from '../lib/delivery-spec.js'
import { recordInitialDeliveryStatuses } from './delivery-status.js'
import { fanoutActiveCutoff } from './fanout-active-window.js'

export type BroadcastDeps = FanoutDeps

export interface BroadcastInput {
  from: string
  body: string
  subject?: string
  auto_poke?: boolean
}

interface SuccessResult {
  message_id: string
  event_id: number
  recipients: string[]
  skipped_inactive: number
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  retry_scheduled: boolean
  retry_delays_s?: number[]
}

export type BroadcastResult = SuccessResult
  | { error: 'unknown_recipient'; skipped_inactive?: number }

export class BroadcastService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private deps: BroadcastDeps = {}
  ) {}

  async broadcast(input: BroadcastInput): Promise<BroadcastResult> {
    const fromRow = this.agents.findById(input.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const { rows, skipped_inactive } = this.selectRecipients(fromRow.team, input.from)
    if (rows.length === 0) {
      return skipped_inactive > 0
        ? { error: 'unknown_recipient', skipped_inactive }
        : { error: 'unknown_recipient' }
    }
    const recipients = rows.map(r => r.agent_id)
    const baseId = randomUUID()
    const inserted = this.insertBroadcast(fromRow.team, input.from, recipients, input.body, input.subject, baseId)

    if (input.auto_poke === false) {
      recordInitialDeliveryStatuses(this.db, {
        messageId: inserted.message_id,
        recipients,
        delivered: new Set(),
        skipped: [],
        autoPokeDisabled: true,
      })
      return {
        ...inserted,
        recipients,
        skipped_inactive,
        poked: false,
        retry_scheduled: false,
      }
    }

    const envelope = await runFanoutWithRetry({
      db: this.db,
      team: fromRow.team,
      fromAgentId: input.from,
      recipients: rows,
      body: input.body,
      deps: this.deps,
      messageId: inserted.message_id,
      sentAt: inserted.sent_at
    })
    return {
      message_id: inserted.message_id,
      event_id: inserted.event_id,
      recipients,
      skipped_inactive,
      ...envelope
    }
  }

  // The 7-day window is the only liveness filter: online state, pane presence
  // and transport state are deliberately not consulted here.
  private selectRecipients(team: string, from: string): {
    rows: AutoPokeRecipient[]
    skipped_inactive: number
  } {
    const cutoff = fanoutActiveCutoff()
    const members = `FROM agents WHERE team=? AND role != '__channel_proxy__' AND agent_id != ?`
    const rawRows = this.db.prepare(
      `SELECT agent_id, tmux_pane_id, delivery_kind, delivery_payload
       ${members} AND last_seen_at >= ?`
    ).all(team, from, cutoff) as Array<{
      agent_id: string
      tmux_pane_id: string | null
      delivery_kind: string
      delivery_payload: string | null
    }>
    const skipped = this.db.prepare(
      `SELECT COUNT(*) AS n ${members} AND last_seen_at < ?`
    ).get(team, from, cutoff) as { n: number }
    const rows = rawRows.map((row) => ({
      agent_id: row.agent_id,
      tmux_pane_id: row.tmux_pane_id,
      delivery: parseDeliveryRow(row),
    }))
    return { rows, skipped_inactive: skipped.n }
  }

  private insertBroadcast(team: string, from: string, recipients: string[], body: string,
                          subject: string | undefined, baseId: string): { message_id: string; event_id: number; sent_at: string } {
    const tx = this.db.transaction(() => {
      const event_id = Number(this.db.prepare(
        `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?,?)`
      ).run(team, team, 'message_sent', from,
        JSON.stringify({ to_role: '*broadcast*', recipients, subject: subject ?? null }),
        new Date().toISOString()).lastInsertRowid)
      const sent_at = new Date().toISOString()
      const insert = this.db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, need_reply, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      for (let i = 0; i < recipients.length; i++) {
        const id = i === 0 ? baseId : `${baseId}-${i}`
        insert.run(id, event_id, team, team, from, recipients[i], '*broadcast*', subject ?? null, body, 0, sent_at)
      }
      return { message_id: baseId, event_id, sent_at }
    })
    return tx()
  }
}
