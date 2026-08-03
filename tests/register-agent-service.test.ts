import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-reg-svc-'))
const CODEX_THREAD_A = '11111111-1111-4111-8111-111111111111'
const CODEX_THREAD_B = '22222222-2222-4222-8222-222222222222'

function codexDelivery(thread_id: string) {
  return {
    kind: 'codex-appserver' as const,
    thread_id,
    ws_url: 'ws://127.0.0.1:8799',
  }
}

function registerCodex(
  svc: RegisterAgentService,
  connection_id: string,
  thread_id: string
) {
  return svc.register({
    connection_id,
    agent_type: 'codex',
    name: 'alice',
    delivery: codexDelivery(thread_id),
  })
}

describe('RegisterAgentService', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup(deps: ConstructorParameters<typeof RegisterAgentService>[1] = {}) {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, svc: new RegisterAgentService(db, deps) }
  }

  it('same identity with same connection_id succeeds and reuses agent_id', () => {
    const { svc } = setup()
    const r1 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    const r2 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r1 || 'error' in r2) throw new Error('unexpected error')
    expect(r2.agent_id).toBe(r1.agent_id)
  })

  it('same identity different connection_id takes over (no collision error)', () => {
    const closes: string[] = []
    const { svc } = setup({ closeSessionByConnectionId: (cid) => { closes.push(cid); return true } })
    const r1 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    const r2 = svc.register({ connection_id: 'conn-2', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r1) throw new Error('r1 unexpected error')
    if ('error' in r2) throw new Error('r2 unexpected error')
    expect(r2.agent_id).toBe(r1.agent_id)
    expect(closes).toEqual(['conn-1'])
  })

  it('same Codex thread can bind the same identity from two connections', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    const first = registerCodex(svc, 'conn-1', CODEX_THREAD_A)
    const second = registerCodex(svc, 'conn-2', CODEX_THREAD_A)
    if ('error' in first || 'error' in second) {
      throw new Error('unexpected error')
    }
    expect(second.agent_id).toBe(first.agent_id)
    expect(closes).toEqual([])
  })

  it('different Codex thread takes over every connection for the old thread', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    registerCodex(svc, 'conn-1', CODEX_THREAD_A)
    registerCodex(svc, 'conn-2', CODEX_THREAD_A)
    expect(closes).toEqual([])

    registerCodex(svc, 'conn-3', CODEX_THREAD_B)
    expect([...closes].sort()).toEqual(['conn-1', 'conn-2'])
  })

  it('releasing one Codex connection preserves its same-thread peer', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        closes.push(connectionId)
        return true
      },
    })
    registerCodex(svc, 'conn-1', CODEX_THREAD_A)
    const second = registerCodex(svc, 'conn-2', CODEX_THREAD_A)
    if ('error' in second) throw new Error('unexpected error')

    svc.releaseConnection(second.agent_id, 'conn-2')
    registerCodex(svc, 'conn-3', CODEX_THREAD_B)
    expect(closes).toEqual(['conn-1'])
  })

  it('retains a prior binding when its takeover close callback throws', () => {
    let attempts: string[] = []
    let failFirstClose = true
    let lines: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: (connectionId) => {
        attempts = [...attempts, connectionId]
        if (failFirstClose) {
          failFirstClose = false
          throw new Error('close failed')
        }
        return true
      },
      log: line => { lines = [...lines, line] },
    })
    svc.register({ connection_id: 'conn-1', name: 'alice' })

    const second = svc.register({ connection_id: 'conn-2', name: 'alice' })
    expect('error' in second).toBe(false)
    expect(lines.some(line => line.includes('close failed'))).toBe(true)

    svc.register({ connection_id: 'conn-3', name: 'alice' })
    expect(attempts).toEqual(['conn-1', 'conn-1', 'conn-2'])
  })

  it('reports the close error when the configured logger also throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const closeError = new Error('close failed')
    const logError = new Error('log failed')
    const { svc } = setup({
      closeSessionByConnectionId: () => { throw closeError },
      log: () => { throw logError },
    })
    svc.register({ connection_id: 'conn-1', name: 'alice' })

    svc.register({ connection_id: 'conn-2', name: 'alice' })

    expect(consoleError).toHaveBeenCalledWith(
      'RegisterAgentService logger failed.',
      logError
    )
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('close failed'),
      closeError
    )
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('register_agent takeover: old=conn-1')
    )
    consoleError.mockRestore()
  })

  it('same identity different connection succeeds after releaseConnection', () => {
    const { svc } = setup()
    const r1 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r1) throw new Error('r1 unexpected error')
    svc.releaseConnection(r1.agent_id, 'conn-1')
    const r2 = svc.register({ connection_id: 'conn-2', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r2) throw new Error('r2 unexpected error')
    expect(r2.agent_id).toBe(r1.agent_id)
  })

  it('different identities on separate connections both succeed', () => {
    const { svc } = setup()
    const r1 = svc.register({ connection_id: 'conn-1', model: 'm', role: 'backend', name: 'alice' })
    const r2 = svc.register({ connection_id: 'conn-2', model: 'm', role: 'frontend', name: 'bob' })
    if ('error' in r1 || 'error' in r2) throw new Error('unexpected error')
    expect(r2.agent_id).not.toBe(r1.agent_id)
  })

  it('moves one connection ledger entry when it binds another identity', () => {
    const closes: string[] = []
    const { svc } = setup({
      closeSessionByConnectionId: connectionId => {
        closes.push(connectionId)
        return true
      },
    })
    svc.register({ connection_id: 'conn-1', name: 'alice' })
    svc.bindExistingConnection({
      connection_id: 'conn-1',
      agent_type: 'opencode',
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_bob',
        runtime_generation: 1,
      },
      device: 'local',
      team: 'default',
      name: 'bob',
    })

    svc.register({ connection_id: 'conn-2', name: 'alice' })
    expect(closes).toEqual([])
  })

  it('rejects no-generation overwrite of a runtime-aware OpenCode row', () => {
    const { db, svc } = setup()
    const initial = svc.register({
      connection_id: 'conn-1',
      agent_type: 'opencode',
      name: 'open',
      identity_key: 'open-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_current',
        runtime_generation: 2,
      },
    })
    if ('error' in initial) throw new Error('unexpected initial error')
    const before = db.prepare(
      `SELECT register_generation, delivery_payload
       FROM agents WHERE agent_id = ?`
    ).get(initial.agent_id)

    expect(svc.register({
      connection_id: 'conn-2',
      agent_type: 'opencode',
      name: 'open',
      identity_key: 'open-key',
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_current',
      },
    })).toEqual({ error: 'opencode_runtime_coordinates_required' })
    expect(db.prepare(
      `SELECT register_generation, delivery_payload
       FROM agents WHERE agent_id = ?`
    ).get(initial.agent_id)).toEqual(before)
  })

  it('rejects no-generation key migration from a runtime-aware row', () => {
    const { db, svc } = setup()
    const initial = svc.register({
      connection_id: 'conn-1',
      agent_type: 'opencode',
      name: 'open',
      identity_key: 'open-key',
      opencode_runtime_generation: 2,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_current',
        runtime_generation: 2,
      },
    })
    if ('error' in initial) throw new Error('unexpected initial error')

    expect(svc.register({
      connection_id: 'conn-2',
      agent_type: 'opencode',
      name: 'renamed',
      identity_key: 'open-key',
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_current',
      },
    })).toEqual({ error: 'opencode_runtime_coordinates_required' })
    expect(db.prepare(
      `SELECT agent_id, name, identity_key FROM agents ORDER BY name`
    ).all()).toEqual([{
      agent_id: initial.agent_id,
      name: 'open',
      identity_key: 'open-key',
    }])
  })

  it('derives team from project_dir when team is omitted', () => {
    const { svc, db } = setup()
    const result = svc.register({
      connection_id: 'conn-1',
      model: 'm',
      role: 'backend',
      name: 'alice',
      project_dir: '/x/y/cross-agent-teams-mcp',
    })
    if ('error' in result) throw new Error('unexpected error')
    expect(result.team).toBe('cross-agent-teams-mcp')
    const row = db.prepare(
      'SELECT team FROM agents WHERE agent_id=?'
    ).get(result.agent_id) as { team: string }
    expect(row.team).toBe('cross-agent-teams-mcp')
  })

  it('uses explicit team before project_dir', () => {
    const { svc } = setup()
    const result = svc.register({
      connection_id: 'conn-1',
      model: 'm',
      role: 'backend',
      name: 'alice',
      team: 'alpha',
      project_dir: '/x/y/cross-agent-teams-mcp',
    })
    if ('error' in result) throw new Error('unexpected error')
    expect(result.team).toBe('alpha')
  })
})
