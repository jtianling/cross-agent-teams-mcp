import type Database from 'better-sqlite3'
import type { AutoPokeFn } from './auto-poke-fanout.js'
import { updateDeliveryStatus } from './delivery-status.js'
import { scheduleKimiRetry } from './kimi-poke-retry.js'
import { isMessageRead } from './message-read.js'
import { RETRY_DELAYS_MS } from './poke-retry.js'

interface PendingWake {
  message_id: string
  agent_id: string
  retry_attempts: number
  updated_at: string
  from_agent_id: string
  to_team: string
}

export function restoreAgyRetries(db: Database.Database, poke: AutoPokeFn): void {
  const rows = db.prepare(`SELECT d.message_id, d.agent_id, d.retry_attempts,
    d.updated_at, m.from_agent_id, m.to_team FROM message_delivery_status d
    JOIN messages m ON m.id = d.message_id
    WHERE d.wake_status = 'retrying' AND d.skip_reason = 'agy_busy'`)
    .all() as PendingWake[]
  for (const row of rows) {
    const { agent_id, message_id, retry_attempts } = row
    const delay = RETRY_DELAYS_MS[retry_attempts]
    if (delay === undefined) {
      updateDeliveryStatus(db, message_id, agent_id, {
        wake_status: 'failed', skip_reason: 'retry_exhausted', retry_attempts,
      })
      continue
    }
    const due = Date.parse(row.updated_at) + delay
    scheduleKimiRetry({
      agentId: agent_id, messageId: message_id, busyReason: 'agy_busy',
      alreadyReadFn: () => isMessageRead(db, message_id, agent_id),
      attemptFn: async () => {
        const result = await poke({ fromAgentId: row.from_agent_id,
          targetAgentId: agent_id, team: row.to_team, paneId: null, body: '',
          expectedAgentType: 'antigravity' })
        return result.ok ? result : { ok: false, reason: result.reason ?? 'agy_unavailable' }
      },
      updateStatusFn: status => updateDeliveryStatus(db, message_id, agent_id, status),
    }, retry_attempts, Math.max(0, due - Date.now()))
  }
}
