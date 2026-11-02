import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { ReminderMonitor } from '../src/reminders/monitor.js'
import { ReminderWatchesRepo } from '../src/reminders/repo.js'
import { type Reminder } from '../src/reminders/schema.js'
import { insertAgent } from './helpers/insert-agent.js'

const LIST = 'bfe44969-fcb1-49a2-a9c3-a4c711f83bbd'
const INPUT = {
  list_id: LIST, to_team: 'work', to_agent_name: 'worker', event: 'added' as const,
}
const task = (id: string, changes: Partial<Reminder> = {}): Reminder => ({
  id, listID: LIST, title: 'Private task title', isCompleted: false,
  notes: 'Private task notes', ...changes,
})

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

function setup() {
  const db = openDb(':memory:')
  applySchema(db)
  let now = 0
  let items: Reminder[] = []
  const reader = { read: vi.fn(async (
    _listId: string, _signal: AbortSignal, _options?: { nativeTags: boolean }
  ) => items) }
  const poke = vi.fn(async () => ({ ok: true as const }))
  const sender = new SendMessageService(db, new AgentsRepo(db),
    new EventsOutbox(db), { poke })
  insertAgent(db, {
    agent_id: 'worker-id', name: 'worker', team: 'work',
    delivery: { kind: 'claude-channel', channel_session_id: 'isolated' },
  })
  const log = vi.fn()
  const deps = { reader, now: () => now, log }
  const monitor = new ReminderMonitor(db, sender, 'local', deps)
  cleanups.push(async () => { await monitor.stop(); db.close() })
  const messages = () => db.prepare('SELECT * FROM messages').all() as
    Array<{ body: string; need_reply: number; to_agent_id: string }>
  return {
    db, monitor, reader, sender, poke, deps, log, messages,
    setTime: (value: number) => { now = value },
    setItems: (value: Reminder[]) => { items = value },
  }
}

