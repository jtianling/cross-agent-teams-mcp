import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService, type AutoPokeFn } from '../src/mcp/send-message.js'
import { GetInboxService } from '../src/mcp/get-inbox.js'
import { GetDeliveryStatusService } from '../src/mcp/delivery-status.js'
import {
  ACK_DEADLINE_MS,
  ALERT_RETRY_WINDOW_MS,
  CONTENT_WRITING_POKE_FAILURES,
  TRANSIENT_ALERT_FAILURES,
  buildUnreadAlert,
  createUnreadWatchdogRunner,
  runUnreadWatchdogScan,
} from '../src/mcp/unread-watchdog.js'
import { pokeWroteContent, type PokeResult } from '../src/mcp/poke.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-ack-watchdog-'))

function setup() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const poke: AutoPokeFn = async () => ({ ok: true })
  return {
    db,
    send: new SendMessageService(db, agents, events, { poke }),
    inbox: new GetInboxService(db, agents),
    status: new GetDeliveryStatusService(db),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Captures every alert the scan tries to deliver. */
function recorder(result: PokeResult = { ok: true, transport_used: 'claude-channel', channel_session_id: 'cs' }) {
  const calls: Array<{ target: string; prompt: string }> = []
  return {
    calls,
    fn: async (target: string, prompt: string): Promise<PokeResult> => {
      calls.push({ target, prompt })
      return result
    },
  }
}

/** Move the send past its deadline without waiting fifteen real minutes. */
function expire(db: ReturnType<typeof setup>['db'], messageId: string) {
  db.prepare(`UPDATE messages SET ack_deadline_at=? WHERE id=?`)
    .run(new Date(Date.now() - 1000).toISOString(), messageId)
}

function alertedAt(db: ReturnType<typeof setup>['db'], messageId: string): string | null {
  const row = db.prepare(`SELECT ack_alerted_at FROM messages WHERE id=?`)
    .get(messageId) as { ack_alerted_at: string | null }
  return row.ack_alerted_at
}

describe('unread watchdog scan', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.forEach(c => c()); cleanups.length = 0 })

  async function sentAndExpired() {
    const ctx = setup()
    cleanups.push(ctx.cleanup)
    insertAgent(ctx.db, { agent_id: 'A', name: 'alice', team: 'alpha' })
    insertAgent(ctx.db, { agent_id: 'B', name: 'bob', team: 'alpha' })
    const sent = await ctx.send.send({
      from: 'A', to_agent_id: 'B', subject: 'ping', body: 'q', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')
    expire(ctx.db, sent.message_id)
    return { ...ctx, messageId: sent.message_id }
  }

  it('pokes the sender when the deadline passes unread', async () => {
    const { db, messageId } = await sentAndExpired()
    const rec = recorder()

    const out = await runUnreadWatchdogScan({ db, pokeFn: rec.fn })

    expect(out).toEqual({ examined: 1, alerted: 1, retrying: 0 })
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0].target).toBe('A')
    expect(alertedAt(db, messageId)).not.toBeNull()
  })

  it('emits nothing when the message was read before the deadline', async () => {
    const { db, inbox, messageId } = await sentAndExpired()
    inbox.get({ caller: 'B' })
    const rec = recorder()

    const out = await runUnreadWatchdogScan({ db, pokeFn: rec.fn })

    expect(out).toEqual({ examined: 1, alerted: 0, retrying: 0 })
    expect(rec.calls).toHaveLength(0)
    expect(alertedAt(db, messageId)).not.toBeNull()
  })

  it('alerts at most once across repeated scans', async () => {
    const { db } = await sentAndExpired()
    const rec = recorder()

    await runUnreadWatchdogScan({ db, pokeFn: rec.fn })
    const second = await runUnreadWatchdogScan({ db, pokeFn: rec.fn })

    expect(second).toEqual({ examined: 0, alerted: 0, retrying: 0 })
    expect(rec.calls).toHaveLength(1)
  })

  it('suppresses the alert but still claims the row when the sender is gone', async () => {
    const { db, messageId } = await sentAndExpired()
    db.prepare(`DELETE FROM agents WHERE agent_id='A'`).run()
    const rec = recorder()

    const out = await runUnreadWatchdogScan({ db, pokeFn: rec.fn })

    expect(out.alerted).toBe(0)
    expect(alertedAt(db, messageId)).not.toBeNull()
  })

  it('does not retry an alert that failed terminally', async () => {
    const { db, messageId } = await sentAndExpired()
    const rec = recorder({ error: 'pane_dead' })

    const first = await runUnreadWatchdogScan({ db, pokeFn: rec.fn })
    const second = await runUnreadWatchdogScan({ db, pokeFn: rec.fn })

    expect(first.alerted).toBe(0)
    expect(second).toEqual({ examined: 0, alerted: 0, retrying: 0 })
    expect(rec.calls).toHaveLength(1)
    expect(alertedAt(db, messageId)).not.toBeNull()
  })

  for (const transient of ['guard_failed', 'kimi_session_busy', 'channel_sink_failed']) {
    it(`retries an alert that failed with ${transient}`, async () => {
      const { db, messageId } = await sentAndExpired()
      // The sender was merely busy: the row must stay due, not be written off.
      const failing = recorder({ error: transient })

      const first = await runUnreadWatchdogScan({ db, pokeFn: failing.fn })

      expect(first).toEqual({ examined: 1, alerted: 0, retrying: 1 })
      expect(alertedAt(db, messageId)).toBeNull()

      // ...and a later sweep, once the sender has gone quiet, lands it.
      const ok = recorder()
      const second = await runUnreadWatchdogScan({ db, pokeFn: ok.fn })

      expect(second).toEqual({ examined: 1, alerted: 1, retrying: 0 })
      expect(ok.calls[0].target).toBe('A')
      expect(alertedAt(db, messageId)).not.toBeNull()
    })
  }

  it('stops retrying a transient failure once the window closes', async () => {
    const { db, messageId } = await sentAndExpired()
    const failing = recorder({ error: 'guard_failed' })

    const out = await runUnreadWatchdogScan({
      db,
      pokeFn: failing.fn,
      now: () => Date.now() + ALERT_RETRY_WINDOW_MS + 60_000,
    })

    expect(out).toEqual({ examined: 1, alerted: 0, retrying: 0 })
    expect(alertedAt(db, messageId)).not.toBeNull()
  })

  it('treats a thrown dispatch as terminal', async () => {
    const { db, messageId } = await sentAndExpired()
    let calls = 0

    const out = await runUnreadWatchdogScan({
      db,
      pokeFn: async () => { calls += 1; throw new Error('boom') },
    })

    expect(out).toEqual({ examined: 1, alerted: 0, retrying: 0 })
    expect(calls).toBe(1)
    expect(alertedAt(db, messageId)).not.toBeNull()
  })

  it('keeps the row claimed while the alert is in flight', async () => {
    const { db, messageId } = await sentAndExpired()
    let claimedDuringPoke: string | null = 'unset'

    await runUnreadWatchdogScan({
      db,
      pokeFn: async () => {
        // A concurrent sweep must find this row already taken, which is what
        // makes double-alerting impossible even though the claim is released
        // again on a transient failure.
        claimedDuringPoke = alertedAt(db, messageId)
        return { error: 'guard_failed' }
      },
    })

    expect(claimedDuringPoke).not.toBeNull()
    expect(alertedAt(db, messageId)).toBeNull()
  })

  it('still alerts for a deadline that elapsed while the daemon was down', async () => {
    const ctx = setup()
    cleanups.push(ctx.cleanup)
    insertAgent(ctx.db, { agent_id: 'A', name: 'alice', team: 'alpha' })
    insertAgent(ctx.db, { agent_id: 'B', name: 'bob', team: 'alpha' })
    const sent = await ctx.send.send({
      from: 'A', to_agent_id: 'B', body: 'q', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')

    // Nothing in memory carries the schedule: the row alone is the state, and
    // the scan runs long after the deadline as a fresh process would.
    const rec = recorder()
    const out = await runUnreadWatchdogScan({
      db: ctx.db,
      pokeFn: rec.fn,
      now: () => Date.now() + ACK_DEADLINE_MS + 60_000,
    })

    expect(out.alerted).toBe(1)
    expect(rec.calls[0].target).toBe('A')
  })

  it('recovers a pending deadline from disk after the process handle is gone', async () => {
    const dir = tmp()
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'data.db')

    // First "process": arm a watchdog, then drop every handle it held.
    const first = openDb(path)
    applySchema(first)
    insertAgent(first, { agent_id: 'A', name: 'alice', team: 'alpha' })
    insertAgent(first, { agent_id: 'B', name: 'bob', team: 'alpha' })
    const send = new SendMessageService(
      first, new AgentsRepo(first), new EventsOutbox(first), { poke: async () => ({ ok: true }) }
    )
    // Warm-up traffic, then park B's cursor on it. A registered agent that has
    // seen any traffic has a non-zero cursor, and this test needs that shape:
    // applySchema's watermark migration rewrites a cursor still sitting at 0.
    const warmup = await send.send({
      from: 'A', to_agent_id: 'B', body: 'warmup', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in warmup) throw new Error('expected success')
    first.prepare(`UPDATE agents SET last_processed_event_id=? WHERE agent_id='B'`)
      .run(warmup.event_id)

    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'q', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')
    first.close()

    // Second "process": nothing in memory survived, only the row on disk.
    const second = openDb(path)
    applySchema(second)
    const rec = recorder()
    const out = await runUnreadWatchdogScan({
      db: second, pokeFn: rec.fn, now: () => Date.now() + ACK_DEADLINE_MS + 1000,
    })

    expect(out.alerted).toBe(1)
    expect(rec.calls[0].target).toBe('A')
    second.close()
  })

  it('reaches the real dispatcher when no poke seam is injected', async () => {
    const { db, messageId } = await sentAndExpired()
    // The sender has delivery kind 'none' and no pane, so the production
    // dispatcher has nowhere to write — the scan must survive that, not throw.
    const out = await runUnreadWatchdogScan({ db })

    expect(out).toEqual({ examined: 1, alerted: 0, retrying: 0 })
    expect(alertedAt(db, messageId)).not.toBeNull()
  })

  it('ignores rows that were never armed', async () => {
    const ctx = setup()
    cleanups.push(ctx.cleanup)
    insertAgent(ctx.db, { agent_id: 'A', name: 'alice' })
    insertAgent(ctx.db, { agent_id: 'B', name: 'bob' })
    await ctx.send.send({
      from: 'A', to_agent_id: 'B', body: 'fyi', need_reply: false, auto_poke: false, await_ack_s: 0,
    })
    const rec = recorder()

    const out = await runUnreadWatchdogScan({
      db: ctx.db, pokeFn: rec.fn, now: () => Date.now() + ACK_DEADLINE_MS * 10,
    })

    expect(out).toEqual({ examined: 0, alerted: 0, retrying: 0 })
  })
})

