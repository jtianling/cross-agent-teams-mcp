import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { startServer } from '../src/daemon/server.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-wd-wiring-'))

/**
 * The scan function is covered directly elsewhere; what these cover is the glue
 * in buildServer.  Without it the "survives a daemon restart" guarantee rests
 * on a mount nothing ever exercises: a scan that is never scheduled fails
 * exactly as silently as the in-memory schedule it replaced.
 */
describe('unread watchdog daemon wiring', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  /** Seeds a due, unread, reply-expecting message and closes the handle. */
  async function seedDueMessage(dbPath: string): Promise<string> {
    const db = openDb(dbPath)
    applySchema(db)
    insertAgent(db, { agent_id: 'A', name: 'alice', team: 'alpha' })
    insertAgent(db, { agent_id: 'B', name: 'bob', team: 'alpha' })
    const send = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db), {
      poke: async () => ({ ok: true }),
    })
    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'q', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')
    db.prepare(`UPDATE messages SET ack_deadline_at=? WHERE id=?`)
      .run(new Date(Date.now() - 1000).toISOString(), sent.message_id)
    // Park B's cursor on real traffic: applySchema rewrites a cursor still at 0.
    db.prepare(`UPDATE agents SET last_processed_event_id=? WHERE agent_id='B'`)
      .run(sent.event_id - 1)
    db.close()
    return sent.message_id
  }

  function alertedAt(dbPath: string, messageId: string): string | null {
    const db = openDb(dbPath)
    const row = db.prepare(`SELECT ack_alerted_at FROM messages WHERE id=?`)
      .get(messageId) as { ack_alerted_at: string | null } | undefined
    db.close()
    return row?.ack_alerted_at ?? null
  }

  it('runs a scan at startup so a deadline that elapsed while down is examined', async () => {
    const dir = tmp(); dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const messageId = await seedDueMessage(dbPath)
    expect(alertedAt(dbPath, messageId)).toBeNull()

    const { app } = await startServer({ dbPath, port: 0, unreadWatchdogIntervalMs: 3_600_000 })
    // The interval is an hour out, so anything observed here came from the
    // immediate startup run, not from a tick.
    await new Promise(r => setTimeout(r, 200))
    await app.close()

    expect(alertedAt(dbPath, messageId)).not.toBeNull()
  })

  it('keeps sweeping on the configured interval', async () => {
    const dir = tmp(); dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app } = await startServer({ dbPath, port: 0, unreadWatchdogIntervalMs: 60 })

    // Seeded AFTER startup, so only a later tick can pick it up.
    const db = openDb(dbPath)
    insertAgent(db, { agent_id: 'A', name: 'alice', team: 'alpha' })
    insertAgent(db, { agent_id: 'B', name: 'bob', team: 'alpha' })
    const send = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db), {
      poke: async () => ({ ok: true }),
    })
    const sent = await send.send({
      from: 'A', to_agent_id: 'B', body: 'q', auto_poke: false, await_ack_s: 0,
    })
    if ('error' in sent) throw new Error('expected success')
    db.prepare(`UPDATE messages SET ack_deadline_at=? WHERE id=?`)
      .run(new Date(Date.now() - 1000).toISOString(), sent.message_id)
    db.close()

    await new Promise(r => setTimeout(r, 500))
    await app.close()

    expect(alertedAt(dbPath, sent.message_id)).not.toBeNull()
  })

  it('emits no alert for work that arrives after the server closed', async () => {
    const dir = tmp(); dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app } = await startServer({ dbPath, port: 0, unreadWatchdogIntervalMs: 60 })
    await app.close()

    const messageId = await seedDueMessage(dbPath)
    await new Promise(r => setTimeout(r, 400))

    // NOTE ON WHAT THIS DOES NOT PROVE: it pins the observable outcome, not the
    // mechanism.  `app.close()` also closes the database, so a tick that
    // survived shutdown would throw on its first statement and be swallowed by
    // the runner's `.catch()`, leaving the row unclaimed either way — this
    // assertion would still hold with the onClose gate deleted.  The gate
    // itself is covered where it can actually fail: `watchdog runner gate >
    // runs no scan after stop` in message-read-ack-watchdog.test.ts.
    expect(alertedAt(dbPath, messageId)).toBeNull()
  })
})
