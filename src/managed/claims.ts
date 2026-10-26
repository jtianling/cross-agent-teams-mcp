import type Database from 'better-sqlite3'
import { createHash, createHmac, randomUUID } from 'node:crypto'
import type {
  ControlInput, Fence, ManagedAgentType, PrepareInput,
} from './schema.js'

export const MANAGED_CLAIMS_DDL = `CREATE TABLE IF NOT EXISTS managed_claims (
  claim_id TEXT PRIMARY KEY,
  device TEXT NOT NULL,
  name TEXT NOT NULL,
  team TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  previous_json TEXT,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','bound','released')),
  runtime_json TEXT,
  agent_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS managed_active_identity
  ON managed_claims(device, team, name) WHERE state != 'released';
CREATE UNIQUE INDEX IF NOT EXISTS managed_active_key
  ON managed_claims(device, identity_key) WHERE state != 'released';
CREATE TABLE IF NOT EXISTS managed_instances (
  device TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY(device, instance_id)
)`

export interface Claim extends Fence {
  device: string
  name: string
  team: string
  agent_type: ManagedAgentType
  identity_key: string
  previous_json: string | null
  token_hash: string
  state: 'prepared' | 'bound' | 'released'
  runtime_json: string | null
  agent_id: string | null
}

export type ManagedFailure = {
  ok: false
  error: string
  detail: string
}

export function failure(error: string, detail: string): ManagedFailure {
  return { ok: false, error, detail }
}

export function fenceOf(claim: Fence): Fence {
  return {
    claim_id: claim.claim_id,
    instance_id: claim.instance_id,
    generation: claim.generation,
  }
}

export function sameFence(a: Fence, b: Fence): boolean {
  return a.claim_id === b.claim_id && a.instance_id === b.instance_id
    && a.generation === b.generation
}

