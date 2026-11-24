import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { clearAllKimiRetries } from '../src/mcp/kimi-poke-retry.js'
import { restoreAgyRetries } from '../src/mcp/restore-agy-retries.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { applySchema } from '../src/storage/schema.js'
import { insertAgent } from './helpers/insert-agent.js'

it('restores pending launcher retries at the original deadline', async () => {
  vi.useFakeTimers()
  const db = openDb(':memory:')
  try {
    applySchema(db)
    for (const agent_id of ['sender', 'reader']) {
      insertAgent(db, { agent_id, name: agent_id, team: 'team', role: 'dev' })
    }
    db.prepare(`UPDATE agents SET agent_type='antigravity',
      delivery_kind='antigravity-pty', delivery_payload=? WHERE agent_id='reader'`)
      .run(JSON.stringify({ launch_id: randomUUID() }))
    const svc = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db),
      { poke: async () => ({ ok: false, reason: 'agy_busy' }) })
    const sent = await svc.send({ from: 'sender', to_agent_id: 'reader', body: 'hello' })
    expect(sent).toMatchObject({ poked: false, retry_scheduled: true })
    clearAllKimiRetries()
    vi.advanceTimersByTime(20_000)
    const poke = vi.fn(async () => ({ ok: false, reason: 'inbox_only' } as const))
    restoreAgyRetries(db, poke)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(poke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(poke).toHaveBeenCalledTimes(1)
    expect(db.prepare('SELECT * FROM message_delivery_status').get()).toMatchObject({
      agent_id: 'reader', wake_status: 'skipped', skip_reason: 'inbox_only',
      retry_attempts: 1,
    })
  } finally {
    clearAllKimiRetries()
    db.close()
    vi.useRealTimers()
  }
})