describe('transient-set-writes-nothing', () => {
  it('never treats a content-writing poke failure as retryable', () => {
    // A retry re-sends the whole alert text, so admitting a reason that left
    // the text in the pane would put a SECOND copy there — and nothing else
    // would notice: `alerted` still counts 1 and every other test stays green.
    // pokeWroteContent is the repo's own predicate for "did this leave
    // content"; these are the reasons it answers yes to.
    for (const reason of CONTENT_WRITING_POKE_FAILURES) {
      expect(
        TRANSIENT_ALERT_FAILURES.has(reason),
        `${reason} leaves the alert text in the pane and must not be retried`,
      ).toBe(false)
    }
  })

  it('agrees with pokeWroteContent about its own members', () => {
    // Ties the set to the predicate rather than to a hand-copied list: if
    // pokeWroteContent ever starts reporting a member as having written
    // content, this fails instead of silently allowing a duplicate alert.
    for (const reason of TRANSIENT_ALERT_FAILURES) {
      expect(
        pokeWroteContent({ error: reason }),
        `${reason} must be provably content-free to be retryable`,
      ).toBe(false)
    }
  })

  it('confirms the excluded reasons really are content-writing', () => {
    // Guards the exclusion list itself: if these ever stop writing content,
    // the exclusion becomes stale rather than protective.
    expect(pokeWroteContent({ error: 'ownership_lost' })).toBe(true)
    expect(pokeWroteContent({ error: 'tmux_cmd_failed', detail: { stage: 'send_keys' } })).toBe(true)
    expect(pokeWroteContent({ error: 'tmux_cmd_failed', detail: { stage: 'capture_after' } })).toBe(true)
  })
})

