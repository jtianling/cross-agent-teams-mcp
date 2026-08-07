import type Database from 'better-sqlite3'
import { fanoutAutoPoke, type AutoPokeRecipient, type AutoPokeSkipReason, type FanoutDeps } from './auto-poke-fanout.js'
import { RETRY_DELAYS_S } from './poke-retry.js'
import { recordInitialDeliveryStatuses, updateDeliveryStatus } from './delivery-status.js'

export interface FanoutResultEnvelope {
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  retry_scheduled: boolean
  retry_delays_s?: number[]
}

// Shared fan-out + retry wiring used by both BroadcastService (all-team) and BroadcastToRoleService (same-team role-scoped).
// Same recipient-lookup SQL (agent_id-only, team-agnostic) keeps cross-team retry behaviour consistent.
export async function runFanoutWithRetry(args: {
  db: Database.Database
  team: string
  fromAgentId: string
  recipients: AutoPokeRecipient[]
  body: string
  deps: FanoutDeps
  messageId: string
  sentAt: string
}): Promise<FanoutResultEnvelope> {
  const { db } = args
  const fanout = await fanoutAutoPoke({
    team: args.team,
    fromAgentId: args.fromAgentId,
    recipients: args.recipients,
    body: args.body,
    deps: args.deps,
    retry: {
      messageId: args.messageId,
      sentAt: args.sentAt,
      // The cursor only advances past an event when get_inbox has returned
      // it, so cursor >= event_id means the recipient has seen this mail and
      // a pending wake-up retry would announce mail the inbox no longer has.
      alreadyReadFn: (agentId: string) => {
        const row = db.prepare(
          `SELECT m.event_id AS event_id, a.last_processed_event_id AS cursor
           FROM messages m, agents a
           WHERE m.id=? AND a.agent_id=?`
        ).get(args.messageId, agentId) as { event_id: number; cursor: number } | undefined
        return row !== undefined && row.cursor >= row.event_id
      },
      lookupAgentFn: (agentId: string) => db.prepare(
        'SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?'
      ).get(agentId) as { agent_id: string; tmux_pane_id: string | null; last_seen_at: string } | undefined,
      updateStatusFn: (status) => {
        updateDeliveryStatus(db, args.messageId, status.agentId, status)
      }
    }
  })
  recordInitialDeliveryStatuses(db, {
    messageId: args.messageId,
    recipients: args.recipients.map(r => r.agent_id),
    delivered: new Set(fanout.deliveredAgentIds),
    skipped: fanout.skipReasons
  })
  const retry_scheduled = fanout.retryScheduledCount > 0
  return {
    poked: fanout.poked,
    poke_skip_reasons: fanout.skipReasons,
    retry_scheduled,
    ...(retry_scheduled ? { retry_delays_s: [...RETRY_DELAYS_S] } : {})
  }
}
