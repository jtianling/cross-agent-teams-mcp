import type Database from 'better-sqlite3'

export interface CodexPanePreRegRow {
  pane_id: string
  xats_agent_id: string
  expires_at: string
  identity_key: string | null
}

export interface UpsertInput {
  pane_id: string
  xats_agent_id: string
  expires_at: string
  identity_key?: string
}

export class CodexPanePreRegRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(input: UpsertInput): void {
    this.db
      .prepare(
        `INSERT INTO codex_pane_pre_registrations
           (pane_id, xats_agent_id, expires_at, identity_key)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(pane_id) DO UPDATE SET
           xats_agent_id = excluded.xats_agent_id,
           expires_at = excluded.expires_at,
           identity_key = excluded.identity_key`
      )
      .run(
        input.pane_id,
        input.xats_agent_id,
        input.expires_at,
        input.identity_key ?? null
      )
  }

  listUnexpired(now: string): CodexPanePreRegRow[] {
    return this.db
      .prepare(
        `SELECT pane_id, xats_agent_id, expires_at, identity_key
         FROM codex_pane_pre_registrations
         WHERE expires_at > ?`
      )
      .all(now) as CodexPanePreRegRow[]
  }

  getByPaneId(pane_id: string): CodexPanePreRegRow | undefined {
    return this.db
      .prepare(
        `SELECT pane_id, xats_agent_id, expires_at, identity_key
         FROM codex_pane_pre_registrations
         WHERE pane_id = ?`
      )
      .get(pane_id) as CodexPanePreRegRow | undefined
  }

  takeByPaneId(pane_id: string): CodexPanePreRegRow | undefined {
    const row = this.db
      .prepare(
        `DELETE FROM codex_pane_pre_registrations
         WHERE pane_id = ?
         RETURNING pane_id, xats_agent_id, expires_at, identity_key`
      )
      .get(pane_id) as CodexPanePreRegRow | undefined
    return row
  }

  /**
   * Conditional consume: deletes only when the stored row still equals the
   * full snapshot the caller matched on. An overwrite that landed in between
   * (new uuid/key/expiry) leaves the new row untouched and returns undefined.
   */
  takeMatching(row: CodexPanePreRegRow): CodexPanePreRegRow | undefined {
    return this.db
      .prepare(
        `DELETE FROM codex_pane_pre_registrations
         WHERE pane_id = ? AND xats_agent_id = ?
           AND identity_key IS ? AND expires_at = ?
         RETURNING pane_id, xats_agent_id, expires_at, identity_key`
      )
      .get(
        row.pane_id,
        row.xats_agent_id,
        row.identity_key,
        row.expires_at
      ) as CodexPanePreRegRow | undefined
  }

  deleteExpired(now: string): number {
    const res = this.db
      .prepare(`DELETE FROM codex_pane_pre_registrations WHERE expires_at <= ?`)
      .run(now)
    return res.changes
  }
}
