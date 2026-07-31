import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-repo-seat-holders-'))

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

describe('AgentsRepo.findKeyHoldersBySeat', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('matches via surviving runtime_tty after the pane rebind cleared the old pane', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const x = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, x.agent_id, { pane: '%1', pid: 4242, tty: 'ttys026' })
    const y = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    // Fallback-path shape: same pane and tty, but no pid recorded.
    bindSeat(repo, y.agent_id, { pane: '%1', pid: null, tty: 'ttys026' })

    // Last-writer-wins already cleared the incumbent's pane binding.
    expect(repo.getById(x.agent_id)?.tmux_pane_id).toBeNull()

    const holders = repo.findKeyHoldersBySeat(y.agent_id, 'local')
    expect(holders).toHaveLength(1)
    expect(holders[0]).toMatchObject({
      agent_id: x.agent_id,
      team: 'aoe',
      name: 'X',
      runtime_ui_pid: 4242,
      identity_key: 'K1',
      // No codex-appserver delivery on the holder row: thread reads null,
      // so seat-follow fails closed against it while alive.
      codex_thread_id: null,
    })
    db.close()
  })

  it('exposes the holder codex-appserver thread_id for seat-follow', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const x = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
      delivery: {
        kind: 'codex-appserver',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    bindSeat(repo, x.agent_id, { pane: '%1', pid: 4242, tty: 'ttys026' })
    const y = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    bindSeat(repo, y.agent_id, { pane: '%1', pid: null, tty: 'ttys026' })

    const holders = repo.findKeyHoldersBySeat(y.agent_id, 'local')
    expect(holders).toHaveLength(1)
    expect(holders[0]).toMatchObject({
      agent_id: x.agent_id,
      identity_key: 'K1',
      codex_thread_id: '11111111-1111-4111-8111-111111111111',
    })
    db.close()
  })

  it('matches via runtime_ui_pid when the caller bound a pid', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const x = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, x.agent_id, { pane: '%1', pid: 4242, tty: 'ttys026' })
    const y = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    bindSeat(repo, y.agent_id, { pane: '%2', pid: 4242, tty: 'ttys027' })

    const holders = repo.findKeyHoldersBySeat(y.agent_id, 'local')
    expect(holders.map(h => h.agent_id)).toEqual([x.agent_id])
    db.close()
  })

  it('returns nothing for a different seat, a keyless row, or the caller itself', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const x = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, x.agent_id, { pane: '%1', pid: 4242, tty: 'ttys026' })
    // Keyless row on the caller's own seat: seat match alone is not enough.
    const keyless = repo.register({ agent_type: 'codex', name: 'Z', team: 'aoe' })
    bindSeat(repo, keyless.agent_id, { pane: '%9', pid: 7777, tty: 'ttys099' })
    const y = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    bindSeat(repo, y.agent_id, { pane: '%9', pid: null, tty: 'ttys099' })

    expect(repo.findKeyHoldersBySeat(y.agent_id, 'local')).toEqual([])
    // The key holder never sees itself as a candidate.
    expect(repo.findKeyHoldersBySeat(x.agent_id, 'local')).toEqual([])
    db.close()
  })

  it('excludes channel-proxy rows and rows on another device', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const proxy = repo.register({
      agent_type: 'custom', role: '__channel_proxy__',
      name: 'channel-proxy-1', team: 'default', identity_key: 'P',
    })
    bindSeat(repo, proxy.agent_id, { pane: '%1', pid: 4242, tty: 'ttys026' })
    repo.register({
      agent_type: 'codex', device: 'gx', name: 'remote', team: 'aoe',
      identity_key: 'R',
    })
    const y = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })
    bindSeat(repo, y.agent_id, { pane: '%1', pid: 4242, tty: 'ttys026' })

    expect(repo.findKeyHoldersBySeat(y.agent_id, 'local')).toEqual([])
    db.close()
  })

  it('a caller with no runtime binding matches nothing', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const x = repo.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
    })
    bindSeat(repo, x.agent_id, { pane: '%1', pid: 4242, tty: 'ttys026' })
    const y = repo.register({ agent_type: 'codex', name: 'Y', team: 'aoe' })

    expect(repo.findKeyHoldersBySeat(y.agent_id, 'local')).toEqual([])
    db.close()
  })
})
