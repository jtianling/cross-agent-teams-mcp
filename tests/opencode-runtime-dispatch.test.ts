import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { createAutoPokeImpl } from '../src/mcp/tools.js'
import { poke } from '../src/mcp/poke.js'
import { SendMessageService } from '../src/mcp/send-message.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-runtime-dispatch-'))

describe('recovering OpenCode dispatch', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('keeps mailbox writes while blocking the stale endpoint until '
    + 'commit', async () => {
    const dir = tmp()
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db, { localDevice: 'local' })
    const repo = new AgentsRepo(db)
    const sender = repo.register({
      agent_type: 'custom',
      agent_type_name: 'test',
      name: 'sender',
      team: 'dev',
    })
    const target = repo.register({
      agent_type: 'opencode',
      name: 'open',
      team: 'dev',
      identity_key: 'open-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_old',
        runtime_generation: 1,
      },
    })
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await poke(
      { db, callerAgentId: sender.agent_id, localDevice: 'local' },
      { target_agent_id: target.agent_id, prompt: 'wake' }
    )).toEqual({
      error: 'runtime_recovering',
      transport_used: 'opencode-server',
    })
    const send = new SendMessageService(
      db,
      repo,
      new EventsOutbox(db),
      { poke: createAutoPokeImpl(db, repo, undefined, 'local') }
    )
    const recovering = await send.send({
      from: sender.agent_id,
      to_agent_id: target.agent_id,
      body: 'during recovery',
    })
    expect(recovering).toMatchObject({
      poked: false,
      poke_skip_reasons: [
        { agent_id: target.agent_id, reason: 'runtime_recovering' },
      ],
    })
    expect(fetchMock).not.toHaveBeenCalled()
    const mailboxCount = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE to_agent_id = ?`
    ).get(target.agent_id) as { n: number }
    expect(mailboxCount.n).toBe(1)

    const reserved = repo.findOpencodeRuntimeByIdentityKey('open-key', 'local')!
    expect(repo.compareAndSetOpencodeDelivery({
      agent_id: target.agent_id,
      device: 'local',
      identity_key: 'open-key',
      expected_generation: 2,
      expected_register_generation: reserved.register_generation,
      expected_delivery_kind: reserved.delivery_kind,
      expected_delivery_payload: reserved.delivery_payload,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3001',
        session_id: 'ses_new',
        runtime_generation: 2,
      },
    }).changes).toBe(1)
    const restored = await send.send({
      from: sender.agent_id,
      to_agent_id: target.agent_id,
      body: 'after recovery',
    })
    expect(restored).toMatchObject({ poked: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const fetchCalls = fetchMock.mock.calls as unknown[][]
    expect(fetchCalls[0]![0]).toBe(
      'http://127.0.0.1:3001/session/ses_new/prompt_async'
    )
    const finalCount = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE to_agent_id = ?`
    ).get(target.agent_id) as { n: number }
    expect(finalCount.n).toBe(2)
    db.close()
  })
})
