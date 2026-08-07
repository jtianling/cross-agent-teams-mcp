import type Database from 'better-sqlite3'
import type { AutoPokeSkipReason } from './auto-poke-fanout.js'

export type WakeStatus = 'delivered' | 'retrying' | 'skipped' | 'failed'
export type DeliverySkipReason =
  | AutoPokeSkipReason
  | 'auto_poke_disabled'
  | 'recipient_active'
  | 'retry_exhausted'
  | 'already_read'

export interface DeliveryStatusRow {
  agent_id: string
  wake_status: WakeStatus
  skip_reason: DeliverySkipReason | null
  retry_attempts: number
  updated_at: string
  delivered_at: string | null
}

export function recordInitialDeliveryStatuses(
  db: Database.Database,
  args: {
    messageId: string
    recipients: string[]
    delivered: Set<string>
    skipped: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
    autoPokeDisabled?: boolean
  }
): void {
  const now = new Date().toISOString()
  const skipped = new Map(args.skipped.map(x => [x.agent_id, x.reason]))
  const stmt = db.prepare(
    `INSERT INTO message_delivery_status
       (message_id, agent_id, wake_status, skip_reason, retry_attempts, updated_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id, agent_id) DO UPDATE SET
       wake_status=excluded.wake_status,
       skip_reason=excluded.skip_reason,
       retry_attempts=excluded.retry_attempts,
       updated_at=excluded.updated_at,
       delivered_at=excluded.delivered_at`
  )
  const tx = db.transaction(() => {
    for (const agentId of args.recipients) {
      const reason = args.autoPokeDisabled ? 'auto_poke_disabled' : skipped.get(agentId)
      const delivered = args.delivered.has(agentId)
      const status: WakeStatus = delivered
        ? 'delivered'
        : reason === 'guard_failed' ? 'retrying' : 'skipped'
      stmt.run(
        args.messageId,
        agentId,
        status,
        delivered ? null : reason,
        0,
        now,
        delivered ? now : null
      )
    }
  })
  tx()
}

export function updateDeliveryStatus(
  db: Database.Database,
  messageId: string,
  agentId: string,
  args: {
    wake_status: WakeStatus
    skip_reason?: DeliverySkipReason | null
    retry_attempts?: number
    delivered_at?: string | null
  }
): void {
  const now = new Date().toISOString()
  db.prepare(
    `UPDATE message_delivery_status
     SET wake_status=?,
         skip_reason=?,
         retry_attempts=COALESCE(?, retry_attempts),
         updated_at=?,
         delivered_at=?
     WHERE message_id=? AND agent_id=?`
  ).run(
    args.wake_status,
    args.skip_reason ?? null,
    args.retry_attempts ?? null,
    now,
    args.delivered_at === undefined ? null : args.delivered_at,
    messageId,
    agentId
  )
}

export class GetDeliveryStatusService {
  constructor(private db: Database.Database) {}

  get(args: { caller: string; message_id: string }):
    | { message_id: string; statuses: DeliveryStatusRow[] }
    | { error: 'unknown_message' } {
    const owned = this.db.prepare(
      `SELECT 1 AS ok FROM messages WHERE id=? AND from_agent_id=? LIMIT 1`
    ).get(args.message_id, args.caller) as { ok: number } | undefined
    if (!owned) return { error: 'unknown_message' }

    const rows = this.db.prepare(
      `SELECT agent_id, wake_status, skip_reason, retry_attempts, updated_at, delivered_at
       FROM message_delivery_status
       WHERE message_id=?
       ORDER BY agent_id ASC`
    ).all(args.message_id) as DeliveryStatusRow[]
    return { message_id: args.message_id, statuses: rows }
  }
}
