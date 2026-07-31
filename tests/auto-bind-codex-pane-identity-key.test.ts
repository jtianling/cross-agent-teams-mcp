import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import {
  autoBindCodexPane,
  type IdentityKeyAttachDeps,
} from '../src/mcp/auto-bind-codex-pane.js'
import type { IdentityKeyMatch } from '../src/storage/agents-repo.js'
import { BindRuntimeIdentityService } from '../src/mcp/bind-runtime-identity.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-auto-bind-key-'))

interface MockBindSvc {
  verify: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
}

// auto-bind now splits the async verification from the synchronous persist so
// the persist can share the caller's transaction; the stub mirrors that.
function makeBindSvc(result: unknown): MockBindSvc {
  const ok = typeof result === 'object' && result !== null
    && (result as { ok?: boolean }).ok === true
  return {
    verify: vi.fn().mockResolvedValue(
      ok ? { ...(result as object), expectedRegisterGeneration: 1 } : result
    ),
    commit: vi.fn().mockReturnValue({ ok: true }),
  }
}

function seedCaller(
  db: ReturnType<typeof openDb>,
  agentId: string,
  team = 'default',
  name = 'caller'
): void {
  db.prepare(
    `INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, 'local', team, 'impl', name, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
}

describe('autoBindCodexPane identity_key claim arbitration', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  const PROBE_DEPS = {
    listPanes: async () => [{ pane_id: '%10', tty: 'ttys001' }],
    ttyProcesses: async () =>
      ['12345 12345 12345 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'],
  }

  function makeAttachDeps(
    overrides: Partial<IdentityKeyAttachDeps> = {}
  ): IdentityKeyAttachDeps & { applyPlan: ReturnType<typeof vi.fn> } {
    return {
      findCaller: () => ({ team: 'default', name: 'caller', identity_key: null }),
      findByIdentityKey: () => [],
      applyPlan: vi.fn(),
      isProcessAlive: () => false,
      log: vi.fn(),
      ...overrides,
    } as IdentityKeyAttachDeps & { applyPlan: ReturnType<typeof vi.fn> }
  }

  function holderMatch(overrides: Partial<IdentityKeyMatch> = {}): IdentityKeyMatch {
    return {
      agent_id: 'old-row',
      device: 'local',
      team: 'aoe',
      name: 'aoe-codex',
      role: 'default',
      runtime_ui_pid: 777,
      last_seen_at: '2026-01-01T00:00:00Z',
      ...overrides,
    }
  }

  it('migrates the key off a dead holder row', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const attach = makeAttachDeps({
      findByIdentityKey: () => [holderMatch()],
      isProcessAlive: () => false,
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
      },
      PROBE_DEPS
    )
    expect(ok).toBe('bound_consumed')
    expect(attach.applyPlan).toHaveBeenCalledWith(
      { kind: 'migrate', from_agent_id: 'old-row' },
      'caller-1',
      'K1'
    )
  })

  it('disqualifies a row whose key has a LIVE holder of another identity (keyless caller)', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const attach = makeAttachDeps({
      findByIdentityKey: () => [holderMatch()],
      isProcessAlive: () => true,
      log,
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    // A live holder of another identity means the row is that identity's,
    // even when the caller itself is keyless — the row is disqualified, not
    // merely attach-skipped.
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_live_holder_conflict')
    )
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
  })

  it('INCIDENT: a row whose key CONTRADICTS the caller row is neither bound nor consumed', async () => {
    // Live joint-test incident: a codex whose own pre-reg row had expired
    // registered with no same-thread evidence, reached the scan, and the
    // only pending row was ANOTHER pane's (keyed for another identity).
    // The uuid probe proves the PANE's codex, never the CALLER's — so the
    // key contradiction is the only available "this row is not mine"
    // evidence, and it must disqualify the row entirely.
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K2',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const attach = makeAttachDeps({
      findCaller: () => ({ team: 'default', name: 'caller', identity_key: 'K1' }),
      log,
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_contradiction')
    )
    // The row survives for its rightful owner, key intact.
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K2' })
  })

  it('disqualifies a row whose holder is another identity with UNKNOWN liveness (pid-less)', async () => {
    // Lab scenario S1b: the keyless caller reaches a row keyed to another
    // identity whose row records no pid.  A tty/pane bind legitimately has
    // no pid, so "no pid" is liveness UNKNOWN, never dead — candidacy needs
    // positive proof the row is ours (same lesson as seat-follow).
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const attach = makeAttachDeps({
      findByIdentityKey: () => [holderMatch({ runtime_ui_pid: null })],
      log,
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_holder_liveness_unknown')
    )
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
  })

  it('a keyed caller still consumes a KEYLESS row (no contradiction evidence)', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const attach = makeAttachDeps({
      findCaller: () => ({ team: 'default', name: 'caller', identity_key: 'K1' }),
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
      },
      PROBE_DEPS
    )
    expect(ok).toBe('bound_consumed')
    expect(repo.getByPaneId('%10')).toBeUndefined()
  })

  it('a contradicting row is filtered out, leaving the caller own-key row as the unique candidate', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    repo.upsert({
      pane_id: '%11',
      xats_agent_id: 'U2',
      identity_key: 'K2',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const attach = makeAttachDeps({
      findCaller: () => ({ team: 'default', name: 'caller', identity_key: 'K1' }),
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
      },
      {
        listPanes: async () => [
          { pane_id: '%10', tty: 'ttys001' },
          { pane_id: '%11', tty: 'ttys002' },
        ],
        ttyProcesses: async (tty: string) => tty === 'ttys001'
          ? ['12345 12345 12345 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"']
          : ['22222 22222 22222 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U2"'],
      }
    )
    // Without the filter both rows would probe as valid candidates and the
    // "exactly one candidate" rule would bail out, binding nothing.
    expect(ok).toBe('bound_consumed')
    expect(bindSvc.verify).toHaveBeenCalledWith(expect.objectContaining({ ui_pid: 12345 }))
    expect(repo.getByPaneId('%10')).toBeUndefined()
    expect(repo.getByPaneId('%11')).toMatchObject({ identity_key: 'K2' })
  })

  it('re-attaches idempotently when the caller row already holds the same key', async () => {
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const attach = makeAttachDeps({
      findCaller: () => ({ team: 'default', name: 'caller', identity_key: 'K1' }),
      findByIdentityKey: () => [
        holderMatch({ agent_id: 'caller-1', team: 'default', name: 'caller' }),
      ],
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
      },
      PROBE_DEPS
    )
    expect(ok).toBe('bound_consumed')
    expect(attach.applyPlan).toHaveBeenCalledWith({ kind: 'bind' }, 'caller-1', 'K1')
  })

  it('CRITICAL-1 regression: holder pid EQUAL to the candidate pane pid is still foreign', async () => {
    // The candidate pid proves who is on THAT PANE, never who the caller is.
    // Feeding it into the attach-time arbitration made the rule self-exclude
    // exactly when the live foreign holder IS that pane's foreground codex —
    // the most realistic shape of all.
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({ ok: true })
    const log = vi.fn()
    const attach = makeAttachDeps({
      // holder pid === the candidate carrier pid in PROBE_DEPS (12345)
      findByIdentityKey: () => [holderMatch({ runtime_ui_pid: 12345 })],
      isProcessAlive: () => true,
      log,
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_live_holder_conflict')
    )
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
  })

  it('CRITICAL-2 regression: a holder appearing DURING verification never lands a bind at all', async () => {
    // The claim is arbitrated before the verification await, so the rightful
    // owner can take the key inside that window.  The commit — claim re-check,
    // runtime write WITH its incumbent-pane eviction, conditional consume and
    // key attach — is one transaction, so a foreign verdict means the write
    // never happens; there is nothing to compensate for afterwards.
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    let holderAppeared = false
    const bindSvc = {
      verify: vi.fn().mockImplementation(async () => {
        holderAppeared = true
        return {
          ok: true, tmux_pane_id: '%10', tty: 'ttys001', ui_pid: 12345,
          verification_mode: 'verified_pid_tty_pane',
          expectedRegisterGeneration: 1,
        }
      }),
      commit: vi.fn().mockReturnValue({ ok: true }),
    }
    const log = vi.fn()
    const attach = makeAttachDeps({
      findByIdentityKey: () => holderAppeared
        ? [holderMatch({ runtime_ui_pid: 777 })]
        : [],
      isProcessAlive: () => true,
      log,
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    expect(ok).toBe(false)
    // The decisive assertion: the runtime write was never even attempted, so
    // no incumbent pane binding could be evicted by it.
    expect(bindSvc.commit).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('stage=post_verify')
    )
  })

  it('CRITICAL-3 regression: a throw inside the commit rolls everything back and reports it', async () => {
    // Any error after the verification must leave zero persisted state; the
    // transaction guarantees that, and the outcome is logged rather than
    // silently swallowed by the outer catch.
    seedCaller(db, 'caller-1')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })
    const bindSvc = makeBindSvc({
      ok: true, tmux_pane_id: '%10', tty: 'ttys001', ui_pid: 12345,
      verification_mode: 'verified_pid_tty_pane',
    })
    const log = vi.fn()
    const attach = makeAttachDeps({
      applyPlan: vi.fn(() => { throw new Error('attach exploded') }),
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: bindSvc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    expect(ok).toBe(false)
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('auto-bind commit rolled back')
    )
  })

  it('CRITICAL-1 regression: a refused claim leaves the INCUMBENT pane binding intact', async () => {
    // The runtime write evicts any incumbent holding the same pane (LWW).
    // Reverting only the caller row afterwards can never restore that
    // eviction, so the write must live inside the transaction that the
    // refusal rolls back — asserted here against the REAL repo, not a stub.
    seedCaller(db, 'caller-1')
    db.prepare(
      `INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at, tmux_pane_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('incumbent', 'local', 'default', 'impl', 'incumbent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '%10')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })

    const realSvc = new BindRuntimeIdentityService(db)
    let holderAppeared = false
    const svc = {
      verify: async () => {
        holderAppeared = true
        return {
          ok: true as const, tmux_pane_id: '%10', tty: 'ttys001', ui_pid: 12345,
          verification_mode: 'verified_pid_tty_pane' as const,
          expectedRegisterGeneration: callerGeneration(db, 'caller-1'),
        }
      },
      commit: (agentId: string, verified: never) => realSvc.commit(agentId, verified),
    }
    const attach = makeAttachDeps({
      findByIdentityKey: () => holderAppeared
        ? [holderMatch({ runtime_ui_pid: 777 })]
        : [],
      isProcessAlive: () => true,
    })
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 0,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: svc as never,
        identityKeyAttach: attach,
        log: vi.fn(),
      },
      PROBE_DEPS
    )
    expect(ok).toBe(false)
    expect(paneOf(db, 'incumbent')).toBe('%10')
    expect(paneOf(db, 'caller-1')).toBeNull()
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
  })

  it('CRITICAL-1b regression: a refusal AFTER the runtime write rolls the write back too', async () => {
    // The test above refuses at re-arbitration, i.e. before anything is
    // written.  This one drives the branch the reviewer reproduced: the claim
    // passes re-arbitration, the runtime write REALLY lands (incumbent evicted
    // by LWW), the row is REALLY consumed, and only then does the key attach
    // refuse.  Returning from that refusal used to commit the worst possible
    // state — incumbent evicted, recovery row gone, key attached nowhere.
    //
    // Liveness flipping between the two checks is the deterministic way to
    // drive it; the invariant under test is not "this flip is common" but
    // "a refusal at ANY point commits nothing".
    seedCaller(db, 'caller-1')
    db.prepare(
      `INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at, tmux_pane_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('incumbent', 'local', 'default', 'impl', 'incumbent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '%10')
    repo.upsert({
      pane_id: '%10',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00Z',
    })

    const realSvc = new BindRuntimeIdentityService(db)
    const svc = {
      verify: async () => ({
        ok: true as const, tmux_pane_id: '%10', tty: 'ttys001', ui_pid: 12345,
        verification_mode: 'verified_pid_tty_pane' as const,
        expectedRegisterGeneration: callerGeneration(db, 'caller-1'),
      }),
      commit: (agentId: string, verified: never) => realSvc.commit(agentId, verified),
    }
    // Scan and re-arbitration see a dead holder (claim allowed); the planner
    // inside the attach sees it alive and refuses.
    let aliveCalls = 0
    const attach = makeAttachDeps({
      findByIdentityKey: () => [holderMatch({ runtime_ui_pid: 777 })],
      isProcessAlive: () => ++aliveCalls > 2,
    })
    const log = vi.fn()
    const ok = await autoBindCodexPane(
      {
        callerAgentId: 'caller-1', expectedRegisterGeneration: 0,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: svc as never,
        identityKeyAttach: attach,
        log,
      },
      PROBE_DEPS
    )
    // The refusal really happened after the write: without the rollback the
    // caller would own %10 with a null identity_key and the row would be gone.
    expect(aliveCalls).toBeGreaterThan(2)
    expect(ok).toBe(false)
    expect(paneOf(db, 'incumbent')).toBe('%10')
    expect(paneOf(db, 'caller-1')).toBeNull()
    expect(keyOf(db, 'caller-1')).toBeNull()
    expect(repo.getByPaneId('%10')).toMatchObject({ identity_key: 'K1' })
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('auto-bind commit rolled back')
    )
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_live_holder_conflict')
    )
  })
})

function callerGeneration(db: ReturnType<typeof openDb>, agentId: string): number {
  const row = db
    .prepare('SELECT register_generation AS g FROM agents WHERE agent_id=?')
    .get(agentId) as { g: number }
  return row.g
}

function paneOf(
  db: ReturnType<typeof openDb>,
  agentId: string
): string | null {
  return (db
    .prepare('SELECT tmux_pane_id FROM agents WHERE agent_id=?')
    .get(agentId) as { tmux_pane_id: string | null }).tmux_pane_id
}

function keyOf(
  db: ReturnType<typeof openDb>,
  agentId: string
): string | null {
  return (db
    .prepare('SELECT identity_key FROM agents WHERE agent_id=?')
    .get(agentId) as { identity_key: string | null }).identity_key
}
