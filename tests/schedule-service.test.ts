import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService, type AutoPokeFn } from '../src/mcp/send-message.js'
import { GetInboxService } from '../src/mcp/get-inbox.js'
import { WakeScheduler } from '../src/schedules/service.js'
import { planInputSchema, type PlanInput } from '../src/schedules/schema.js'
import { insertAgent } from './helpers/insert-agent.js'

const START = Date.parse('2030-01-01T00:00:00Z')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup(path = ':memory:') {
  const db = openDb(path)
  applySchema(db)
  let now = START
  const agents = new AgentsRepo(db)
  const poke = vi.fn<AutoPokeFn>(async () => ({ ok: true as const }))
  const sender = new SendMessageService(db, agents, new EventsOutbox(db), { poke })
  const log = vi.fn()
  const deps = { now: () => now, log }
  const scheduler = new WakeScheduler(db, sender, 'local', deps)
  const inbox = new GetInboxService(db, agents)
  const target = (id = 'worker-id') => insertAgent(db, {
    agent_id: id, name: 'worker', team: 'work',
    delivery: { kind: 'claude-channel', channel_session_id: 'isolated' },
  })
  target()
  const input = (extra: Partial<PlanInput> = {}) => planInputSchema.parse({
    name: '巡检', to_team: 'work', to_agent_name: 'worker',
    prompt: 'Check actual progress', max_runs: null,
    schedule: { kind: 'interval', start_at: new Date(START + 1000).toISOString(),
      every_seconds: 1 }, ...extra,
  })
  cleanups.push(async () => { await scheduler.stop(); db.close() })
  const messages = () => db.prepare('SELECT * FROM messages').all() as
    Array<{ id: string; to_agent_id: string; from_agent_id: string; body: string }>
  return { db, scheduler, sender, agents, poke, inbox, log, deps, input, target,
    messages, setTime: (time: number) => { now = time } }
}

