import type Database from 'better-sqlite3'
import { CodexBindingRepo } from '../mcp/codex-binding-repo.js'
import { CodexPanePreRegRepo } from '../mcp/codex-pane-pre-register-repo.js'

export interface ReleaseAgent {
  agent_id: string
  device: string
  name: string
  team: string
  role: string
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
}
const FIELDS = `agent_id,device,name,team,role,agent_type,identity_key,
  register_generation,opencode_runtime_generation,delivery_kind,delivery_payload,
  tmux_pane_id,runtime_ui_pid,runtime_tty,runtime_verification_mode,runtime_bound_at`

export class ReleaseSnapshots {
  constructor(readonly db: Database.Database, readonly device: string) {}

  byKey(key: string, includeProxy = false): ReleaseAgent[] {
    return this.db.prepare(`SELECT ${FIELDS} FROM agents WHERE device=?
      AND identity_key=? ${includeProxy ? '' : "AND role!='__channel_proxy__'"}
      ORDER BY agent_id`)
      .all(this.device, key) as ReleaseAgent[]
  }

  byId(id: string, includeProxy = false): ReleaseAgent | undefined {
    return this.db.prepare(`SELECT ${FIELDS} FROM agents WHERE device=?
      AND agent_id=? ${includeProxy ? '' : "AND role!='__channel_proxy__'"}`)
      .get(this.device, id) as ReleaseAgent | undefined
  }

  pane(paneId: string, includeProxy = false): ReleaseAgent[] {
    return this.db.prepare(`SELECT ${FIELDS} FROM agents WHERE device=?
      AND tmux_pane_id=? ${includeProxy ? '' : "AND role!='__channel_proxy__'"}
      ORDER BY agent_id`)
      .all(this.device, paneId) as ReleaseAgent[]
  }

  native(): ReleaseAgent[] {
    return this.db.prepare(`SELECT ${FIELDS} FROM agents WHERE device=?
      AND role!='__channel_proxy__' ORDER BY agent_id`)
      .all(this.device) as ReleaseAgent[]
  }

  bindings(paneId: string) {
    return { codex: new CodexBindingRepo(this.db).read(paneId) ?? null,
      pending: new CodexPanePreRegRepo(this.db).getByPaneId(paneId) ?? null }
  }
}

export function identical(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