describe('watchdog runner gate', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.forEach(c => c()); cleanups.length = 0 })

  async function armed() {
    const ctx = setup()
    cleanups.push(ctx.cleanup)
    insertAgent(ctx.db, { agent_id: 'A', name: 'alice', team: 'alpha' })
    insertAgent(ctx.db, { agent_id: 'B', name: 'bob', team: 'alpha' })
    const sent = await ctx.send.send({
      from: 'A', to_agent_id: 'B', body: 'q', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')
    expire(ctx.db, sent.message_id)
    return ctx
  }

  it('runs no scan after stop', async () => {
    const { db } = await armed()
    const rec = recorder()
    const runner = createUnreadWatchdogRunner({ db, pokeFn: rec.fn })

    runner.stop()
    const out = await runner.run()

    expect(out).toEqual({ examined: 0, alerted: 0, retrying: 0 })
    expect(rec.calls).toHaveLength(0)
  })

  it('does not let two rounds overlap', async () => {
    const { db } = await armed()
    let inside = 0
    let maxConcurrent = 0
    const runner = createUnreadWatchdogRunner({
      db,
      pokeFn: async () => {
        inside += 1
        maxConcurrent = Math.max(maxConcurrent, inside)
        await new Promise(r => setTimeout(r, 50))
        inside -= 1
        return { ok: true, transport_used: 'claude-channel', channel_session_id: 'cs' }
      },
    })

    const [first, second] = await Promise.all([runner.run(), runner.run()])

    expect(maxConcurrent).toBe(1)
    // Exactly one round did the work; the other bailed at the gate.
    expect([first.alerted, second.alerted].sort()).toEqual([0, 1])
  })

  it('is independent per runner so one daemon closing cannot mute another', async () => {
    const { db } = await armed()
    const rec = recorder()
    const stopped = createUnreadWatchdogRunner({ db, pokeFn: rec.fn })
    stopped.stop()
    await stopped.run()

    const fresh = createUnreadWatchdogRunner({ db, pokeFn: rec.fn })
    const out = await fresh.run()

    expect(out.alerted).toBe(1)
  })
})

