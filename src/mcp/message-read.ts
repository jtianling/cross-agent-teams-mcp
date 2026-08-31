import type Database from 'better-sqlite3'

/**
 * The daemon's only evidence that a message reached its recipient.
 *
 * `get_inbox` advances `last_processed_event_id` inside the same transaction
 * that returns the rows, so the cursor is the single source of truth and this
 * predicate is derived, never stored — a second stored copy could only drift
 * from it.  It is also unfakeable in a way `wake_status` is not: a delivered
 * wake status means a transport accepted the wake-up, while this means the
 * recipient's agent loop actually ran and called a tool.
 *
 * A recipient whose row is gone reads as unread: there is no cursor left to
 * clear the bar, and treating a vanished agent as having read is exactly the
 * false positive this whole capability exists to remove.
 */
export function isMessageRead(
  db: Database.Database,
  messageId: string,
  agentId: string
): boolean {
  const row = db
    .prepare(
      `SELECT m.event_id AS event_id, a.last_processed_event_id AS cursor
         FROM messages m, agents a
        WHERE m.id = ? AND a.agent_id = ?`
    )
    .get(messageId, agentId) as { event_id: number; cursor: number } | undefined
  return row !== undefined && row.cursor >= row.event_id
}
