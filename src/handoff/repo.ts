import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { HandoffState } from './schema.js'

export const HANDOFF_DDL = `CREATE TABLE IF NOT EXISTS runtime_handoffs (
  handoff_id TEXT PRIMARY KEY, device TEXT NOT NULL,
  identity_hash TEXT NOT NULL, request_id TEXT NOT NULL,
  agent_id TEXT NOT NULL, config_json TEXT NOT NULL,
  source_json TEXT NOT NULL, target_type TEXT NOT NULL,
  state TEXT NOT NULL, runtime_json TEXT, committed_generation INTEGER,
  source_launch_id TEXT,
  UNIQUE(device, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_handoff_pending
  ON runtime_handoffs(device, agent_id) WHERE state = 'prepared';
CREATE INDEX IF NOT EXISTS runtime_handoff_epoch
  ON runtime_handoffs(agent_id, committed_generation);`

export interface HandoffRow {
  handoff_id: string
  device: string
  identity_hash: string
  request_id: string
  agent_id: string
  config_json: string
  source_json: string
  target_type: string
  state: HandoffState
  runtime_json: string | null
  committed_generation: number | null
  source_launch_id: string | null
}

export interface SourceRow {
  agent_id: string
  device: string
  name: string
  team: string
  agent_type: string | null
  identity_key: string | null
  register_generation: number
  opencode_runtime_generation: number
  delivery_kind: string
  delivery_payload: string | null
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  runtime_tty: string | null
  runtime_verification_mode: string | null
  runtime_bound_at: string | null
  claude_ui_pid: number | null
}

const SOURCE_FIELDS = `agent_id, device, name, team, agent_type, identity_key,
  register_generation, opencode_runtime_generation, delivery_kind,
  delivery_payload, tmux_pane_id, runtime_ui_pid, runtime_tty,
  runtime_verification_mode, runtime_bound_at, claude_ui_pid`

export function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export class HandoffRepo {
  constructor(readonly db: Database.Database, readonly device: string) {}

  source(key: string): SourceRow | undefined {
    return this.db.prepare(`SELECT ${SOURCE_FIELDS} FROM agents
      WHERE device=? AND identity_key=? AND role!='__channel_proxy__'`)
      .get(this.device, key) as SourceRow | undefined
  }

  get(id: string): HandoffRow | undefined {
    return this.db.prepare(`SELECT * FROM runtime_handoffs
      WHERE device=? AND handoff_id=?`).get(this.device, id) as
      HandoffRow | undefined
  }

  request(id: string): HandoffRow | undefined {
    return this.db.prepare(`SELECT * FROM runtime_handoffs
      WHERE device=? AND request_id=?`).get(this.device, id) as
      HandoffRow | undefined
  }

  pending(agentId: string): HandoffRow | undefined {
    return this.db.prepare(`SELECT * FROM runtime_handoffs
      WHERE device=? AND agent_id=? AND state='prepared'`)
      .get(this.device, agentId) as HandoffRow | undefined
  }

  save(row: HandoffRow): void {
    this.db.prepare(`INSERT INTO runtime_handoffs VALUES
      (@handoff_id,@device,@identity_hash,@request_id,@agent_id,
       @config_json,@source_json,@target_type,@state,@runtime_json,
       @committed_generation,@source_launch_id)`).run(row)
  }

  state(id: string, state: HandoffState): void {
    this.db.prepare('UPDATE runtime_handoffs SET state=? WHERE handoff_id=?')
      .run(state, id)
  }
}