describe('unread alert text', () => {
  it('announces itself as an alert rather than new mail', () => {
    const text = buildUnreadAlert({
      recipientName: 'bob', recipientTeam: 'alpha', subject: 'ping', skipReason: null,
    })
    expect(text).toContain('不是新邮件')
    expect(text).toContain('无需调 get_inbox')
    expect(text).not.toContain('新邮件 from')
  })

  it('names the recipient and the stall', () => {
    const text = buildUnreadAlert({
      recipientName: 'bob', recipientTeam: 'alpha', subject: 'ping', skipReason: null,
    })
    expect(text).toContain('bob@alpha')
    expect(text).toContain('15 分钟未被读取')
  })

  it('names which message stalled', () => {
    const text = buildUnreadAlert({
      recipientName: 'bob', recipientTeam: 'alpha', subject: 'deploy review', skipReason: null,
    })
    // A sender with several messages outstanding to the same recipient cannot
    // act on an alert that does not say which one.
    expect(text).toContain('deploy review')
  })

  it('marks an absent subject explicitly', () => {
    for (const subject of [null, '']) {
      const text = buildUnreadAlert({
        recipientName: 'bob', recipientTeam: 'alpha', subject, skipReason: null,
      })
      expect(text).toContain('(无 subject)')
    }
  })

  it('carries the last skip reason', () => {
    const text = buildUnreadAlert({
      recipientName: 'bob', recipientTeam: 'alpha', subject: 'ping', skipReason: 'pane_reassigned',
    })
    expect(text).toContain('pane_reassigned')
  })

  it('states an absent skip reason explicitly instead of omitting it', () => {
    const text = buildUnreadAlert({
      recipientName: 'bob', recipientTeam: 'alpha', subject: 'ping', skipReason: null,
    })
    expect(text).toContain('无 skip reason')
  })

  it('never carries the message body', async () => {
    const ctx = setup()
    insertAgent(ctx.db, { agent_id: 'A', name: 'alice', team: 'alpha' })
    insertAgent(ctx.db, { agent_id: 'B', name: 'bob', team: 'alpha' })
    const sent = await ctx.send.send({
      from: 'A', to_agent_id: 'B', subject: 'ping', body: 'secret-payload',
      auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')
    ctx.db.prepare(`UPDATE messages SET ack_deadline_at=? WHERE id=?`)
      .run(new Date(Date.now() - 1000).toISOString(), sent.message_id)
    const rec = recorder()

    await runUnreadWatchdogScan({ db: ctx.db, pokeFn: rec.fn })

    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0].prompt).not.toContain('secret-payload')
    ctx.cleanup()
  })
})

describe('get_delivery_status read field', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.forEach(c => c()); cleanups.length = 0 })

  it('reports read once the recipient cursor advances', async () => {
    const { db, send, inbox, status, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })
    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
    if ('error' in sent) throw new Error('expected success')

    const before = status.get({ caller: 'A', message_id: sent.message_id })
    if ('error' in before) throw new Error('expected status')
    expect(before.statuses[0].read).toBe(false)

    inbox.get({ caller: 'B' })
    const after = status.get({ caller: 'A', message_id: sent.message_id })
    if ('error' in after) throw new Error('expected status')
    expect(after.statuses[0].read).toBe(true)
  })

  it('reports a delivered wake status as still unread', async () => {
    const { db, send, status, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B', tmux_pane_id: '%2' })
    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi' })
    if ('error' in sent) throw new Error('expected success')

    const out = status.get({ caller: 'A', message_id: sent.message_id })
    if ('error' in out) throw new Error('expected status')
    expect(out.statuses[0]).toMatchObject({ wake_status: 'delivered', read: false })
  })

  it('reports unread when the recipient row is gone', async () => {
    const { db, send, status, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })
    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
    if ('error' in sent) throw new Error('expected success')
    db.prepare(`DELETE FROM agents WHERE agent_id='B'`).run()

    const out = status.get({ caller: 'A', message_id: sent.message_id })
    if ('error' in out) throw new Error('expected status')
    expect(out.statuses[0].read).toBe(false)
  })
})
