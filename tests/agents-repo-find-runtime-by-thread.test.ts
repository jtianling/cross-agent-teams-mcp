import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-repo-thread-runtime-'))

const THREAD_T = '11111111-1111-4111-8111-111111111111'
const THREAD_OTHER = '22222222-2222-4222-8222-222222222222'

function freshRepo() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  return { dir, db, repo: new AgentsRepo(db) }
}

function codexDelivery(thread_id: string) {
  return {
    kind: 'codex-appserver' as const,
    thread_id,
    ws_url: 'ws://127.0.0.1:8799',
  }
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

describe('AgentsRepo.findRuntimeByThread', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('finds the one other bound row carrying the same codex thread', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const x = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, x.agent_id, { pane: '%67', pid: 85094, tty: 'ttys010' })
    const caller = repo.register({
      agent_type: 'codex', name: 'Y', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })

    const matches = repo.findRuntimeByThread(THREAD_T, 'local', caller.agent_id)
    expect(matches).toHaveLength(1)
    // The row carries the FULL surviving seat (pid, tty, pane, bound-at) so
    // callers can collapse rename-chain rows by physical seat and inherit
    // the seat exactly — never through detection.
    expect(matches[0]).toMatchObject({
      agent_id: x.agent_id,
      team: 'aoe',
      name: 'X',
      runtime_ui_pid: 85094,
      runtime_tty: 'ttys010',
      tmux_pane_id: '%67',
    })
    expect(typeof matches[0].runtime_bound_at).toBe('string')
    db.close()
  })

  it('includes the caller-reused row when no exclusion is passed', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const self = repo.register({
      agent_type: 'codex', name: 'self', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, self.agent_id, { pane: '%2', pid: 4243, tty: 'ttys002' })

    const matches = repo.findRuntimeByThread(THREAD_T, 'local')
    expect(matches.map(m => m.agent_id)).toEqual([self.agent_id])
    db.close()
  })

  it('matches a pid-less row via its surviving runtime_tty', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const x = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, x.agent_id, { pane: '%67', pid: null, tty: 'ttys010' })

    const matches = repo.findRuntimeByThread(THREAD_T, 'local', 'caller-id')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      agent_id: x.agent_id,
      runtime_ui_pid: null,
    })
    db.close()
  })

  it('returns nothing on a thread miss, an unbound row, or the caller itself', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    // Same thread but NO runtime binding at all: never a match.
    repo.register({
      agent_type: 'codex', name: 'unbound', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    // Bound runtime but a different thread.
    const other = repo.register({
      agent_type: 'codex', name: 'other', team: 'aoe',
      delivery: codexDelivery(THREAD_OTHER),
    })
    bindSeat(repo, other.agent_id, { pane: '%1', pid: 4242, tty: 'ttys001' })
    // Bound runtime, same thread — but it IS the caller.
    const self = repo.register({
      agent_type: 'codex', name: 'self', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, self.agent_id, { pane: '%2', pid: 4243, tty: 'ttys002' })

    expect(repo.findRuntimeByThread(THREAD_T, 'local', self.agent_id))
      .toEqual([])
    db.close()
  })

  it('returns all bound rows when multiple share the thread', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const a = repo.register({
      agent_type: 'codex', name: 'A', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, a.agent_id, { pane: '%1', pid: 4242, tty: 'ttys001' })
    const b = repo.register({
      agent_type: 'codex', name: 'B', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, b.agent_id, { pane: '%2', pid: 4243, tty: 'ttys002' })

    const matches = repo.findRuntimeByThread(THREAD_T, 'local', 'caller-id')
    expect(matches.map(m => m.agent_id).sort())
      .toEqual([a.agent_id, b.agent_id].sort())
    db.close()
  })

  it('excludes channel-proxy rows and rows on another device', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const proxy = repo.register({
      agent_type: 'custom', role: '__channel_proxy__',
      name: 'channel-proxy-1', team: 'default',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, proxy.agent_id, { pane: '%1', pid: 4242, tty: 'ttys001' })
    const remote = repo.register({
      agent_type: 'codex', device: 'gx', name: 'remote', team: 'aoe',
      delivery: codexDelivery(THREAD_T),
    })
    bindSeat(repo, remote.agent_id, { pane: '%2', pid: 4243, tty: 'ttys002' })

    expect(repo.findRuntimeByThread(THREAD_T, 'local', 'caller-id'))
      .toEqual([])
    db.close()
  })
})
