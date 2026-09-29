import type Database from 'better-sqlite3'

export interface CodexBindingRow {
  pane_id: string
  launch_id: string
  expires_at: string
  agent_id: string | null
  thread_id: string | null
  runtime_ui_pid: number | null
  runtime_tty: string | null
}

export class CodexBindingRepo {
  constructor(private readonly db: Database.Database) {}

  begin(paneId: string, launchId: string, expiresAt: string): void {
    this.db.prepare(
      `INSERT INTO codex_pane_bindings (pane_id, launch_id, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(pane_id) DO UPDATE SET
         launch_id = excluded.launch_id, expires_at = excluded.expires_at,
         agent_id = NULL, thread_id = NULL,
         runtime_ui_pid = NULL, runtime_tty = NULL`
    ).run(paneId, launchId, expiresAt)
  }

  complete(args: {
    paneId: string
    launchId: string
    agentId: string
    runtimePid: number
    registerGeneration: number
  }): void {
    const result = this.db.prepare(
      `UPDATE codex_pane_bindings SET
         (agent_id, thread_id, runtime_ui_pid, runtime_tty) = (
           SELECT agent_id, json_extract(delivery_payload, '$.thread_id'),
                  runtime_ui_pid, runtime_tty FROM agents
           WHERE agent_id = @agentId
         )
       WHERE pane_id = @paneId AND launch_id = @launchId
         AND EXISTS (
           SELECT 1 FROM agents WHERE agent_id = @agentId
             AND register_generation = @registerGeneration
             AND tmux_pane_id = @paneId AND runtime_ui_pid = @runtimePid
             AND runtime_tty IS NOT NULL
             AND delivery_kind = 'codex-appserver'
             AND json_valid(delivery_payload)
             AND json_type(delivery_payload, '$.thread_id') = 'text'
             AND length(trim(json_extract(delivery_payload, '$.thread_id'))) > 0
         )`
    ).run(args)
    if (result.changes !== 1) throw new Error('Codex binding snapshot changed')
  }

  read(paneId: string): CodexBindingRow | undefined {
    return this.db.prepare(
      `SELECT pane_id, launch_id, expires_at, agent_id, thread_id,
              runtime_ui_pid, runtime_tty
       FROM codex_pane_bindings WHERE pane_id = ?`
    ).get(paneId) as CodexBindingRow | undefined
  }

  findByLaunchId(launchId: string): CodexBindingRow[] {
    return this.db.prepare(
      `SELECT pane_id, launch_id, expires_at, agent_id, thread_id,
              runtime_ui_pid, runtime_tty
       FROM codex_pane_bindings WHERE launch_id = ?`
    ).all(launchId) as CodexBindingRow[]
  }

  isAmbiguous(launchId: string): boolean {
    const row = this.db.prepare(
      `SELECT count(*) AS n FROM codex_pane_bindings WHERE launch_id = ?`
    ).get(launchId) as { n: number }
    return row.n > 1
  }

  matchesAgent(row: CodexBindingRow, localDevice: string): boolean {
    return this.db.prepare(
      `SELECT 1 FROM agents WHERE agent_id = ? AND device = ?
         AND tmux_pane_id = ? AND runtime_ui_pid = ? AND runtime_tty = ?
         AND delivery_kind = 'codex-appserver' AND json_valid(delivery_payload)
         AND json_extract(delivery_payload, '$.thread_id') = ?`
    ).get(
      row.agent_id, localDevice, row.pane_id, row.runtime_ui_pid,
      row.runtime_tty, row.thread_id
    ) !== undefined
  }
}
