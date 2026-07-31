import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { __testOverrides as autoBindOverrides } from '../src/mcp/auto-bind-codex-pane.js'

const detectTmuxPaneMock = vi.fn()
const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

// The recovery module is mocked so a real schedule (and its real tmux/ps
// probing) can never start; the wiring assertions below run against the
// spies: evaluate must fire for BOTH generations, cancel must fire for
// NEITHER (a stale bind must not cancel the new row's schedule).
const { evaluateRecoveryMock, cancelRecoveryMock } = vi.hoisted(() => ({
  evaluateRecoveryMock: vi.fn(),
  cancelRecoveryMock: vi.fn(),
}))

vi.mock('../src/mcp/codex-recovery-poke.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/mcp/codex-recovery-poke.js')>()
  return {
    ...actual,
    evaluateCodexRecoveryOnPreRegister: evaluateRecoveryMock,
    cancelCodexRecoverySchedule: cancelRecoveryMock,
  }
})

// See register-agent-codex-pre-reg.test.ts: bypass the live codex-appserver
// handshake by delegating RegisterCodexSelfService.register straight to the
// generic registerSvc.register so the agent row still gets written.
vi.mock('../src/mcp/register-codex-self.js', () => {
  return {
    RegisterCodexSelfService: class {
      constructor(private readonly registerSvc: { register: (input: unknown) => unknown }) {}
      register(input: {
        connection_id: string
        name: string
        model?: string
        role?: string
        team?: string
        project_dir?: string
        thread_id?: string
        ws_url?: string
      }) {
        const result = this.registerSvc.register({
          connection_id: input.connection_id,
          agent_type: 'codex',
          model: input.model ?? 'codex',
          name: input.name,
          role: input.role,
          team: input.team,
          project_dir: input.project_dir,
          delivery: {
            kind: 'codex-appserver',
            thread_id: input.thread_id,
            ws_url: input.ws_url || 'ws://127.0.0.1:8799',
          },
        }) as Record<string, unknown>
        if ('error' in result) return result
        return {
          ...result,
          thread_id: input.thread_id,
          ws_url: input.ws_url || 'ws://127.0.0.1:8799',
        }
      }
    },
  }
})

const VALID_THREAD_ID = '33333333-3333-4333-8333-333333333333'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-prereg-race-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

// Reviewer race repro at the tools level: a launcher overwrite (U9/K9) lands
// while the U1/K1 auto-bind is in flight.  The stale outcome must leave the
// new row AND its recovery schedule intact, run NO seat-follow, and move NO
// identity key: X keeps K1, the caller row gets nothing.
describe('register_agent pre-reg overwrite race (stale bind)', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
    evaluateRecoveryMock.mockReset()
    cancelRecoveryMock.mockReset()
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
  })

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    delete autoBindOverrides.listPanes
    delete autoBindOverrides.ttyProcesses
    delete autoBindOverrides.now
  })

  it('keeps the new row, its schedule, and every identity key unchanged', async () => {
    autoBindOverrides.listPanes = async () => [{ pane_id: '%1972', tty: 'ttys001' }]
    autoBindOverrides.ttyProcesses = async () =>
      ['91131 91131 91131 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"']

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })
    const url = new URL(`http://${host}:${port}/mcp`)

    // X is the seat holder for K1 (same pid the caller is about to bind):
    // had seat-follow run on the stale outcome, K1 WOULD have migrated.
    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    seed.prepare(
      `INSERT INTO agents
         (agent_id, device, team, role, name, registered_at, last_seen_at,
          tmux_pane_id, runtime_ui_pid, runtime_tty, identity_key)
       VALUES (?, 'local', 'aoe', 'default', 'X', ?, ?, '%1972', 91131,
               'ttys001', 'K1')`
    ).run('holder-x', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    seed.close()

    const t1 = new StreamableHTTPClientTransport(url)
    const c1 = new Client({ name: 'launcher', version: '0.0.0' })
    await c1.connect(t1)
    const t2 = new StreamableHTTPClientTransport(url)
    const c2 = new Client({ name: 'launcher-2', version: '0.0.0' })
    await c2.connect(t2)

    const preReg = await c1.callTool({
      name: 'pre_register_codex_pane',
      arguments: { pane_id: '%1972', xats_agent_id: 'U1', identity_key: 'K1' },
    })
    expect(await parseTool(preReg)).toMatchObject({ ok: true })
    expect(evaluateRecoveryMock).toHaveBeenCalledTimes(1)

    // The launcher overwrite lands while the caller's pane bind is in
    // flight: the bind mock performs it through the real tool before
    // resolving, exactly the reviewer's interleaving.
    bindRuntimeIdentityMock.mockImplementation(async () => {
      const overwrite = await c2.callTool({
        name: 'pre_register_codex_pane',
        arguments: { pane_id: '%1972', xats_agent_id: 'U9', identity_key: 'K9' },
      })
      expect(await parseTool(overwrite)).toMatchObject({ ok: true })
      return {
        ok: true,
        tmux_pane_id: '%1972',
        verification_mode: 'verified_pid_tty_pane',
        tty: 'ttys001',
        ui_pid: 91131,
      }
    })

    const t3 = new StreamableHTTPClientTransport(url)
    const c3 = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c3.connect(t3)
    const resp = await c3.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'codex',
        model: 'gpt-5',
        name: 'Y',
        team: 'aoe',
        thread_id: VALID_THREAD_ID,
      },
    })
    const obj = await parseTool(resp)
    expect(obj.agent_id).toBeDefined()

    const db = openDb(dbPath)
    applySchema(db, { localDevice: 'local' })
    // The new row is intact: not consumed, still the overwrite generation.
    const preRow = db.prepare(
      `SELECT pane_id, xats_agent_id, identity_key
       FROM codex_pane_pre_registrations WHERE pane_id='%1972'`
    ).get() as { pane_id: string; xats_agent_id: string; identity_key: string }
    expect(preRow).toEqual({
      pane_id: '%1972',
      xats_agent_id: 'U9',
      identity_key: 'K9',
    })
    // ALL identity keys unchanged: X keeps K1, the caller row gets nothing
    // (while its pane bind, the one thing that persisted, remains).
    const rows = db.prepare(
      `SELECT name, tmux_pane_id, runtime_ui_pid, identity_key FROM agents
       WHERE team='aoe' ORDER BY name`
    ).all() as Array<Record<string, unknown>>
    expect(rows).toEqual([
      { name: 'X', tmux_pane_id: null, runtime_ui_pid: 91131, identity_key: 'K1' },
      { name: 'Y', tmux_pane_id: '%1972', runtime_ui_pid: 91131, identity_key: null },
    ])
    db.close()

    // The new generation's schedule is intact: evaluate ran for BOTH
    // pre-registrations, and the stale bind cancelled nothing.
    expect(evaluateRecoveryMock).toHaveBeenCalledTimes(2)
    expect(evaluateRecoveryMock.mock.calls[1][0]).toMatchObject({
      pane_id: '%1972',
      xats_agent_id: 'U9',
      identity_key: 'K9',
    })
    expect(cancelRecoveryMock).not.toHaveBeenCalled()

    await t1.close()
    await c1.close()
    await t2.close()
    await c2.close()
    await t3.close()
    await c3.close()
    await app.close()
  })
})
