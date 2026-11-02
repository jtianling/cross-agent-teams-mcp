import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { AgentsRepo } from '../storage/agents-repo.js'
import type { SendMessageService } from '../mcp/send-message.js'
import type { FanoutResultEnvelope } from '../mcp/fanout-with-retry.js'
import { isMessageRead } from '../mcp/message-read.js'
import { nextOccurrence } from './calendar.js'
import { SchedulesRepo, type Run } from './repo.js'
import {
  ScheduleError, patchSchema, planInputSchema,
  type Plan, type PlanInput, type PlanPatch,
} from './schema.js'

const SENDER_TEAM = '__xats_schedules__'
const SENDER_NAME = 'scheduler'
const SENDER_ROLE = '__wake_scheduler__'
const CLOCK_CHECK_MS = 60_000
export interface SchedulerDeps { now?: () => number; log?: (line: string) => void }

function inputOf(plan: Plan): PlanInput {
  return { name: plan.name, to_team: plan.to_team,
    to_agent_name: plan.to_agent_name, prompt: plan.prompt,
    schedule: plan.schedule, max_runs: plan.max_runs }
}

export class WakeScheduler {
  private repo: SchedulesRepo
  private agents: AgentsRepo
  private now: () => number
  private log: (line: string) => void
  private timer?: ReturnType<typeof setTimeout>
  private active = new Map<string, Promise<void>>()
  private started = false
  private stopped = false
  private retryAfter = new Map<string, number>()