describe('persistent wake scheduler', () => {
  it('uses an internal sender and distinguishes delivered from inbox read', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input({ schedule: {
      kind: 'once', at: new Date(START + 1000).toISOString(),
    } }))
    h.setTime(START + 999)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(0)
    h.setTime(START + 1000)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(1)
    expect(h.scheduler.get(plan.id)).toMatchObject({ status: 'finished',
      run_count: 1, next_run_at: null })
    expect(h.scheduler.history(plan.id)[0]).toMatchObject({
      outcome: 'queued', read: false, delivery: { wake_status: 'delivered' },
    })
    const mail = h.inbox.get({ caller: 'worker-id' }).messages[0]
    expect(mail).toMatchObject({ from_name: 'scheduler',
      from_team: '__xats_schedules__', need_reply: false })
    expect(mail.body).toContain('Check actual progress')
    expect(h.scheduler.history(plan.id)[0].read).toBe(true)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('coalesces unread messages, retries their wake, and stops at total count', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input({ max_runs: 3 }))
    for (const offset of [1000, 2000, 3000, 4000]) {
      h.setTime(START + offset)
      await h.scheduler.run()
    }
    expect(h.messages()).toHaveLength(1)
    expect(h.poke).toHaveBeenCalledTimes(3)
    expect(h.scheduler.get(plan.id)).toMatchObject({ status: 'finished',
      run_count: 3 })
    expect(h.scheduler.history(plan.id).map(run => run.outcome))
      .toEqual(['coalesced', 'coalesced', 'queued'])
  })

  it('creates a fresh notification after read and resolves replacement identity', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input())
    h.setTime(START + 1000)
    await h.scheduler.run()
    h.inbox.get({ caller: 'worker-id' })
    h.setTime(START + 2000)
    await h.scheduler.run()
    h.db.prepare('DELETE FROM agents WHERE agent_id=?').run('worker-id')
    h.target('replacement-id')
    h.setTime(START + 3000)
    await h.scheduler.run()
    expect(h.messages().map(message => message.to_agent_id))
      .toEqual(['worker-id', 'worker-id', 'replacement-id'])
    expect(h.scheduler.history(plan.id)[0].read).toBe(false)
  })

  it('makes retries of create idempotent and rejects conflicting names', () => {
    const h = setup()
    const first = h.scheduler.add(h.input())
    expect(h.scheduler.add(h.input())).toEqual({ ...first, created: false })
    expect(() => h.scheduler.add(h.input({ prompt: 'Different' })))
      .toThrow('already exists')
    expect(h.scheduler.list()).toHaveLength(1)
  })

  it('pauses, updates and resumes an interval without changing its phase', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input())
    h.scheduler.pause(plan.id)
    h.setTime(START + 5500)
    h.scheduler.update(plan.id, { prompt: 'Changed' })
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(0)
    expect(h.scheduler.resume(plan.id).next_run_at)
      .toBe(new Date(START + 6000).toISOString())
    h.setTime(START + 6000)
    await h.scheduler.run()
    expect(h.messages()[0].body).toContain('Changed')
    expect(h.scheduler.remove(plan.id)).toBe(true)
    expect(h.scheduler.list()).toEqual([])
    expect(h.messages()).toHaveLength(1)
    h.setTime(START + 7000)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('does not loop over clock-forward missed ticks or duplicate after rollback', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input())
    h.setTime(START + 3_600_500)
    await Promise.all([h.scheduler.run(), h.scheduler.run()])
    expect(h.scheduler.get(plan.id)).toMatchObject({ run_count: 1,
      next_run_at: new Date(START + 3_601_000).toISOString() })
    h.setTime(START + 1000)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('persists across restart, skips recurring backlog, and catches up once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xats-schedule-restart-'))
    cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }) })
    const h = setup(join(dir, 'data.db'))
    const { plan } = h.scheduler.add(h.input())
    const once = h.scheduler.add(h.input({ name: 'once', schedule: {
      kind: 'once', at: new Date(START + 1000).toISOString(),
    } })).plan
    await h.scheduler.stop()
    const otherDb = openDb(join(dir, 'data.db'))
    const otherSender = new SendMessageService(otherDb,
      new AgentsRepo(otherDb), new EventsOutbox(otherDb), { poke: h.poke })
    const current = new WakeScheduler(otherDb, otherSender, 'local', h.deps)
    cleanups.push(async () => { await current.stop(); otherDb.close() })
    h.setTime(START + 5000)
    current.start()
    await current.run()
    expect(current.get(plan.id)).toMatchObject({ run_count: 0,
      next_run_at: new Date(START + 6000).toISOString() })
    expect(current.history(plan.id)[0].outcome).toBe('missed')
    expect(current.get(once.id).status).toBe('finished')
    expect(h.log.mock.calls).toEqual([])
    expect(h.messages()).toHaveLength(1)
  })

  it('records missing target failure and never resolves a remote namesake', async () => {
    const h = setup()
    h.db.prepare('DELETE FROM agents WHERE agent_id=?').run('worker-id')
    insertAgent(h.db, { agent_id: 'remote', name: 'worker', team: 'work',
      device: 'other-device' })
    const { plan } = h.scheduler.add(h.input({ max_runs: 1 }))
    h.setTime(START + 1000)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(0)
    expect(h.scheduler.get(plan.id)).toMatchObject({ status: 'finished',
      run_count: 1, last_error: 'unknown_recipient: worker@work' })
    expect(h.scheduler.history(plan.id)[0].outcome).toBe('failed')
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('unknown_recipient'))
  })

  it('rolls back mail and event if schedule commit fails, without duplicate mail', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input())
    h.db.exec(`CREATE TRIGGER fail_queued BEFORE INSERT ON wake_plan_runs
      WHEN NEW.outcome='queued' BEGIN SELECT RAISE(ABORT, 'disk fixture'); END;`)
    h.setTime(START + 1000)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(0)
    expect(h.scheduler.get(plan.id).run_count).toBe(1)
    expect(h.scheduler.history(plan.id)[0]).toMatchObject({ outcome: 'failed',
      error: 'disk fixture' })
    expect(h.db.prepare('SELECT * FROM events').all()).toHaveLength(0)
    h.db.exec('DROP TRIGGER fail_queued')
    h.setTime(START + 2000)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('does not recreate mail when the post-commit transport throws', async () => {
    const h = setup()
    const send = h.sender.send.bind(h.sender)
    vi.spyOn(h.sender, 'send').mockImplementation(async (input, callback) => {
      await send(input, callback)
      throw new Error('transport fixture failed after commit')
    })
    const { plan } = h.scheduler.add(h.input())
    h.setTime(START + 1000)
    await h.scheduler.run()
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(1)
    expect(h.scheduler.get(plan.id).run_count).toBe(1)
    expect(h.scheduler.history(plan.id)[0].error)
      .toBe('transport fixture failed after commit')
  })

  it('uses persisted evidence after an outer COMMIT fails', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input())
    h.db.exec(`CREATE TABLE fk_parent(id INTEGER PRIMARY KEY);
      CREATE TABLE deferred_child(id INTEGER REFERENCES fk_parent(id)
        DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_commit AFTER INSERT ON messages BEGIN
        INSERT INTO deferred_child(id) VALUES(123); END;`)
    h.setTime(START + 1000)
    await h.scheduler.run()
    expect(h.messages()).toHaveLength(0)
    expect(h.scheduler.get(plan.id)).toMatchObject({ run_count: 1,
      next_run_at: new Date(START + 2000).toISOString() })
    expect(h.scheduler.history(plan.id)[0]).toMatchObject({ outcome: 'failed',
      error: 'FOREIGN KEY constraint failed' })
    await h.scheduler.run()
    expect(h.scheduler.history(plan.id)).toHaveLength(1)
  })

  it('re-wakes old mail with a live caller after its system sender is deleted', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input({ max_runs: 3 }))
    h.poke.mockImplementation(async args => {
      expect(h.agents.findById(args.fromAgentId)).toBeDefined()
      return { ok: true }
    })
    h.setTime(START + 1000)
    await h.scheduler.run()
    const oldSender = h.messages()[0].from_agent_id
    h.db.prepare('DELETE FROM agents WHERE agent_id=?').run(oldSender)
    for (const offset of [2000, 3000]) {
      h.setTime(START + offset)
      await h.scheduler.run()
    }
    expect(h.poke).toHaveBeenCalledTimes(3)
    expect(h.messages()).toHaveLength(1)
    expect(h.scheduler.history(plan.id)[0]).toMatchObject({
      outcome: 'coalesced', error: null, delivery: { wake_status: 'delivered' },
    })
    expect(h.poke.mock.calls[1][0].fromAgentId).not.toBe(oldSender)
  })

  it('dispatches a later alarm while another plan transport is still waiting', async () => {
    vi.useFakeTimers()
    const h = setup()
    let release!: () => void
    h.poke.mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ ok: true })
    }))
    h.scheduler.add(h.input({ name: 'slow', schedule: { kind: 'once',
      at: new Date(START + 1000).toISOString() } }))
    h.scheduler.add(h.input({ name: 'later', schedule: { kind: 'once',
      at: new Date(START + 2000).toISOString() } }))
    h.scheduler.start()
    try {
      h.setTime(START + 1000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.messages()).toHaveLength(1)
      h.setTime(START + 2000)
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.messages()).toHaveLength(2)
      expect(h.messages()[1].body).toContain('later')
    } finally {
      release()
      await h.scheduler.stop()
    }
  })

  it('keeps no timer without active plans and arms newly added plans', async () => {
    vi.useFakeTimers()
    const h = setup()
    h.scheduler.start()
    expect(vi.getTimerCount()).toBe(0)
    const { plan } = h.scheduler.add(h.input())
    expect(vi.getTimerCount()).toBe(1)
    h.setTime(START + 1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.messages()).toHaveLength(1)
    h.scheduler.pause(plan.id)
    expect(vi.getTimerCount()).toBe(0)
    h.scheduler.resume(plan.id)
    expect(vi.getTimerCount()).toBe(1)
    h.scheduler.remove(plan.id)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates plans by local device and bounds history at 100 runs', async () => {
    const h = setup()
    const { plan } = h.scheduler.add(h.input())
    const other = new WakeScheduler(h.db, h.sender, 'other', h.deps)
    expect(other.list()).toEqual([])
    await other.stop()
    for (let i = 1; i <= 105; i++) {
      h.setTime(START + i * 1000)
      await h.scheduler.run()
    }
    expect(h.scheduler.history(plan.id)).toHaveLength(100)
    expect(h.scheduler.get(plan.id).run_count).toBe(105)
    expect(h.messages()).toHaveLength(1)
  })

  it('checks ownership before re-waking existing messages', async () => {
    const h = setup()
    h.scheduler.add(h.input())
    h.setTime(START + 1000)
    await h.scheduler.run()
    expect(await h.sender.wakeExisting('wrong-sender', h.messages()[0].id))
      .toEqual({ error: 'unknown_message' })
    h.inbox.get({ caller: 'worker-id' })
    expect(await h.sender.wakeExisting(h.messages()[0].from_agent_id,
      h.messages()[0].id)).toEqual({ poked: false, retry_scheduled: false })
    expect(h.poke).toHaveBeenCalledTimes(1)
  })
})
