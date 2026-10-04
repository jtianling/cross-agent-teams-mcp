import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo, type IdentityKeyMatch } from '../src/storage/agents-repo.js'
import {
  RegisterAgentService,
  planIdentityKeyBinding,
} from '../src/mcp/register-agent.js'
import { isAlive } from '../src/daemon/pid.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-reg-identity-key-'))

// Above any plausible pid_max, so process.kill(pid, 0) reliably reports ESRCH.
const DEAD_PID = 99_999_999

function holder(overrides: Partial<IdentityKeyMatch> = {}): IdentityKeyMatch {
  return {
    agent_id: 'old-id',
    device: 'local',
    team: 'aoe',
    name: 'tester',
    role: 'worker',
    runtime_ui_pid: null,
    last_seen_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('process liveness probe', () => {
  it('reports the current process alive', () => {
    expect(isAlive(process.pid)).toBe(true)
  })

  it('reports an unused pid dead', () => {
    expect(isAlive(DEAD_PID)).toBe(false)
  })

  it('treats EPERM as alive', () => {
    // pid 1 (launchd/init) exists but is not signalable by a normal user.
    expect(isAlive(1)).toBe(true)
  })
})

describe('planIdentityKeyBinding', () => {
  it('binds when nobody holds the key', () => {
    expect(planIdentityKeyBinding({
      holder: undefined,
      target: { team: 'aoe', name: 'tester' },
    })).toEqual({ kind: 'bind' })
  })

  it('binds when the holder is the row being registered', () => {
    expect(planIdentityKeyBinding({
      holder: holder({ runtime_ui_pid: process.pid }),
      target: { team: 'aoe', name: 'tester' },
    })).toEqual({ kind: 'bind' })
  })

  it('migrates when the holder has no pid', () => {
    expect(planIdentityKeyBinding({
      holder: holder(),
      target: { team: 'aoe', name: 'reviewer' },
    })).toEqual({ kind: 'migrate', from_agent_id: 'old-id' })
  })

  it('migrates when the holder pid is this very call', () => {
    expect(planIdentityKeyBinding({
      holder: holder({ runtime_ui_pid: process.pid }),
      target: { team: 'aoe', name: 'reviewer' },
      ui_pid: process.pid,
    })).toEqual({ kind: 'migrate', from_agent_id: 'old-id' })
  })

  it('migrates when the holder pid is gone', () => {
    expect(planIdentityKeyBinding({
      holder: holder({ runtime_ui_pid: DEAD_PID }),
      target: { team: 'aoe', name: 'reviewer' },
      ui_pid: 4242,
    })).toEqual({ kind: 'migrate', from_agent_id: 'old-id' })
  })

  it('conflicts when the holder pid is another live process', () => {
    expect(planIdentityKeyBinding({
      holder: holder({ runtime_ui_pid: process.pid }),
      target: { team: 'aoe', name: 'second' },
      ui_pid: 4242,
    })).toEqual({
      error: 'identity_key_conflict',
      detail: { team: 'aoe', name: 'tester' },
    })
  })

  it('uses the injected liveness probe when supplied', () => {
    const plan = planIdentityKeyBinding({
      holder: holder({ runtime_ui_pid: 7 }),
      target: { team: 'aoe', name: 'reviewer' },
      isProcessAlive: () => false,
    })
    expect(plan).toEqual({ kind: 'migrate', from_agent_id: 'old-id' })
  })
})

describe('register_agent identity_key four-branch binding', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function setup() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, repo: new AgentsRepo(db), svc: new RegisterAgentService(db) }
  }

  function register(
    svc: RegisterAgentService,
    args: {
      connection_id?: string
      name: string
      identity_key?: string
      runtime_ui_pid?: number
    }
  ) {
    return svc.register({
      connection_id: args.connection_id ?? `conn-${args.name}`,
      agent_type: 'claude-code',
      name: args.name,
      team: 'aoe',
      role: 'worker',
      identity_key: args.identity_key,
      runtime_ui_pid: args.runtime_ui_pid,
    })
  }

  it('branch 1 — an unbound key is written onto the new row', () => {
    const { db, repo, svc } = setup()
    const res = register(svc, { name: 'tester', identity_key: 'K' })
    expect('agent_id' in res).toBe(true)
    const agentId = (res as { agent_id: string }).agent_id
    expect(repo.getById(agentId)?.identity_key).toBe('K')
    db.close()
  })

  it('branch 2 — re-registering the same identity is idempotent', () => {
    const { db, repo, svc } = setup()
    const first = register(svc, { name: 'tester', identity_key: 'K' })
    const again = register(svc, { name: 'tester', identity_key: 'K' })
    const firstId = (first as { agent_id: string }).agent_id
    expect((again as { agent_id: string }).agent_id).toBe(firstId)
    expect(repo.getById(firstId)?.identity_key).toBe('K')
    db.close()
  })

  it('branch 3 — a rename off a dead pid migrates the key and clears the old row', () => {
    const { db, repo, svc } = setup()
    const first = register(svc, {
      name: 'tester',
      identity_key: 'K',
      runtime_ui_pid: DEAD_PID,
    })
    const renamed = register(svc, {
      name: 'reviewer',
      identity_key: 'K',
      runtime_ui_pid: 4242,
    })
    const oldId = (first as { agent_id: string }).agent_id
    const newId = (renamed as { agent_id: string }).agent_id
    expect(newId).not.toBe(oldId)
    expect(repo.getById(oldId)?.identity_key).toBeNull()
    expect(repo.getById(newId)?.identity_key).toBe('K')
    const matches = repo.findByIdentityKey('K', 'local')
    expect(matches.map(m => m.name)).toEqual(['reviewer'])
    db.close()
  })

  it('branch 3 — a rename from the same live pid migrates rather than conflicts', () => {
    const { db, repo, svc } = setup()
    const first = register(svc, {
      name: 'tester',
      identity_key: 'K',
      runtime_ui_pid: process.pid,
    })
    const renamed = register(svc, {
      name: 'reviewer',
      identity_key: 'K',
      runtime_ui_pid: process.pid,
    })
    expect('agent_id' in renamed).toBe(true)
    expect(repo.getById((first as { agent_id: string }).agent_id)?.identity_key)
      .toBeNull()
    expect(
      repo.getById((renamed as { agent_id: string }).agent_id)?.identity_key
    ).toBe('K')
    db.close()
  })

  it('branch 3 — a rename off a row with no pid migrates', () => {
    const { db, repo, svc } = setup()
    register(svc, { name: 'tester', identity_key: 'K' })
    const renamed = register(svc, { name: 'reviewer', identity_key: 'K' })
    expect(
      repo.getById((renamed as { agent_id: string }).agent_id)?.identity_key
    ).toBe('K')
    db.close()
  })

  it('branch 4 — a live other holder is rejected and nothing is written', () => {
    const { db, repo, svc } = setup()
    const first = register(svc, {
      name: 'tester',
      identity_key: 'K',
      runtime_ui_pid: process.pid,
    })
    const before = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as {
      c: number
    }

    const conflict = register(svc, {
      name: 'second',
      identity_key: 'K',
      runtime_ui_pid: 4242,
    })
    expect(conflict).toEqual({
      error: 'identity_key_conflict',
      detail: { team: 'aoe', name: 'tester' },
    })

    const after = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as {
      c: number
    }
    expect(after.c).toBe(before.c)
    expect(repo.findByIdentityKey('K', 'local').map(m => m.name))
      .toEqual(['tester'])
    expect(repo.getById((first as { agent_id: string }).agent_id)?.identity_key)
      .toBe('K')
    db.close()
  })

  it('omitting the key preserves the one already on the row', () => {
    const { db, repo, svc } = setup()
    const first = register(svc, { name: 'tester', identity_key: 'K' })
    register(svc, { name: 'tester' })
    expect(repo.getById((first as { agent_id: string }).agent_id)?.identity_key)
      .toBe('K')
    db.close()
  })

  it('omitting the key leaves pre-existing registration behaviour unchanged', () => {
    const { db, repo, svc } = setup()
    const first = register(svc, { name: 'tester', runtime_ui_pid: 100 })
    const second = register(svc, { name: 'tester', runtime_ui_pid: 200 })
    const firstId = (first as { agent_id: string }).agent_id
    expect((second as { agent_id: string }).agent_id).toBe(firstId)
    expect(repo.getById(firstId)?.identity_key).toBeNull()
    expect(repo.findByRuntimeUiPid(200, 'local').map(m => m.agent_id))
      .toEqual([firstId])
    db.close()
  })

  it('scopes the lookup to the caller device', () => {
    const { db, repo, svc } = setup()
    repo.register({
      agent_type: 'claude-code',
      device: 'gx',
      name: 'remote',
      team: 'aoe',
      identity_key: 'K',
      runtime_ui_pid: process.pid,
    })
    const res = register(svc, { name: 'tester', identity_key: 'K' })
    expect('agent_id' in res).toBe(true)
    expect(repo.getById((res as { agent_id: string }).agent_id)?.identity_key)
      .toBe('K')
    db.close()
  })
})
