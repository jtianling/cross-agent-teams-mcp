import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: vi.fn(),
}))

import { bindRuntimeIdentity } from '../src/daemon/runtime-identity.js'
import { BindRuntimeIdentityService } from '../src/mcp/bind-runtime-identity.js'

const bindRuntimeIdentityMock = vi.mocked(bindRuntimeIdentity)

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

const S1 = {
  ok: true as const,
  tmux_pane_id: '%10',
  verification_mode: 'verified_pid_tty_pane' as const,
  tty: 'ttys010',
  ui_pid: 101,
}

describe('BindRuntimeIdentityService call-start generation capture', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    bindRuntimeIdentityMock.mockReset()
  })

  it('MANUAL-BIND STAGE GATE: a bind suspended in verification never stomps a newer same-name registration', async () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const logLines: string[] = []
    const svc = new BindRuntimeIdentityService(db, line => logLines.push(line))

    const a = repo.register({ name: 'codex-a' })
    let release!: () => void
    let markEntered!: () => void
    const entered = new Promise<void>(r => { markEntered = r })
    const gate = new Promise<void>(r => { release = r })
    bindRuntimeIdentityMock.mockImplementation(async () => {
      markEntered()
      await gate
      return S1
    })

    // A's manual bind (explicit capture mode) suspends inside verification.
    const pending = svc.bind({
      callerAgentId: a.agent_id, agent: 'codex', ui_pid: 101,
      captureCurrentGeneration: true,
    })
    await entered

    // B re-registers the same identity and binds its own seat S2.
    const b = repo.register({ name: 'codex-a' })
    expect(b.agent_id).toBe(a.agent_id)
    const bBound = repo.setRuntimeBinding(b.agent_id, {
      tmux_pane_id: '%20',
      runtime_ui_pid: 202,
      runtime_tty: 'ttys021',
      runtime_verification_mode: 'verified_pid_tty_pane',
      expected_register_generation: b.register_generation,
    })
    expect(bBound.changes).toBe(1)

    release()
    const result = await pending
    expect(result).toEqual({ error: 'stale_registration_bind' })
    expect(logLines).toContainEqual(
      expect.stringContaining('reason=stale_registration_bind')
    )
    // The row keeps B's seat untouched.
    const row = db.prepare(
      `SELECT tmux_pane_id, runtime_ui_pid, runtime_tty FROM agents WHERE agent_id=?`
    ).get(a.agent_id)
    expect(row).toEqual({
      tmux_pane_id: '%20',
      runtime_ui_pid: 202,
      runtime_tty: 'ttys021',
    })
    db.close()
  })

  it('registrations that completed BEFORE the call never block an explicit repair rebind', async () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const svc = new BindRuntimeIdentityService(db)

    const a = repo.register({ name: 'codex-a' })
    repo.register({ name: 'codex-a' })
    repo.register({ name: 'codex-a' })
    bindRuntimeIdentityMock.mockResolvedValue(S1)

    const result = await svc.bind({
      callerAgentId: a.agent_id, agent: 'codex', ui_pid: 101,
      captureCurrentGeneration: true,
    })
    expect(result).toMatchObject({ ok: true, tmux_pane_id: '%10' })
    const row = db.prepare(
      `SELECT tmux_pane_id, runtime_ui_pid FROM agents WHERE agent_id=?`
    ).get(a.agent_id)
    expect(row).toEqual({ tmux_pane_id: '%10', runtime_ui_pid: 101 })
    db.close()
  })
})