export function managedToken(claim: Claim): string {
  return createHmac('sha256', claim.identity_key)
    .update(JSON.stringify(fenceOf(claim))).digest('hex')
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class ManagedClaims {
  constructor(
    readonly db: Database.Database,
    readonly device: string,
  ) {}

  byId(id: string): Claim | undefined {
    return this.db.prepare(
      'SELECT * FROM managed_claims WHERE claim_id = ? AND device = ?'
    ).get(id, this.device) as Claim | undefined
  }

  byToken(token: string): Claim | undefined {
    return this.db.prepare(
      `SELECT * FROM managed_claims WHERE token_hash = ? AND device = ?
       AND state != 'released'`
    ).get(tokenHash(token), this.device) as Claim | undefined
  }

  check(input: ControlInput): Claim | ManagedFailure {
    const row = this.byId(input.fence.claim_id)
    if (!row) return failure('not_found', 'Managed claim does not exist')
    if (row.identity_key !== input.identity_key) {
      return failure('ownership_conflict', 'Identity key does not own claim')
    }
    if (!sameFence(row, input.fence)) {
      return failure('stale_fence', 'Instance or generation has changed')
    }
    return row
  }

  prepare(input: PrepareInput): Claim | ManagedFailure {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT * FROM managed_claims WHERE device = ? AND state != 'released'
         AND (identity_key = ? OR (team = ? AND name = ?))`
      ).all(this.device, input.identity_key, input.team, input.name) as Claim[]
      if (row.length > 1) {
        return failure('identity_conflict', 'Name and key have different owners')
      }
      if (row[0]) return this.advance(row[0], input)
      if (input.previous) {
        const prior = this.byId(input.previous.claim_id)
        if (!prior) return failure('stale_fence', 'Prior claim is missing')
        return this.advance(prior, input)
      }
      if (this.usedInstance(input.instance_id)) {
        return failure('stale_fence', 'Instance ID has already been used')
      }
      const existing = this.db.prepare(
        `SELECT agent_id FROM agents WHERE device = ?
         AND ((team = ? AND name = ?) OR identity_key = ?)`
      ).get(this.device, input.team, input.name, input.identity_key)
      if (existing) {
        return failure('identity_conflict', 'Identity is already registered')
      }
      return this.insert(input)
    }).immediate()
  }

  private insert(input: PrepareInput): Claim {
    const row: Claim = {
      claim_id: randomUUID(), device: this.device,
      name: input.name, team: input.team, agent_type: input.agent_type,
      identity_key: input.identity_key, instance_id: input.instance_id,
      generation: 1, previous_json: null, token_hash: '', state: 'prepared',
      runtime_json: null, agent_id: null,
    }
    const next = { ...row, token_hash: tokenHash(managedToken(row)) }
    this.db.prepare(
      `INSERT INTO managed_claims
       (claim_id,device,name,team,agent_type,identity_key,instance_id,
        generation,previous_json,token_hash,state,runtime_json,agent_id)
       VALUES (@claim_id,@device,@name,@team,@agent_type,@identity_key,
        @instance_id,@generation,@previous_json,@token_hash,@state,
        @runtime_json,@agent_id)`
    ).run(next)
    this.recordInstance(next)
    return next
  }

  private usedInstance(instanceId: string): boolean {
    return this.db.prepare(
      'SELECT 1 FROM managed_instances WHERE device = ? AND instance_id = ?'
    ).get(this.device, instanceId) !== undefined
  }

  private recordInstance(row: Claim): void {
    this.db.prepare(
      `INSERT INTO managed_instances(device,instance_id,claim_id,generation)
       VALUES (?,?,?,?)`
    ).run(this.device, row.instance_id, row.claim_id, row.generation)
  }

  private advance(row: Claim, input: PrepareInput): Claim | ManagedFailure {
    if (row.identity_key !== input.identity_key || row.name !== input.name
      || row.team !== input.team || row.agent_type !== input.agent_type) {
      return failure('identity_conflict', 'Managed identity is already owned')
    }
    const previous = input.previous
      ? JSON.stringify(fenceOf(input.previous)) : null
    if (row.instance_id === input.instance_id) {
      if (row.previous_json !== previous || row.state === 'released') {
        return failure('stale_fence', 'Prepare does not match this instance')
      }
      return row
    }
    if (!input.previous || !sameFence(row, input.previous)) {
      return failure('stale_fence', 'Restart requires the current fence')
    }
    if (this.usedInstance(input.instance_id)) {
      return failure('stale_fence', 'Instance ID has already been used')
    }
    const occupied = this.db.prepare(
      `SELECT 1 FROM agents WHERE device = ? AND agent_id != ?
       AND ((name = ? AND team = ?) OR identity_key = ?)`
    ).get(this.device, row.agent_id ?? '', row.name, row.team, row.identity_key)
    if (occupied) {
      return failure('identity_conflict', 'Identity was claimed by another runtime')
    }
    if (row.generation === Number.MAX_SAFE_INTEGER) {
      return failure('generation_exhausted', 'Generation cannot be incremented')
    }
    const next: Claim = {
      ...row, instance_id: input.instance_id, generation: row.generation + 1,
      previous_json: previous, state: 'prepared', runtime_json: null,
    }
    this.db.prepare(
      `UPDATE managed_claims SET instance_id = ?, generation = ?,
       previous_json = ?, token_hash = ?, state = 'prepared',
       runtime_json = NULL WHERE claim_id = ?`
    ).run(next.instance_id, next.generation, previous,
      tokenHash(managedToken(next)), row.claim_id)
    this.recordInstance(next)
    if (row.agent_id) {
      this.db.prepare(
        `UPDATE agents SET delivery_kind = 'none', delivery_payload = NULL,
         tmux_pane_id = NULL,
         runtime_ui_pid = NULL WHERE agent_id = ?`
      ).run(row.agent_id)
    }
    return { ...next, token_hash: tokenHash(managedToken(next)) }
  }
}
