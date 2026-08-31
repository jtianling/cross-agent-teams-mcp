import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService, type AutoPokeFn } from '../src/mcp/send-message.js'
import { BroadcastService } from '../src/mcp/broadcast.js'
import { BroadcastToRoleService } from '../src/mcp/broadcast-to-role.js'
import { GetInboxService } from '../src/mcp/get-inbox.js'
import { isMessageRead } from '../src/mcp/message-read.js'
import { ACK_DEADLINE_MS } from '../src/mcp/unread-watchdog.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-ack-send-'))

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
    broadcast: new BroadcastService(db, agents, { poke }),
    broadcastToRole: new BroadcastToRoleService(db, agents, events, { poke }),
    inbox: new GetInboxService(db, agents),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function ackRow(db: ReturnType<typeof setup>['db'], id: string) {
  return db.prepare(
    `SELECT sent_at, ack_deadline_at, ack_alerted_at FROM messages WHERE id=?`
  ).get(id) as { sent_at: string; ack_deadline_at: string | null; ack_alerted_at: string | null }
}

describe('read predicate', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.forEach(c => c()); cleanups.length = 0 })

  it('flips only once the recipient cursor passes the event id', async () => {
    const { db, send, inbox, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
    if ('error' in sent) throw new Error('expected success')
    expect(isMessageRead(db, sent.message_id, 'B')).toBe(false)

    inbox.get({ caller: 'B' })
    expect(isMessageRead(db, sent.message_id, 'B')).toBe(true)
  })

  it('reads false when the recipient row is gone', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
    if ('error' in sent) throw new Error('expected success')
    db.prepare(`DELETE FROM agents WHERE agent_id='B'`).run()

    expect(isMessageRead(db, sent.message_id, 'B')).toBe(false)
  })

  it('stays false for a delivered wake status that nobody consumed', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B', tmux_pane_id: '%2' })

    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi' })
    if ('error' in sent) throw new Error('expected success')
    expect(sent.poked).toBe(true)
    expect(isMessageRead(db, sent.message_id, 'B')).toBe(false)
  })
})

describe('await_ack', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.forEach(c => c()); cleanups.length = 0 })

  it('returns read when the recipient reads inside the window', async () => {
    const { db, send, inbox, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    setTimeout(() => { inbox.get({ caller: 'B' }) }, 300)
    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false, await_ack_s: 5,
    })
    if ('error' in sent) throw new Error('expected success')
    expect(sent.ack.status).toBe('read')
    expect(sent.ack.waited_ms).toBeLessThan(5000)
  })

  it('returns not_yet after waiting the full window', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false, await_ack_s: 1,
    })
    if ('error' in sent) throw new Error('expected success')
    expect(sent.ack.status).toBe('not_yet')
    expect(sent.ack.waited_ms).toBeGreaterThanOrEqual(1000)
  })

  it('performs no wait when the window is zero', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const started = Date.now()
    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')
    expect(sent.ack).toEqual({ status: 'not_yet', waited_ms: 0 })
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('leaves every pre-existing response field intact', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B', tmux_pane_id: '%2' })

    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi' })
    if ('error' in sent) throw new Error('expected success')
    expect(sent).toMatchObject({
      recipients: ['B'],
      poked: true,
      retry_scheduled: false,
    })
    expect(typeof sent.message_id).toBe('string')
    expect(typeof sent.event_id).toBe('number')
  })

  it('keeps the mailbox row after an expired wait', async () => {
    const { db, send, inbox, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'still-here', auto_poke: false, await_ack_s: 1,
    })
    if ('error' in sent) throw new Error('expected success')
    expect(sent.ack.status).toBe('not_yet')

    const seen = inbox.get({ caller: 'B' })
    expect(seen.messages.map(m => m.body)).toContain('still-here')
  })
})

describe('watchdog arming', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { cleanups.forEach(c => c()); cleanups.length = 0 })

  it('arms a 15 minute deadline for a reply-expecting private send', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'q', auto_poke: false })
    if ('error' in sent) throw new Error('expected success')
    const row = ackRow(db, sent.message_id)
    expect(row.ack_deadline_at).not.toBeNull()
    expect(Date.parse(row.ack_deadline_at!) - Date.parse(row.sent_at)).toBe(ACK_DEADLINE_MS)
  })

  it('leaves the deadline null for a no-reply send', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'fyi', need_reply: false, auto_poke: false,
    })
    if ('error' in sent) throw new Error('expected success')
    expect(ackRow(db, sent.message_id).ack_deadline_at).toBeNull()
  })

  it('arms independently of auto_poke', async () => {
    const { db, send, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })

    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'q', auto_poke: false,
    })
    if ('error' in sent) throw new Error('expected success')
    expect(ackRow(db, sent.message_id).ack_deadline_at).not.toBeNull()
  })

  it('changes nothing about delivery besides the deadline', async () => {
    const dir = tmp()
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const calls: Array<Record<string, unknown>> = []
    const poke: AutoPokeFn = async (args) => {
      calls.push({ team: args.team, target: args.targetAgentId, pane: args.paneId, body: args.body })
      return { ok: true }
    }
    const send = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db), { poke })
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B', tmux_pane_id: '%2' })

    const withReply = await send.send({ from: 'A', to_agent_id: 'B', body: 'same' })
    const withoutReply = await send.send({ from: 'A', to_agent_id: 'B', body: 'same', need_reply: false })
    if ('error' in withReply || 'error' in withoutReply) throw new Error('expected success')

    // Identical dispatch treatment...
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(calls[1])
    expect(withReply.poked).toBe(withoutReply.poked)
    expect(withReply.retry_scheduled).toBe(withoutReply.retry_scheduled)
    expect(withReply.poke_skip_reasons).toEqual(withoutReply.poke_skip_reasons)

    // ...and identical wake delivery status.
    const statusOf = (id: string) => db.prepare(
      `SELECT wake_status, skip_reason, retry_attempts FROM message_delivery_status WHERE message_id=?`
    ).get(id)
    expect(statusOf(withReply.message_id)).toEqual(statusOf(withoutReply.message_id))

    // The deadline is the only divergence.
    expect(ackRow(db, withReply.message_id).ack_deadline_at).not.toBeNull()
    expect(ackRow(db, withoutReply.message_id).ack_deadline_at).toBeNull()
  })

  it('never arms a broadcast row', async () => {
    const { db, broadcast, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B' })
    insertAgent(db, { agent_id: 'C', name: 'C' })

    await broadcast.broadcast({ from: 'A', body: 'all-hands', auto_poke: false })
    const rows = db.prepare(`SELECT ack_deadline_at FROM messages`).all() as Array<{ ack_deadline_at: string | null }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.ack_deadline_at === null)).toBe(true)
  })

  it('never arms a broadcast_to_role row', async () => {
    const { db, broadcastToRole, cleanup } = setup()
    cleanups.push(cleanup)
    insertAgent(db, { agent_id: 'A', name: 'A' })
    insertAgent(db, { agent_id: 'B', name: 'B', role: 'worker' })

    await broadcastToRole.broadcast({ from: 'A', to_role: 'worker', body: 'status', auto_poke: false })
    const rows = db.prepare(`SELECT ack_deadline_at FROM messages`).all() as Array<{ ack_deadline_at: string | null }>
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.ack_deadline_at === null)).toBe(true)
  })
})
