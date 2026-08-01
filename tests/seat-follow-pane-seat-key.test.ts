import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import {
  followSeatIdentityKey,
  type SeatFollowDeps,
} from '../src/mcp/codex-seat-follow.js'
import { poke } from '../src/mcp/poke.js'
import { insertAgent } from './helpers/insert-agent.js'

const THREAD_X = '11111111-1111-4111-8111-111111111111'
const THREAD_Y = '22222222-2222-4222-8222-222222222222'
const DEAD_PID = 999_999

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-seat-pane-key-'))

function freshRepo() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  return { dir, db, repo: new AgentsRepo(db) }
}

function bindSeat(
  repo: AgentsRepo,
  agent_id: string,
  seat: { pane: string; pid: number | null; tty: string }
): void {
  repo.setRuntimeBinding(agent_id, {
    tmux_pane_id: seat.pane,
    runtime_ui_pid: seat.pid,
    runtime_tty: seat.tty,
    runtime_verification_mode:
      seat.pid === null ? 'verified_tty_pane' : 'verified_pid_tty_pane',
  })
}

// The same wiring tools.ts gives the seat-follow hook, over a real repo: the
// incident was only visible in the composition of the seat query with the
// branch logic, so neither layer alone reproduces it.
function realDeps(
  db: ReturnType<typeof openDb>,
  repo: AgentsRepo
): SeatFollowDeps {
  return {
    findCaller: agentId => {
      const row = repo.findById(agentId)
      if (!row) return undefined
      return {
        team: row.team,
        name: row.name,
        identity_key: row.identity_key,
        codex_thread_id:
          row.delivery.kind === 'codex-appserver'
            ? row.delivery.thread_id
            : null,
      }
    },
    findKeyHoldersBySeat: agentId => repo.findKeyHoldersBySeat(agentId, 'local'),
    applyPlan: (plan, attachAgentId, key) => {
      const tx = db.transaction(() => {
        if (plan.kind === 'migrate') repo.clearIdentityKey(plan.from_agent_id)
        repo.bindIdentityKey(attachAgentId, key)
      })
      tx()
    },
    log: vi.fn(),
  }
}

function keyOf(repo: AgentsRepo, agent_id: string): string | null {
  return repo.findById(agent_id)?.identity_key ?? null
}

