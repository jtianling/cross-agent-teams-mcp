import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-agents-delivery-'))

describe('AgentsRepo delivery integration', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function setup() {
    const dir = tmp()
    cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, repo: new AgentsRepo(db) }
  }

  it('register reads back delivery for none, claude-channel, and codex-appserver', () => {
    const { db, repo } = setup()
    const none = repo.register({ model: 'opus', role: 'backend', name: 'none-agent' })
    const claude = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'claude-agent',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-abc' },
    })
    const codex = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'codex-agent',
      delivery: {
        kind: 'codex-appserver',
        thread_id: 'thread-123',
        ws_url: 'wss://example.test/ws',
        auth_token_ref: 'token-ref',
      },
    })

    expect(repo.getById(none.agent_id)?.delivery).toEqual({ kind: 'none' })
    expect(repo.getById(claude.agent_id)?.delivery).toEqual({
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    })
    expect(repo.getById(codex.agent_id)?.delivery).toEqual({
      kind: 'codex-appserver',
      thread_id: 'thread-123',
      ws_url: 'wss://example.test/ws',
      auth_token_ref: 'token-ref',
    })

    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE agent_id=?`
    ).get(claude.agent_id) as {
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      channel_session_id: 'csid-abc',
    })
    db.close()
  })

  it('setDelivery overwrites prior delivery atomically', () => {
    const { db, repo } = setup()
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })

    repo.setDelivery(alice.agent_id, {
      kind: 'claude-channel',
      channel_session_id: 'csid-first',
    })
    repo.setDelivery(alice.agent_id, {
      kind: 'codex-appserver',
      thread_id: 'thread-456',
      ws_url: 'wss://example.test/next',
    })

    expect(repo.getById(alice.agent_id)?.delivery).toEqual({
      kind: 'codex-appserver',
      thread_id: 'thread-456',
      ws_url: 'wss://example.test/next',
    })
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE agent_id=?`
    ).get(alice.agent_id) as {
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.delivery_kind).toBe('codex-appserver')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      thread_id: 'thread-456',
      ws_url: 'wss://example.test/next',
    })
    db.close()
  })

  it('derived channel_session_id follows delivery kind in getById and list', () => {
    const { db, repo } = setup()
    const alice = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'alice',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-xyz' },
    })
    const bob = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'bob',
      delivery: {
        kind: 'codex-appserver',
        thread_id: 'thread-789',
        ws_url: 'wss://example.test/codex',
      },
    })

    expect(repo.getById(alice.agent_id)?.channel_session_id).toBe('csid-xyz')
    expect(repo.getById(bob.agent_id)?.channel_session_id).toBeNull()

    const rows = repo.list({ team: 'default' })
    expect(rows.find(row => row.agent_id === alice.agent_id)?.channel_session_id).toBe(
      'csid-xyz'
    )
    expect(rows.find(row => row.agent_id === bob.agent_id)?.channel_session_id).toBeNull()
    db.close()
  })

  it('guards low-level type and delivery writers for runtime-aware OpenCode', () => {
    const { db, repo } = setup()
    const runtime = repo.register({
      agent_type: 'opencode',
      name: 'runtime-aware',
      identity_key: 'runtime-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:18888',
        session_id: 'ses_runtime',
        runtime_generation: 2,
      },
    })
    const before = repo.getById(runtime.agent_id)

    expect(() => repo.setAgentType(runtime.agent_id, 'claude-code'))
      .toThrow('opencode_runtime_coordinates_required')
    expect(() => repo.setDelivery(runtime.agent_id, {
      kind: 'claude-channel',
      channel_session_id: 'csid-new',
    })).toThrow('opencode_runtime_coordinates_required')
    expect(repo.getById(runtime.agent_id)).toEqual(before)
    db.close()
  })

  it('reactive proxy rebind skips a reserved OpenCode row', () => {
    const { db, repo } = setup()
    const runtime = repo.register({
      agent_type: 'opencode',
      name: 'reserved-runtime',
      team: 'default',
      runtime_ui_pid: 55,
      opencode_runtime_generation: 2,
    })

    repo.register({
      agent_type: 'custom',
      agent_type_name: 'cross-agent-teams-channel',
      model: 'proxy',
      role: '__channel_proxy__',
      name: 'proxy',
      team: 'default',
      claude_ui_pid: 55,
      delivery: {
        kind: 'claude-channel',
        channel_session_id: 'csid-new',
      },
    })

    expect(repo.getById(runtime.agent_id)?.delivery).toEqual({ kind: 'none' })
    expect(repo.getById(runtime.agent_id)?.opencode_runtime_generation).toBe(2)
    db.close()
  })
})
