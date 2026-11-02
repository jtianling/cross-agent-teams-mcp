import type Database from 'better-sqlite3'
import { AgentsRepo } from '../storage/agents-repo.js'
import type { SendMessageService } from '../mcp/send-message.js'
import { ReminderWatchesRepo } from './repo.js'
import { remindctlReader, type ReminderReader } from './remindctl.js'
import { advance, baseline } from './state.js'
import {
  ReminderError, watchInputSchema, type Watch, type WatchInput,
} from './schema.js'

export const REMINDER_POLL_MS = 30_000
const SENDER_TEAM = '__xats_reminders__'
const SENDER_NAME = 'reminder-monitor'
const SENDER_ROLE = '__reminder_monitor__'

export interface ReminderMonitorDeps {
  reader?: ReminderReader
  now?: () => number
  log?: (line: string) => void
}

export class ReminderMonitor {
  private repo: ReminderWatchesRepo
  private agents: AgentsRepo
  private reader: ReminderReader
  private now: () => number
  private log: (line: string) => void
  private timer?: ReturnType<typeof setTimeout>
  private inFlight?: Promise<void>
  private reads = new Map<Promise<unknown>, {
    controller: AbortController; watchId?: string
  }>()
  private stopped = false
  private started = false

  constructor(
    db: Database.Database,
    private sender: SendMessageService,
    private localDevice: string,
    deps: ReminderMonitorDeps = {}
  ) {
    this.repo = new ReminderWatchesRepo(db)
    this.agents = new AgentsRepo(db)
    this.reader = deps.reader ?? remindctlReader
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.error(line))
  }

  list(): Watch[] { return this.repo.list() }

  start(): void {
    this.started = true
    if (!this.stopped && this.list().length > 0) void this.run()
  }

  async add(raw: WatchInput): Promise<Watch> {
    const input = watchInputSchema.parse(raw)
    this.assertRunning()
    const items = await this.read(input)
    this.assertRunning()
    const now = this.now()
    const watch = this.repo.add(input, baseline(items, now, input), now)
    this.schedule()
    return watch
  }

  remove(id: string): boolean {
    const removed = this.repo.remove(id)
    if (removed) {
      for (const read of this.reads.values()) {
        if (read.watchId === id) read.controller.abort()
      }
    }
    if (this.list().length === 0) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    return removed
  }

  run(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.stopped) return Promise.resolve()
    clearTimeout(this.timer)
    this.timer = undefined
    this.inFlight = this.sweep().finally(() => {
      this.inFlight = undefined
      this.schedule()
    })
    return this.inFlight
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
    for (const read of this.reads.values()) read.controller.abort()
    await Promise.allSettled([...this.reads.keys(), this.inFlight])
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new ReminderError('monitor_stopped', 'Reminder monitor is stopping')
    }
  }

  private async read(watch: WatchInput, watchId?: string) {
    const controller = new AbortController()
    const result = this.reader.read(watch.list_id, controller.signal,
      { nativeTags: watch.event === 'tag' })
    this.reads.set(result, { controller, watchId })
    try { return await result }
    finally { this.reads.delete(result) }
  }

  private schedule(): void {
    if (!this.started || this.stopped || this.timer || this.inFlight) return
    try {
      if (this.list().length === 0) return
      this.timer = setTimeout(() => { void this.run() }, REMINDER_POLL_MS)
      this.timer.unref()
    } catch (error) {
      this.log(`reminder-monitor scheduling failed: ${String(error)}`)
    }
  }

  private async sweep(): Promise<void> {
    try {
      for (const watch of this.list()) {
        if (this.stopped) return
        try { await this.check(watch) }
        catch (error) { this.recordError(watch.id, error) }
      }
    } catch (error) {
      this.log(`reminder-monitor scan failed: ${String(error)}`)
    }
  }

  private recordError(id: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.log(`reminder-monitor watch=${id} failed: ${detail}`)
    if (this.stopped) return
    try { this.repo.fail(id, detail) }
    catch (storageError) {
      this.log(`reminder-monitor watch=${id} error persistence failed: ` +
        String(storageError))
    }
  }

  private async check(watch: Watch): Promise<void> {
    if (!this.repo.get(watch.id)) return
    const items = await this.read(watch, watch.id)
    if (this.stopped) return
    const current = this.repo.get(watch.id)
    if (!current) return
    const now = this.now()
    const next = advance(this.repo.snapshot(current), items, now, current)
    const commit = () => this.repo.save(watch.id, next.snapshot, now)
    if (!next.notify) { commit(); return }
    const result = await this.sender.send({
      from: this.systemSender(),
      to_agent_name: watch.to_agent_name,
      to_team: watch.to_team,
      subject: 'Apple Reminders',
      body: `Apple Reminders 监控列表有任务变化, 请查看列表 ${watch.list_id}.`,
      auto_poke: true,
      need_reply: false,
      await_ack_s: 0,
    }, commit)
    if ('error' in result) {
      throw new ReminderError(result.error,
        `Cannot notify ${watch.to_agent_name}@${watch.to_team}: ${result.error}`)
    }
  }

  private systemSender(): string {
    const found = this.agents.findByIdentity({
      device: this.localDevice, team: SENDER_TEAM, name: SENDER_NAME,
    })
    if (found) {
      const row = this.agents.findById(found.agent_id)
      if (row?.role !== SENDER_ROLE || row.agent_type !== 'custom' ||
        row.delivery.kind !== 'none') {
        throw new ReminderError('sender_identity_conflict',
          'Reminder monitor sender identity is already in use')
      }
      this.agents.touch(found.agent_id)
      return found.agent_id
    }
    return this.agents.register({
      device: this.localDevice, team: SENDER_TEAM, name: SENDER_NAME,
      role: SENDER_ROLE, agent_type: 'custom', delivery: { kind: 'none' },
    }).agent_id
  }
}