describe('seat-follow seat identity is the pane, never the tty', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('INCIDENT 2026-08-01: a recycled tty does not move a live key to a brand-new pane', () => {
    // Measured shape, reproduced as a fixture (the production rows are
    // preserved as evidence and are deliberately not a test dependency):
    //   aoe-codex-shell  %74  pid 9739   ttys037  holds the key, pid gone
    //   aoe-codex-test-2 %88  pid 79678  ttys037  brand-new pane, no key
    // Different pane, different pid — only the recycled tty matched, and the
    // key moved anyway because the DEAD-holder branch verifies no identity.
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const shell = repo.register({
      agent_type: 'codex', name: 'aoe-codex-shell', team: 'aoe',
      identity_key: 'K-SHELL',
    })
    bindSeat(repo, shell.agent_id, {
      pane: '%74', pid: DEAD_PID, tty: 'ttys037',
    })
    const fresh = repo.register({
      agent_type: 'codex', name: 'aoe-codex-test-2', team: 'aoe',
    })
    bindSeat(repo, fresh.agent_id, { pane: '%88', pid: 79678, tty: 'ttys037' })

    expect(repo.findKeyHoldersBySeat(fresh.agent_id, 'local')).toEqual([])

    followSeatIdentityKey({
      callerAgentId: fresh.agent_id,
      deps: realDeps(db, repo),
    })

    expect(keyOf(repo, shell.agent_id)).toBe('K-SHELL')
    expect(keyOf(repo, fresh.agent_id)).toBeNull()
    db.close()
  })

  it('a recycled tty on an unrelated row does not make a genuine follow ambiguous', () => {
    // The other half of the same defect: a spurious tty candidate pushes
    // holders.length past 1 and the caller-side guard then skips a migration
    // that should have happened.
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const predecessor = repo.register({
      agent_type: 'codex', name: 'P', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, predecessor.agent_id, {
      pane: '%1', pid: DEAD_PID, tty: 'ttys026',
    })
    const unrelated = repo.register({
      agent_type: 'codex', name: 'U', team: 'aoe', identity_key: 'K9',
    })
    bindSeat(repo, unrelated.agent_id, {
      pane: '%99', pid: DEAD_PID + 1, tty: 'ttys037',
    })

    // The caller takes over P's pane and happens to be handed U's tty.
    const caller = repo.register({ agent_type: 'codex', name: 'C', team: 'aoe' })
    bindSeat(repo, caller.agent_id, { pane: '%1', pid: null, tty: 'ttys037' })

    expect(
      repo.findKeyHoldersBySeat(caller.agent_id, 'local').map(h => h.agent_id)
    ).toEqual([predecessor.agent_id])

    followSeatIdentityKey({
      callerAgentId: caller.agent_id,
      deps: realDeps(db, repo),
    })

    expect(keyOf(repo, caller.agent_id)).toBe('K1')
    expect(keyOf(repo, predecessor.agent_id)).toBeNull()
    expect(keyOf(repo, unrelated.agent_id)).toBe('K9')
    db.close()
  })

  it('a same-pane restart still migrates its key, on a tty it never shared', () => {
    // The case the dead-holder branch exists for: the pane the holder lost is
    // the pane the caller now holds.  The ttys differ, so only the preserved
    // pane id can carry this.
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const holder = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, holder.agent_id, {
      pane: '%1', pid: DEAD_PID, tty: 'ttys026',
    })
    const caller = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    bindSeat(repo, caller.agent_id, { pane: '%1', pid: null, tty: 'ttys055' })

    followSeatIdentityKey({
      callerAgentId: caller.agent_id,
      deps: realDeps(db, repo),
    })

    expect(keyOf(repo, caller.agent_id)).toBe('K1')
    expect(keyOf(repo, holder.agent_id)).toBeNull()
    db.close()
  })

  it('a holder that moved on after losing a pane no longer answers to it', () => {
    // The staleness the new column could otherwise reintroduce: X loses %1,
    // rebinds onto %2, and dies there.  Its key belongs to whoever takes over
    // %2, not to whoever takes over %1 — the memory means "the pane this row
    // lost AND has not replaced", so binding a pane clears it.
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const holder = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, holder.agent_id, { pane: '%1', pid: 1001, tty: 'ttys026' })

    const evictor = repo.register({ agent_type: 'codex', name: 'E', team: 'aoe' })
    bindSeat(repo, evictor.agent_id, { pane: '%1', pid: 1002, tty: 'ttys026' })
    // X lost %1, then moved to %2 and died there.
    bindSeat(repo, holder.agent_id, { pane: '%2', pid: DEAD_PID, tty: 'ttys027' })

    const caller = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    bindSeat(repo, caller.agent_id, { pane: '%1', pid: null, tty: 'ttys055' })

    followSeatIdentityKey({
      callerAgentId: caller.agent_id,
      deps: realDeps(db, repo),
    })

    expect(keyOf(repo, caller.agent_id)).toBeNull()
    expect(keyOf(repo, holder.agent_id)).toBe('K1')
    db.close()
  })

  it('a holder that lost a DIFFERENT pane does not qualify', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const holder = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, holder.agent_id, {
      pane: '%1', pid: DEAD_PID, tty: 'ttys026',
    })
    // A third agent takes %1 away from X, so X remembers losing %1.
    const squatter = repo.register({
      agent_type: 'codex', name: 'Z', team: 'aoe',
    })
    bindSeat(repo, squatter.agent_id, { pane: '%1', pid: null, tty: 'ttys026' })

    const caller = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    bindSeat(repo, caller.agent_id, { pane: '%2', pid: null, tty: 'ttys026' })

    expect(repo.findKeyHoldersBySeat(caller.agent_id, 'local')).toEqual([])

    followSeatIdentityKey({
      callerAgentId: caller.agent_id,
      deps: realDeps(db, repo),
    })

    expect(keyOf(repo, holder.agent_id)).toBe('K1')
    expect(keyOf(repo, caller.agent_id)).toBeNull()
    db.close()
  })

  it('pane takeover does not weaken the thread-authorized branch', () => {
    // An ALIVE holder reached through the new leg is still arbitrated by
    // codex-appserver thread equality alone — the leg supplies candidates,
    // never authorization.
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const holder = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
      delivery: {
        kind: 'codex-appserver', thread_id: THREAD_X,
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    bindSeat(repo, holder.agent_id, {
      pane: '%1', pid: process.pid, tty: 'ttys026',
    })
    const caller = repo.register({
      agent_type: 'codex', name: 'Y', team: 'aoe',
      delivery: {
        kind: 'codex-appserver', thread_id: THREAD_Y,
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    bindSeat(repo, caller.agent_id, { pane: '%1', pid: null, tty: 'ttys055' })

    const deps = realDeps(db, repo)
    expect(
      repo.findKeyHoldersBySeat(caller.agent_id, 'local').map(h => h.agent_id)
    ).toEqual([holder.agent_id])

    followSeatIdentityKey({ callerAgentId: caller.agent_id, deps })

    expect(keyOf(repo, holder.agent_id)).toBe('K1')
    expect(keyOf(repo, caller.agent_id)).toBeNull()
    expect(deps.log).toHaveBeenCalledWith(
      expect.stringContaining('thread_mismatch')
    )
    db.close()
  })
})

describe('a preserved pane id is not a binding', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('poke target resolution never resolves to the pane a row lost', async () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const evicted = insertAgent(db, {
      agent_id: 'evicted-1', team: 'aoe', name: 'X', tmux_pane_id: '%1',
    })
    const sender = insertAgent(db, {
      agent_id: 'sender-1', team: 'aoe', name: 'S',
    })
    const taker = repo.register({ agent_type: 'codex', name: 'T', team: 'aoe' })
    repo.setRuntimeBinding(taker.agent_id, {
      tmux_pane_id: '%1',
      runtime_ui_pid: null,
      runtime_tty: 'ttys026',
      runtime_verification_mode: 'verified_tty_pane',
    })

    const preserved = db.prepare(
      `SELECT tmux_pane_id, prev_tmux_pane_id FROM agents WHERE agent_id=?`
    ).get(evicted) as { tmux_pane_id: string | null; prev_tmux_pane_id: string | null }
    expect(preserved).toEqual({ tmux_pane_id: null, prev_tmux_pane_id: '%1' })

    // The tmux poke path reads the target's binding and finds none: the
    // remembered pane is history, not a delivery target.
    await expect(
      poke(
        { db, callerAgentId: sender, localDevice: 'local' },
        { target_agent_id: evicted, prompt: 'hi' }
      )
    ).resolves.toEqual({ error: 'tmux_pane_not_set' })

    expect(repo.findById(evicted)?.tmux_pane_id).toBeNull()
    db.close()
  })
})