  constructor(private db: Database.Database,
    private sender: Pick<SendMessageService, 'send' | 'wakeExisting'>,
    private device: string, deps: SchedulerDeps = {}) {
    this.repo = new SchedulesRepo(db, device)
    this.agents = new AgentsRepo(db)
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.error(line))
  }

  list(): Plan[] { return this.repo.list() }

  get(id: string): Plan {
    const plan = this.repo.get(id)
    if (!plan) throw new ScheduleError('unknown_schedule', 'Schedule not found')
    return plan
  }

  add(raw: PlanInput): { plan: Plan; created: boolean } {
    this.assertRunning()
    const input = planInputSchema.parse(raw)
    const existing = this.list().find(plan => plan.name === input.name)
    if (existing) {
      if (JSON.stringify(inputOf(existing)) !== JSON.stringify(input)) {
        throw new ScheduleError('schedule_exists', 'Schedule name already exists')
      }
      return { plan: existing, created: false }
    }
    const next = this.first(input)
    const plan = this.repo.add(input, next, new Date(this.now()).toISOString())
    this.arm()
    return { plan, created: true }
  }

  update(id: string, raw: PlanPatch): Plan {
    this.assertRunning()
    const patch = patchSchema.parse(raw)
    const old = this.get(id)
    const input = planInputSchema.parse({ ...inputOf(old), ...patch,
      ...(patch.schedule?.kind === 'once' && patch.max_runs === undefined
        ? { max_runs: 1 } : {}),
    })
    this.uniqueName(input.name, id)
    const exhausted = input.max_runs !== null && old.run_count >= input.max_runs
    const next = patch.schedule ? this.first(input) : old.next_run_at
    const status = exhausted ? 'finished' : old.status === 'paused'
      ? 'paused' : 'active'
    const activeNext = status === 'active' ? next ?? this.first(input, false) : null
    const plan = this.repo.update(id, input, status, activeNext,
      new Date(this.now()).toISOString())
    this.arm()
    return plan
  }

  pause(id: string): Plan {
    this.assertRunning()
    const old = this.get(id)
    if (old.status !== 'active') return old
    const plan = this.repo.update(id, inputOf(old), 'paused', null,
      new Date(this.now()).toISOString())
    this.arm()
    return plan
  }

  resume(id: string): Plan {
    this.assertRunning()
    const old = this.get(id)
    if (old.status === 'active') return old
    if (old.max_runs !== null && old.run_count >= old.max_runs) {
      throw new ScheduleError('schedule_exhausted', 'Schedule has no remaining runs')
    }
    const plan = this.repo.update(id, inputOf(old), 'active', this.first(old, false),
      new Date(this.now()).toISOString())
    this.arm()
    return plan
  }

  remove(id: string): boolean {
    this.assertRunning()
    const removed = this.repo.remove(id)
    this.retryAfter.delete(id)
    this.arm()
    return removed
  }

  history(id: string) {
    this.get(id)
    return this.repo.runs(id).map(run => {
      const message = run.message_id && this.db.prepare(
        'SELECT id FROM messages WHERE id=? AND to_agent_id=?'
      ).get(run.message_id, run.recipient_id)
      const delivery = message ? this.db.prepare(`SELECT wake_status,
        skip_reason, retry_attempts, updated_at, delivered_at
        FROM message_delivery_status WHERE message_id=? AND agent_id=?`)
        .get(run.message_id, run.recipient_id) ?? null : null
      return { ...run, delivery, read: message && run.recipient_id
        ? isMessageRead(this.db, run.message_id!, run.recipient_id) : null }
    })
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    const now = this.now()
    for (const plan of this.list()) {
      if (plan.status !== 'active' || !plan.next_run_at ||
        Date.parse(plan.next_run_at) >= now || plan.schedule.kind === 'once') {
        continue
      }
      const next = nextOccurrence(plan.schedule, now)!
      this.repo.skipOverdue(plan, new Date(next).toISOString(),
        new Date(now).toISOString())
    }
    this.arm()
  }

  run(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      const tasks = this.sweep()
      this.arm()
      return Promise.all(tasks).then(() => undefined)
    } catch (error) {
      this.log(`wake-scheduler scan failed: ${String(error)}`)
      return Promise.resolve()
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    await Promise.allSettled([...this.active.values()])
  }

  private first(input: PlanInput, requireFutureStart = true): string {
    const now = this.now()
    if (requireFutureStart && input.schedule.kind === 'interval' &&
      Date.parse(input.schedule.start_at) <= now) {
      throw new ScheduleError('time_in_past', 'start_at must be in the future')
    }
    const next = nextOccurrence(input.schedule, now)
    if (next === null) {
      throw new ScheduleError('time_in_past', 'Alarm time must be in the future')
    }
    return new Date(next).toISOString()
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new ScheduleError('scheduler_stopped', 'Scheduler is stopping')
    }
  }

  private uniqueName(name: string, id: string): void {
    if (this.list().some(plan => plan.id !== id && plan.name === name)) {
      throw new ScheduleError('schedule_exists', 'Schedule name already exists')
    }
  }

  private arm(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.started || this.stopped) return
    try {
      const times = this.list().filter(plan => plan.status === 'active' &&
        plan.next_run_at && !this.active.has(plan.id))
        .map(plan => Math.max(Date.parse(plan.next_run_at!),
          this.retryAfter.get(plan.id) ?? 0))
      if (!times.length) return
      const delay = Math.max(0, Math.min(CLOCK_CHECK_MS,
        Math.min(...times) - this.now()))
      this.timer = setTimeout(() => { void this.run() }, delay)
      this.timer.unref()
    } catch (error) {
      this.log(`wake-scheduler timer failed: ${String(error)}`)
    }
  }

  private sweep(): Promise<void>[] {
    const now = this.now()
    const due = this.list().filter(plan => plan.status === 'active' &&
      plan.next_run_at && Date.parse(plan.next_run_at) <= now &&
      !this.active.has(plan.id) &&
      (this.retryAfter.get(plan.id) ?? 0) <= now)
    return due.map(plan => {
      const task = this.dispatch(plan, now).catch(error => {
        this.retryAfter.set(plan.id, this.now() + CLOCK_CHECK_MS)
        this.log(`wake-scheduler plan=${plan.id} dispatch failed: ${String(error)}`)
      }).finally(() => { this.active.delete(plan.id); this.arm() })
      this.active.set(plan.id, task)
      return task
    })
  }

  private next(plan: Plan, now: number): string | null {
    if (plan.max_runs !== null && plan.run_count + 1 >= plan.max_runs) return null
    const time = nextOccurrence(plan.schedule, now)
    return time === null ? null : new Date(time).toISOString()
  }

  private pending(plan: Plan, recipient: string): string | undefined {
    if (!plan.last_message_id || plan.last_recipient_id !== recipient) return
    const mail = this.db.prepare(`SELECT from_agent_id FROM messages
      WHERE id=? AND to_agent_id=? AND from_team=?`)
      .get(plan.last_message_id, recipient, SENDER_TEAM) as
        { from_agent_id: string } | undefined
    if (!mail || isMessageRead(this.db, plan.last_message_id, recipient)) return
    const owner = this.agents.findById(mail.from_agent_id)
    if (owner && (owner.device !== this.device || owner.team !== SENDER_TEAM ||
      owner.name !== SENDER_NAME || owner.role !== SENDER_ROLE ||
      owner.agent_type !== 'custom' || owner.delivery.kind !== 'none')) {
      throw new Error('Pending schedule message has a conflicting sender')
    }
    return mail.from_agent_id
  }

  private async dispatch(plan: Plan, now: number): Promise<void> {
    const next = this.next(plan, now)
    const run: Run = { id: randomUUID(), plan_id: plan.id,
      scheduled_at: plan.next_run_at!, executed_at: new Date(now).toISOString(),
      outcome: 'failed', message_id: null, recipient_id: null, error: null }
    let queued = run
    try {
      const result = await this.emit(plan, run, value => {
        queued = value
        this.repo.consume(plan, queued, next)
      })
      this.recordDelivery(queued, result)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log(`wake-scheduler plan=${plan.id} failed: ${detail}`)
      try {
        if (this.repo.hasRun(run.id)) this.repo.dispatchError(queued, detail)
        else this.repo.consume(plan, { ...run, error: detail }, next)
      } catch (storageError) {
        this.retryAfter.set(plan.id, this.now() + CLOCK_CHECK_MS)
        this.log(`wake-scheduler plan=${plan.id} error persistence failed: ` +
          String(storageError))
      }
    }
  }

  private async emit(plan: Plan, run: Run, commit: (run: Run) => void
  ): Promise<FanoutResultEnvelope> {
    const target = this.agents.findByIdentity({ device: this.device,
      team: plan.to_team, name: plan.to_agent_name })
    if (!target) throw new Error(`unknown_recipient: ${plan.to_agent_name}` +
      `@${plan.to_team}`)
    const from = this.systemSender()
    const pendingFrom = this.pending(plan, target.agent_id)
    if (pendingFrom) {
      commit({ ...run, outcome: 'coalesced', message_id: plan.last_message_id,
        recipient_id: target.agent_id })
      const result = await this.sender.wakeExisting(pendingFrom,
        plan.last_message_id!, from)
      if ('error' in result) throw new Error(result.error)
      return result
    }
    const result = await this.sender.send({
      from, to_agent_id: target.agent_id, to_team: plan.to_team,
      subject: `定时唤醒: ${plan.name}`,
      body: `xats 定时计划 ${plan.name}, 计划时刻 ${plan.next_run_at}.\n` +
        plan.prompt, auto_poke: true, need_reply: false, await_ack_s: 0,
    }, message => commit({ ...run, outcome: 'queued',
      message_id: message.message_id, recipient_id: message.recipient_id }))
    if ('error' in result) throw new Error(result.error)
    return result
  }

  private recordDelivery(run: Run, result: FanoutResultEnvelope): void {
    if (result.poked || result.retry_scheduled) return
    if (run.message_id && run.recipient_id &&
      isMessageRead(this.db, run.message_id, run.recipient_id)) return
    const detail = result.poke_skip_reasons?.map(row => row.reason)
      .join(', ') || 'wake_not_delivered'
    this.repo.dispatchError(run, detail)
    this.log(`wake-scheduler plan=${run.plan_id} delivery failed: ${detail}`)
  }

  private systemSender(): string {
    const found = this.agents.findByIdentity({ device: this.device,
      team: SENDER_TEAM, name: SENDER_NAME })
    if (found) {
      const row = this.agents.findById(found.agent_id)!
      if (row.role !== SENDER_ROLE || row.agent_type !== 'custom' ||
        row.delivery.kind !== 'none') {
        throw new Error('Scheduler system identity is already in use')
      }
      this.agents.touch(found.agent_id)
      return found.agent_id
    }
    return this.agents.register({ device: this.device,
      team: SENDER_TEAM, name: SENDER_NAME, role: SENDER_ROLE,
      agent_type: 'custom', delivery: { kind: 'none' } }).agent_id
  }
}