describe('reminder monitor', () => {
  it('aborts a removed rule read and preserves a concurrent new baseline read', async () => {
    const h = setup()
    const watch = await h.monitor.add({ ...INPUT, event: 'tag', tag: 'old' })
    let ruleSignal!: AbortSignal
    let finishRule!: (items: Reminder[]) => void
    let baselineSignal!: AbortSignal
    let finishBaseline!: (items: Reminder[]) => void
    h.reader.read.mockImplementationOnce((_id, signal) => new Promise((resolve, reject) => {
      ruleSignal = signal
      finishRule = resolve
      signal.addEventListener('abort', () => reject(new Error('read aborted')))
    }))
    const running = h.monitor.run()
    h.reader.read.mockImplementationOnce((_id, signal) => new Promise(resolve => {
      baselineSignal = signal
      finishBaseline = resolve
    }))
    const adding = h.monitor.add({ ...INPUT, event: 'tag', tag: 'new' })
    h.monitor.remove(watch.id)
    try {
      expect(ruleSignal.aborted).toBe(true)
      expect(baselineSignal.aborted).toBe(false)
    } finally {
      finishRule([])
      finishBaseline([])
      await adding
      await running
    }
    expect(h.monitor.list()).toMatchObject([{ event: 'tag', tag: 'new' }])
    expect(h.messages()).toHaveLength(0)
  })

  it('keeps added, completed and tag rules independent on one recipient', async () => {
    const h = setup()
    h.setItems([task('old', { tags: [] })])
    await h.monitor.add(INPUT)
    await h.monitor.add({ ...INPUT, event: 'completed' })
    await h.monitor.add({ ...INPUT, event: 'tag', tag: '#已审核' })
    expect(h.monitor.list()).toHaveLength(3)
    h.setItems([task('old', { tags: ['已审核'], isCompleted: true })])
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    h.setTime(29_999)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    h.setTime(30_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(2)
    h.setTime(300_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(2)
    expect(h.reader.read.mock.calls.filter(call => call[2]?.nativeTags))
      .toHaveLength(5)
  })

  it('notifies completion of a new observed task before the added wait ends', async () => {
    const h = setup()
    await h.monitor.add(INPUT)
    await h.monitor.add({ ...INPUT, event: 'completed' })
    h.setItems([task('new')])
    await h.monitor.run()
    h.setTime(1000)
    h.setItems([task('new', { isCompleted: true })])
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    h.setTime(301_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(2)
  })

  it('baselines tags, resets pending edits and can notify a re-added tag', async () => {
    const h = setup()
    h.setItems([task('baseline', { tags: ['Reviewed'] }), task('pending')])
    await h.monitor.add({ ...INPUT, event: 'tag', tag: '#REVIEWED' })
    h.setItems([task('baseline', { tags: ['Reviewed'], title: 'Edited' }),
      task('pending', { tags: ['reviewed'] })])
    await h.monitor.run()
    h.setTime(29_000)
    h.setItems([task('baseline', { tags: ['Reviewed'], title: 'Edited' }),
      task('pending', { tags: ['reviewed'], lastModifiedDate: 'new timestamp' })])
    await h.monitor.run()
    h.setTime(58_999)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(0)
    h.setTime(59_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    h.setItems([task('pending', { tags: [] })])
    await h.monitor.run()
    h.setItems([task('pending', { tags: ['Reviewed'] })])
    await h.monitor.run()
    h.setTime(89_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(2)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(2)
    expect(h.messages()[0].body).not.toMatch(/reviewed|Private/i)
  })

  it('cancels pending tag removal/deletion and holds newly tagged tasks 30s', async () => {
    const h = setup()
    await h.monitor.add({ ...INPUT, event: 'tag', tag: '已审核' })
    h.setItems([task('new', { tags: ['已审核'] }),
      task('removed', { tags: ['已审核'] }), task('deleted', { tags: ['已审核'] })])
    await h.monitor.run()
    h.setTime(20_000)
    h.setItems([task('new', { tags: ['已审核'] }), task('removed', { tags: [] })])
    await h.monitor.run()
    h.setTime(30_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    const repo = new ReminderWatchesRepo(h.db)
    const state = repo.snapshot(repo.get(h.monitor.list()[0].id)!)
    expect(state.deleted).toBeUndefined()
    expect(state.removed.tag_notified).toBe(false)
  })

  it('persists tag waits and notification state across restart', async () => {
    const h = setup()
    await h.monitor.add({ ...INPUT, event: 'tag', tag: '已审核' })
    h.setItems([task('new', { tags: ['已审核'] })])
    await h.monitor.run()
    await h.monitor.stop()
    const restored = new ReminderMonitor(h.db, h.sender, 'local', h.deps)
    cleanups.push(() => restored.stop())
    h.setTime(29_999)
    await restored.run()
    expect(h.messages()).toHaveLength(0)
    h.setTime(30_000)
    await restored.run()
    expect(h.messages()).toHaveLength(1)
    await restored.stop()
    const again = new ReminderMonitor(h.db, h.sender, 'local', h.deps)
    cleanups.push(() => again.stop())
    await again.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('does no reads, registration or timer scheduling without watches', () => {
    const h = setup()
    const timer = vi.spyOn(global, 'setTimeout')
    h.monitor.start()
    expect(h.reader.read).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM agents').get())
      .toEqual({ n: 1 })
  })

  it('baselines old tasks, delays additions and resets for every edit', async () => {
    const h = setup()
    h.setItems([task('old'), task('done', { isCompleted: true })])
    await h.monitor.add(INPUT)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(0)
    h.setItems([task('old'), task('new')])
    await h.monitor.run()
    h.setTime(240_000)
    h.setItems([task('old'), task('new', { notes: 'Edited content' })])
    await h.monitor.run()
    h.setTime(539_999)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(0)
    h.setTime(540_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    expect(h.poke).toHaveBeenCalledTimes(1)
    expect(h.messages()[0]).toMatchObject({
      need_reply: 0, to_agent_id: 'worker-id',
    })
    expect(h.messages()[0].body).toContain(LIST)
    expect(h.messages()[0].body).not.toMatch(/Private|Edited/)
    const state = h.db.prepare('SELECT snapshot_json FROM reminder_watches')
      .get() as { snapshot_json: string }
    expect(state.snapshot_json).not.toMatch(/Private|Edited/)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('notifies completion immediately and can detect a later completion', async () => {
    const h = setup()
    h.setItems([task('old')])
    await h.monitor.add({ ...INPUT, event: 'completed' })
    h.setItems([task('old', { isCompleted: true })])
    await h.monitor.run()
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    h.setItems([task('old', { title: 'Renamed' })])
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    h.setItems([task('old', { isCompleted: true })])
    await h.monitor.run()
    expect(h.messages()).toHaveLength(2)
  })

  it('holds pending completions and drops vanished pending tasks', async () => {
    const h = setup()
    await h.monitor.add(INPUT)
    h.setItems([task('new'), task('vanished')])
    await h.monitor.run()
    h.setTime(100_000)
    h.setItems([task('new', { isCompleted: true })])
    await h.monitor.run()
    expect(h.messages()).toHaveLength(0)
    h.setTime(400_000)
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('keeps editing state across restart and does not replay sent events', async () => {
    const h = setup()
    await h.monitor.add(INPUT)
    h.setItems([task('new')])
    await h.monitor.run()
    await h.monitor.stop()
    const restored = new ReminderMonitor(h.db, h.sender, 'local', h.deps)
    cleanups.push(() => restored.stop())
    h.setTime(300_000)
    await restored.run()
    expect(h.messages()).toHaveLength(1)
    await restored.stop()
    const again = new ReminderMonitor(h.db, h.sender, 'local', h.deps)
    cleanups.push(() => again.stop())
    await again.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('discards in-flight results after deletion and cancels the last timer', async () => {
    const h = setup()
    h.setItems([task('old')])
    const watch = await h.monitor.add({ ...INPUT, event: 'completed' })
    h.monitor.start()
    await h.monitor.run()
    let finish!: (items: Reminder[]) => void
    h.reader.read.mockImplementationOnce(() => new Promise(resolve => {
      finish = resolve
    }))
    const running = h.monitor.run()
    expect(h.monitor.remove(watch.id)).toBe(true)
    finish([task('old', { isCompleted: true })])
    await running
    expect(h.messages()).toHaveLength(0)
    const count = h.reader.read.mock.calls.length
    await h.monitor.run()
    expect(h.reader.read).toHaveBeenCalledTimes(count)
    expect(h.monitor.list()).toEqual([])
  })

  it('isolates errors and retries a missing recipient without advancing state', async () => {
    const h = setup()
    h.setItems([task('old')])
    const watch = await h.monitor.add({ ...INPUT, event: 'completed' })
    h.db.prepare('DELETE FROM agents WHERE agent_id=?').run('worker-id')
    h.setItems([task('old', { isCompleted: true })])
    await h.monitor.run()
    expect(h.monitor.list()[0].last_error).toContain('unknown_recipient')
    expect(h.messages()).toHaveLength(0)
    insertAgent(h.db, {
      agent_id: 'replacement', name: 'worker', team: 'work',
    })
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    expect(h.messages()[0].to_agent_id).toBe('replacement')
    h.reader.read.mockRejectedValueOnce(new Error('specific read failure'))
    await h.monitor.run()
    expect(h.monitor.list()[0].last_error).toBe('specific read failure')
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(watch.id))
  })

  it('does not start reads from a stale scan after all rules are removed', async () => {
    const h = setup()
    const first = await h.monitor.add(INPUT)
    const second = await h.monitor.add({ ...INPUT, to_agent_name: 'second' })
    let finish!: (items: Reminder[]) => void
    h.reader.read.mockImplementationOnce(() => new Promise(resolve => {
      finish = resolve
    }))
    const before = h.reader.read.mock.calls.length
    const running = h.monitor.run()
    h.monitor.remove(first.id)
    h.monitor.remove(second.id)
    finish([])
    await running
    expect(h.reader.read).toHaveBeenCalledTimes(before + 1)
    expect(h.monitor.list()).toEqual([])
  })

  it('rolls back mailbox and event insertion when snapshot persistence fails', async () => {
    const h = setup()
    h.setItems([task('old')])
    await h.monitor.add({ ...INPUT, event: 'completed' })
    const save = vi.spyOn(ReminderWatchesRepo.prototype, 'save')
      .mockImplementationOnce(() => { throw new Error('disk write failed') })
    h.setItems([task('old', { isCompleted: true })])
    await h.monitor.run()
    expect(h.messages()).toHaveLength(0)
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM events').get())
      .toEqual({ n: 0 })
    save.mockRestore()
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
  })

  it('commits before slow wake dispatch and never duplicates a failed wake', async () => {
    const h = setup()
    h.setItems([task('old')])
    await h.monitor.add({ ...INPUT, event: 'completed' })
    h.poke.mockImplementationOnce(async () => {
      expect(h.messages()).toHaveLength(1)
      const row = new ReminderWatchesRepo(h.db).get(h.monitor.list()[0].id)!
      expect(new ReminderWatchesRepo(h.db).snapshot(row).old.completed)
        .toBe(true)
      throw new Error('wake failed')
    })
    h.setItems([task('old', { isCompleted: true })])
    await h.monitor.run()
    await h.monitor.run()
    expect(h.messages()).toHaveLength(1)
    expect(h.poke).toHaveBeenCalledTimes(1)
  })
})
