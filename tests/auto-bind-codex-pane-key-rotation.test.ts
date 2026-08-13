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

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-key-rotation-'))

// Real-shaped keys: the log truncates to 8 characters, which a two-character
// fixture could not distinguish from printing the key whole.
const STALE_KEY = 'e8ddde44-efa8-4ffb-b06f-785e539f63ed'
const FRESH_KEY = '568f8c97-d466-4f78-8fcb-058ac23d2de1'

function makeBindSvc(): { verify: ReturnType<typeof vi.fn>; commit: ReturnType<typeof vi.fn> } {
  return {
    verify: vi.fn().mockResolvedValue({ ok: true, expectedRegisterGeneration: 1 }),
    commit: vi.fn().mockReturnValue({ ok: true }),
  }
}

function seedCaller(db: ReturnType<typeof openDb>, agentId: string): void {
  db.prepare(
    `INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(agentId, 'local', 'monkeys', 'impl', 'monkeys-coder', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
}

describe('autoBindCodexPane identity_key rotation under a recovery nonce', () => {
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
    listPanes: async () => [
      { pane_id: '%25', tty: 'ttys020' },
      { pane_id: '%26', tty: 'ttys009' },
    ],
    ttyProcesses: async (tty: string) => [
      tty === 'ttys020'
        ? '12345 12345 12345 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U25"'
        : '23456 23456 23456 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U26"',
    ],
  }

  function makeAttachDeps(
    overrides: Partial<IdentityKeyAttachDeps> = {}
  ): IdentityKeyAttachDeps & { applyPlan: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } {
    return {
      findCaller: () => ({ team: 'monkeys', name: 'monkeys-coder', identity_key: STALE_KEY }),
      findByIdentityKey: () => [],
      applyPlan: vi.fn(),
      isProcessAlive: () => false,
      log: vi.fn(),
      ...overrides,
    } as IdentityKeyAttachDeps & { applyPlan: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> }
  }

  function holderMatch(overrides: Partial<IdentityKeyMatch> = {}): IdentityKeyMatch {
    return {
      agent_id: 'stranger-row',
      device: 'local',
      team: 'aoe',
      name: 'aoe-codex',
      role: 'default',
      runtime_ui_pid: 777,
      last_seen_at: '2026-01-01T00:00:00Z',
      ...overrides,
    }
  }

  function seedRow(pane_id: string, uuid: string, key: string): void {
    repo.upsert({
      pane_id,
      xats_agent_id: uuid,
      identity_key: key,
      expires_at: '2999-01-01T00:00:00Z',
    })
  }

  function run(args: {
    attach: IdentityKeyAttachDeps
    nonce: boolean
    log?: ReturnType<typeof vi.fn>
    pane?: string
    bindSvc?: ReturnType<typeof makeBindSvc>
    callerAgentId?: string
  }): Promise<'bound_consumed' | 'bound_stale' | false> {
    return autoBindCodexPane(
      {
        callerAgentId: args.callerAgentId ?? 'caller-1',
        expectedRegisterGeneration: 1,
        repo,
        runAtomic: fn => db.transaction(fn)(),
        bindRuntimeIdentitySvc: (args.bindSvc ?? makeBindSvc()) as never,
        targetPaneId: args.pane ?? '%25',
        targetPaneFromNonce: args.nonce,
        identityKeyAttach: args.attach,
        log: args.log,
      },
      PROBE_DEPS
    )
  }

  it('REGRESSION: a nonce-targeted row rotates the caller off a previous generation key', async () => {
    // The self-lock this change exists to break: the launcher re-minted the
    // pane's key when the tmux session was rebuilt, so the caller row still
    // holds the dead generation's key.  Refusing on that alone left this pair
    // permanently unable to converge, because this attach is the only writer
    // of the key for a runtime that cannot read it from its own environment.
    seedCaller(db, 'caller-1')
    seedRow('%25', 'U25', FRESH_KEY)
    const attach = makeAttachDeps()

    const ok = await run({ attach, nonce: true })

    expect(ok).toBe('bound_consumed')
    expect(attach.applyPlan).toHaveBeenCalledWith({ kind: 'bind' }, 'caller-1', FRESH_KEY)
    expect(repo.getByPaneId('%25')).toBeUndefined()
  })

  it('logs the rotation with both keys truncated to 8 characters', async () => {
    seedCaller(db, 'caller-1')
    seedRow('%25', 'U25', FRESH_KEY)
    const attach = makeAttachDeps()

    await run({ attach, nonce: true })

    const rotationLines = attach.log.mock.calls
      .map(c => String(c[0]))
      .filter(line => line.includes('identity_key rotated'))
    expect(rotationLines).toHaveLength(1)
    expect(rotationLines[0]).toContain('pane=%25')
    expect(rotationLines[0]).toContain('caller=caller-1')
    expect(rotationLines[0]).toContain(`from=${STALE_KEY.slice(0, 8)}`)
    expect(rotationLines[0]).toContain(`to=${FRESH_KEY.slice(0, 8)}`)
    // The prefix is what keeps the credential out of the log.
    for (const call of attach.log.mock.calls) {
      expect(String(call[0])).not.toContain(STALE_KEY)
      expect(String(call[0])).not.toContain(FRESH_KEY)
    }
  })

  it('does NOT rotate the same contradiction when no nonce selected the row', async () => {
    // Without a nonce the row is reachable only by the unique-candidate
    // inference, which proves the PANE's codex identity and never the
    // CALLER's — so the contradiction stays terminal exactly as before.
    seedCaller(db, 'caller-1')
    seedRow('%25', 'U25', FRESH_KEY)
    const log = vi.fn()
    const attach = makeAttachDeps()
    const bindSvc = makeBindSvc()

    const ok = await run({ attach, nonce: false, log, bindSvc })

    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_contradiction')
    )
    expect(repo.getByPaneId('%25')).toMatchObject({ identity_key: FRESH_KEY })
  })

  it('a nonce does NOT authorise taking a LIVE stranger\'s key', async () => {
    seedCaller(db, 'caller-1')
    seedRow('%25', 'U25', FRESH_KEY)
    const log = vi.fn()
    const attach = makeAttachDeps({
      findByIdentityKey: () => [holderMatch()],
      isProcessAlive: () => true,
    })
    const bindSvc = makeBindSvc()

    const ok = await run({ attach, nonce: true, log, bindSvc })

    expect(ok).toBe(false)
    expect(bindSvc.verify).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_live_holder_conflict')
    )
    expect(repo.getByPaneId('%25')).toMatchObject({ identity_key: FRESH_KEY })
  })

  it('a nonce does NOT authorise taking a liveness-UNKNOWN holder\'s key', async () => {
    seedCaller(db, 'caller-1')
    seedRow('%25', 'U25', FRESH_KEY)
    const log = vi.fn()
    const attach = makeAttachDeps({
      findByIdentityKey: () => [holderMatch({ runtime_ui_pid: null })],
    })

    const ok = await run({ attach, nonce: true, log })

    expect(ok).toBe(false)
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('reason=identity_key_holder_liveness_unknown')
    )
    expect(repo.getByPaneId('%25')).toMatchObject({ identity_key: FRESH_KEY })
  })

  it('an idempotent re-bind of the same key is not reported as a rotation', async () => {
    seedCaller(db, 'caller-1')
    seedRow('%25', 'U25', FRESH_KEY)
    const attach = makeAttachDeps({
      findCaller: () => ({ team: 'monkeys', name: 'monkeys-coder', identity_key: FRESH_KEY }),
    })

    const ok = await run({ attach, nonce: true })

    expect(ok).toBe('bound_consumed')
    expect(attach.log.mock.calls.map(c => String(c[0]))).not.toContainEqual(
      expect.stringContaining('identity_key rotated')
    )
  })

  it('a holder appearing during verification still rolls the whole commit back', async () => {
    // The nonce reopens ONE refusal (the caller's own stale key).  A rightful
    // owner acquiring the key inside the verification window is a different
    // refusal, and it must still take the transaction down — otherwise the
    // runtime write would have evicted whoever holds that pane.
    seedCaller(db, 'caller-1')
    seedRow('%25', 'U25', FRESH_KEY)
    let holderAppeared = false
    const bindSvc = {
      verify: vi.fn().mockImplementation(async () => {
        holderAppeared = true
        return {
          ok: true, tmux_pane_id: '%25', tty: 'ttys020', ui_pid: 12345,
          verification_mode: 'verified_pid_tty_pane',
          expectedRegisterGeneration: 1,
        }
      }),
      commit: vi.fn().mockReturnValue({ ok: true }),
    }
    const log = vi.fn()
    const attach = makeAttachDeps({
      findByIdentityKey: () => holderAppeared ? [holderMatch()] : [],
      isProcessAlive: () => true,
    })

    const ok = await run({ attach, nonce: true, log, bindSvc: bindSvc as never })

    expect(ok).toBe(false)
    expect(bindSvc.commit).not.toHaveBeenCalled()
    expect(attach.applyPlan).not.toHaveBeenCalled()
    expect(repo.getByPaneId('%25')).toMatchObject({ identity_key: FRESH_KEY })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stage=post_verify'))
  })

  it('two panes restarted together each rotate to their OWN key', async () => {
    // The production shape: both coders panes came back holding their previous
    // generation's key, each with its own nonce naming its own pane.
    const OTHER_FRESH = '0c5d8e23-718b-4d08-8bba-7d79c9bc6cec'
    const OTHER_STALE = '657a9b30-b885-4634-a33c-8cd5dfde9783'
    seedCaller(db, 'caller-1')
    db.prepare(
      `INSERT INTO agents (agent_id, device, team, role, name, registered_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('caller-2', 'local', 'monkeys', 'impl', 'mvr-coder', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    seedRow('%25', 'U25', FRESH_KEY)
    seedRow('%26', 'U26', OTHER_FRESH)

    const attach1 = makeAttachDeps()
    const first = await run({ attach: attach1, nonce: true, pane: '%25' })

    const attach2 = makeAttachDeps({
      findCaller: () => ({ team: 'monkeys', name: 'mvr-coder', identity_key: OTHER_STALE }),
    })
    const second = await run({
      attach: attach2, nonce: true, pane: '%26', callerAgentId: 'caller-2',
    })

    expect(first).toBe('bound_consumed')
    expect(second).toBe('bound_consumed')
    expect(attach1.applyPlan).toHaveBeenCalledWith({ kind: 'bind' }, 'caller-1', FRESH_KEY)
    expect(attach2.applyPlan).toHaveBeenCalledWith({ kind: 'bind' }, 'caller-2', OTHER_FRESH)
  })
})
