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
  /**
   * Derived at query time from the recipient's inbox cursor, never stored.
   * `wake_status` reports whether a transport accepted the wake-up; this
   * reports whether the recipient actually read the mail.  A recipient whose
   * row is gone has no cursor and reads as false.
   */
  read: boolean
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
      `SELECT s.agent_id      AS agent_id,
              s.wake_status   AS wake_status,
              s.skip_reason   AS skip_reason,
              s.retry_attempts AS retry_attempts,
              s.updated_at    AS updated_at,
              s.delivered_at  AS delivered_at,
              CASE WHEN a.last_processed_event_id >= m.event_id THEN 1 ELSE 0 END AS read_flag
         FROM message_delivery_status s
         JOIN messages m ON m.id = s.message_id
         LEFT JOIN agents a ON a.agent_id = s.agent_id
        WHERE s.message_id=?
        ORDER BY s.agent_id ASC`
    ).all(args.message_id) as Array<Omit<DeliveryStatusRow, 'read'> & { read_flag: number | null }>
    const statuses = rows.map(({ read_flag, ...rest }) => ({ ...rest, read: read_flag === 1 }))
    return { message_id: args.message_id, statuses }
  }
}
