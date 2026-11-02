import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { planInputSchema, type Plan, type PlanInput } from './schema.js'

type Stored = Omit<Plan, keyof PlanInput> & {
  config_json: string; device: string; name: string
}
export type RunOutcome = 'queued' | 'coalesced' | 'failed' | 'missed'
export interface Run {
  id: string
  plan_id: string
  scheduled_at: string
  executed_at: string
  outcome: RunOutcome
  message_id: string | null
  recipient_id: string | null
  error: string | null
}
const HISTORY_LIMIT = 100

export class SchedulesRepo {
  constructor(private db: Database.Database, private device: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS wake_plans (
      id TEXT PRIMARY KEY, device TEXT NOT NULL, name TEXT NOT NULL,
      config_json TEXT NOT NULL, status TEXT NOT NULL,
      next_run_at TEXT, run_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_run_at TEXT, last_error TEXT, last_message_id TEXT,
      last_recipient_id TEXT, UNIQUE(device, name)
    ); CREATE TABLE IF NOT EXISTS wake_plan_runs (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL,
      scheduled_at TEXT NOT NULL, executed_at TEXT NOT NULL,
      outcome TEXT NOT NULL, message_id TEXT, recipient_id TEXT, error TEXT
    ); CREATE INDEX IF NOT EXISTS wake_runs_plan
      ON wake_plan_runs(plan_id, executed_at);`)
  }

  private decode(row: Stored): Plan {
    const { config_json, device: _device, ...state } = row
    return { ...state, ...planInputSchema.parse(JSON.parse(config_json)) }
  }

  list(): Plan[] {
    return (this.db.prepare(`SELECT * FROM wake_plans WHERE device=?
      ORDER BY created_at, id`).all(this.device) as Stored[])
      .map(row => this.decode(row))
  }

  get(id: string): Plan | undefined {
    const row = this.db.prepare('SELECT * FROM wake_plans WHERE id=? AND device=?')
      .get(id, this.device) as Stored | undefined
    return row ? this.decode(row) : undefined
  }

  add(input: PlanInput, next: string, now: string): Plan {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO wake_plans
      (id, device, name, config_json, status, next_run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(id, this.device, input.name, JSON.stringify(input), next, now, now)
    return this.get(id)!
  }

  update(id: string, input: PlanInput, status: Plan['status'],
    next: string | null, now: string): Plan {
    this.db.prepare(`UPDATE wake_plans SET name=?, config_json=?, status=?,
      next_run_at=?, updated_at=? WHERE id=? AND device=?`)
      .run(input.name, JSON.stringify(input), status, next, now, id, this.device)
    return this.get(id)!
  }

  remove(id: string): boolean {
    return this.db.transaction(() => {
      if (!this.get(id)) return false
      this.db.prepare('DELETE FROM wake_plan_runs WHERE plan_id=?').run(id)
      return this.db.prepare('DELETE FROM wake_plans WHERE id=? AND device=?')
        .run(id, this.device).changes > 0
    })()
  }

  consume(plan: Plan, run: Run, next: string | null): void {
    this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE wake_plans
        SET run_count=run_count+1, next_run_at=?, status=?, last_run_at=?,
          updated_at=?, last_error=?,
          last_message_id=COALESCE(?, last_message_id),
          last_recipient_id=COALESCE(?, last_recipient_id)
        WHERE id=? AND device=? AND status='active'
          AND run_count=? AND next_run_at=?`)
        .run(next, next ? 'active' : 'finished', run.executed_at,
          run.executed_at, run.error, run.message_id, run.recipient_id,
          plan.id, this.device, plan.run_count, plan.next_run_at).changes
      if (changed !== 1) throw new Error('Schedule changed before commit')
      this.insertRun(run)
    })()
  }

  skipOverdue(plan: Plan, next: string, now: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE wake_plans SET next_run_at=?, updated_at=?
        WHERE id=? AND device=?`).run(next, now, plan.id, this.device)
      this.insertRun({ id: randomUUID(), plan_id: plan.id,
        scheduled_at: plan.next_run_at!, executed_at: now, outcome: 'missed',
        message_id: null, recipient_id: null, error: null })
    })()
  }

  private insertRun(run: Run): void {
    this.db.prepare(`INSERT INTO wake_plan_runs
      (id, plan_id, scheduled_at, executed_at, outcome, message_id,
       recipient_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.id, run.plan_id, run.scheduled_at, run.executed_at,
        run.outcome, run.message_id, run.recipient_id, run.error)
    this.db.prepare(`DELETE FROM wake_plan_runs WHERE plan_id=? AND id NOT IN
      (SELECT id FROM wake_plan_runs WHERE plan_id=?
       ORDER BY executed_at DESC, rowid DESC LIMIT ?)`)
      .run(run.plan_id, run.plan_id, HISTORY_LIMIT)
  }

  dispatchError(run: Run, error: string): void {
    this.db.prepare('UPDATE wake_plan_runs SET error=? WHERE id=?')
      .run(error, run.id)
    this.db.prepare(`UPDATE wake_plans SET last_error=?
      WHERE id=? AND device=? AND last_message_id=?`)
      .run(error, run.plan_id, this.device, run.message_id)
  }

  runs(id: string): Run[] {
    return this.db.prepare(`SELECT * FROM wake_plan_runs WHERE plan_id=?
      ORDER BY executed_at DESC, rowid DESC LIMIT ?`)
      .all(id, HISTORY_LIMIT) as Run[]
  }

  hasRun(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM wake_plan_runs WHERE id=?').get(id)
      !== undefined
  }
}
