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

// Controllable probe delay: the REAL RegisterCodexSelfService awaits a WS
// probe between the tool layer's pre-upsert capture and the persist.  Each
// armed gate is consumed by exactly one register call (FIFO), letting a test
// hold one registration mid-probe while a concurrent one completes.
const probeGateControl = vi.hoisted(() => ({
  gates: [] as Array<() => Promise<void>>,
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

// See register-agent-codex-pre-reg.test.ts: bypass the live codex-appserver
// handshake by delegating RegisterCodexSelfService.register straight to the
// generic registerSvc.register so the agent row still gets written.  The
// (optional) probe gate stands in for the real async WS probe window.
vi.mock('../src/mcp/register-codex-self.js', () => {
  return {
    RegisterCodexSelfService: class {
      constructor(private readonly registerSvc: { register: (input: unknown) => unknown }) {}
      async register(input: {
        connection_id: string
        name: string
        model?: string
        role?: string
        team?: string
        project_dir?: string
        thread_id?: string
        ws_url?: string
        identity_key?: string
      }) {
        const gate = probeGateControl.gates.shift()
        if (gate) await gate()
        const result = this.registerSvc.register({
          connection_id: input.connection_id,
          agent_type: 'codex',
          model: input.model ?? 'codex',
          name: input.name,
          role: input.role,
          team: input.team,
          project_dir: input.project_dir,
          identity_key: input.identity_key,
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

// Incident thread of the running aoe-codex conversation, the unrelated shell
// codex's thread, and the fresh thread a restarted codex mints.
const THREAD_T = '11111111-1111-4111-8111-111111111111'
const THREAD_SHELL = '22222222-2222-4222-8222-222222222222'
const THREAD_NEW = '33333333-3333-4333-8333-333333333333'

const SHELL_CODEX_PID = 11754
const SHELL_CODEX_LINE =
  `${SHELL_CODEX_PID} ${SHELL_CODEX_PID} ${SHELL_CODEX_PID} S+ ` +
  'codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U_SHELL"'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-same-thread-prec-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

function armProbeGate(): { entered: Promise<void>; release: () => void } {
  let release!: () => void
  let signalEntered!: () => void
  const entered = new Promise<void>(resolve => { signalEntered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  probeGateControl.gates.push(() => {
    signalEntered()
    return blocked
  })
  return { entered, release }
}

interface AgentSeed {
  agent_id: string
  name: string
  thread_id: string
  pane: string | null
  pid: number | null
  tty: string
  identity_key: string | null
  bound_at?: string
}

interface AgentSnapshot {
  name: string
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  identity_key: string | null
}

// LIVE-TEST INCIDENT REPRO (production DB evidence): conversation A (row
// `aoe-codex`, codex-appserver thread T, bound pane/pid, identity_key K1)
// renamed itself to `aoe-codex-r2` (same thread T) while an UNRELATED shell
// codex's pre-reg row (uuid U_SHELL, identity_key EECF3E35) was pending.
// autoBindCodexPane's only correlation is "exactly one machine-wide
// candidate", so the rename CONSUMED the foreign row: r2 bound the shell's
// pane/pid and took the shell's seat key, the shell's own registration found
// nothing, and K1 never migrated.  The fix: a codex registration whose
// thread matches an existing bound row inherits THAT row's runtime and never
// reaches the pre-reg scan.
describe('register_agent same-thread precedence (codex)', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    probeGateControl.gates.length = 0
  })

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    delete autoBindOverrides.listPanes
    delete autoBindOverrides.ttyProcesses
    delete autoBindOverrides.now
  })

  async function startSeededServer(args: {
    agents: AgentSeed[]
    preRegs?: Array<{ pane_id: string; uuid: string; identity_key: string }>
  }): Promise<{
    app: { close: () => Promise<void> }
    dbPath: string
    url: URL
    logLines: string[]
  }> {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const logLines: string[] = []
    const { app, port, host } = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
      mcpLog: line => { logLines.push(line) },
    })

    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    for (const a of args.agents) {
      seed.prepare(
        `INSERT INTO agents
           (agent_id, device, team, role, name, registered_at, last_seen_at,
            tmux_pane_id, runtime_ui_pid, runtime_tty, runtime_bound_at,
            identity_key, delivery_kind, delivery_payload)
         VALUES (?, 'local', 'aoe', 'default', ?, ?, ?, ?, ?, ?, ?, ?,
                 'codex-appserver', ?)`
      ).run(
        a.agent_id,
        a.name,
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        a.pane,
        a.pid,
        a.tty,
        a.bound_at ?? null,
        a.identity_key,
        JSON.stringify({ thread_id: a.thread_id, ws_url: 'ws://127.0.0.1:8799' })
      )
    }
    for (const p of args.preRegs ?? []) {
      seed.prepare(
        `INSERT INTO codex_pane_pre_registrations
           (pane_id, xats_agent_id, expires_at, identity_key)
         VALUES (?, ?, '2999-01-01T00:00:00.000Z', ?)`
      ).run(p.pane_id, p.uuid, p.identity_key)
    }
    seed.close()

    return { app, dbPath, url: new URL(`http://${host}:${port}/mcp`), logLines }
  }

  async function startRegisterCodex(
    url: URL,
    args: { name: string; thread_id: string; ui_pid?: number }
  ): Promise<{
    done: Promise<Record<string, unknown>>
    close: () => Promise<void>
  }> {
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)
    const done = c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'codex',
        model: 'gpt-5',
        name: args.name,
        team: 'aoe',
        thread_id: args.thread_id,
        ...(args.ui_pid === undefined ? {} : { ui_pid: args.ui_pid }),
      },
    }).then(resp => parseTool(resp))
    return {
      done,
      close: async () => {
        await t.close()
        await c.close()
      },
    }
  }

  async function registerCodex(
    url: URL,
    args: { name: string; thread_id: string; ui_pid?: number }
  ): Promise<{ obj: Record<string, unknown>; close: () => Promise<void> }> {
    const { done, close } = await startRegisterCodex(url, args)
    return { obj: await done, close }
  }

  function readAgents(dbPath: string): AgentSnapshot[] {
    const db = openDb(dbPath)
    applySchema(db, { localDevice: 'local' })
    const rows = db.prepare(
      `SELECT name, tmux_pane_id, runtime_ui_pid, identity_key FROM agents
       WHERE team='aoe' ORDER BY name`
    ).all() as AgentSnapshot[]
    db.close()
    return rows
  }

  function readRuntimeSeat(dbPath: string, name: string): {
    tmux_pane_id: string | null
    runtime_ui_pid: number | null
    runtime_tty: string | null
    runtime_verification_mode: string | null
    runtime_bound_at: string | null
  } {
    const db = openDb(dbPath)
    applySchema(db, { localDevice: 'local' })
    const row = db.prepare(
      `SELECT tmux_pane_id, runtime_ui_pid, runtime_tty,
              runtime_verification_mode, runtime_bound_at
       FROM agents WHERE team='aoe' AND name=?`
    ).get(name) as {
      tmux_pane_id: string | null
      runtime_ui_pid: number | null
      runtime_tty: string | null
      runtime_verification_mode: string | null
      runtime_bound_at: string | null
    }
    db.close()
    return row
  }

  function readPreRegs(dbPath: string): Array<{
    pane_id: string
    xats_agent_id: string
    identity_key: string | null
  }> {
    const db = openDb(dbPath)
    applySchema(db, { localDevice: 'local' })
    const rows = db.prepare(
      `SELECT pane_id, xats_agent_id, identity_key
       FROM codex_pane_pre_registrations ORDER BY pane_id`
    ).all() as Array<{
      pane_id: string
      xats_agent_id: string
      identity_key: string | null
    }>
    db.close()
    return rows
  }

  const foreignPreReg = {
    pane_id: '%99',
    uuid: 'U_SHELL',
    identity_key: 'EECF3E35',
  }

  it('INCIDENT: a same-thread rename never consumes the foreign pre-reg; the shell later consumes its own row', async () => {
    // The foreign pre-reg is fully CONSUMABLE (unique machine-wide
    // candidate): without same-thread precedence, the rename would have
    // bound the shell's pane/pid and taken EECF3E35 — the incident.
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) => {
        if (input.ui_pid === process.pid) {
          return {
            ok: true,
            tmux_pane_id: '%67',
            verification_mode: 'verified_pid_tty_pane',
            tty: 'ttys010',
            ui_pid: process.pid,
          }
        }
        if (input.ui_pid === SHELL_CODEX_PID) {
          return {
            ok: true,
            tmux_pane_id: '%99',
            verification_mode: 'verified_pid_tty_pane',
            tty: 'ttys020',
            ui_pid: SHELL_CODEX_PID,
          }
        }
        return { error: 'pid_not_found' }
      }
    )

    const { app, dbPath, url, logLines } = await startSeededServer({
      agents: [{
        // process.pid stands in for the still-running codex carrier so the
        // alive-holder seat-follow arbitration is deterministic.
        agent_id: 'holder-a', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: process.pid, tty: 'ttys010', identity_key: 'K1',
      }],
      preRegs: [foreignPreReg],
    })

    // Phase 1: the rename registration (same thread T, new name).
    const r2 = await registerCodex(url, {
      name: 'aoe-codex-r2', thread_id: THREAD_T,
    })
    expect(r2.obj.agent_id).toBeDefined()

    // The runtime was INHERITED from the same-thread row: one pid bind with
    // the old row's pid, no pane detection, and the shell's pid untouched.
    expect(bindRuntimeIdentityMock).toHaveBeenCalledTimes(1)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', ui_pid: process.pid })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()
    // Unified decision log: inherit success with counts and the seat owner.
    expect(logLines).toContainEqual(expect.stringContaining(
      'outcome=inherit rows=1 seats=1 agents=holder-a'
    ))

    // The foreign pre-reg row is STILL PRESENT, key untouched.
    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    expect(readAgents(dbPath)).toEqual([
      // Old row: keyless after the seat-follow migration, pane cleared by
      // last-writer-wins.
      {
        name: 'aoe-codex', tmux_pane_id: null,
        runtime_ui_pid: process.pid, identity_key: null,
      },
      // The rename row inherited the old runtime and K1.
      {
        name: 'aoe-codex-r2', tmux_pane_id: '%67',
        runtime_ui_pid: process.pid, identity_key: 'K1',
      },
    ])
    await r2.close()

    // Phase 2: the unrelated shell codex registers with ITS OWN thread —
    // its pre-reg row is consumed by its own session and it gets its key.
    const shell = await registerCodex(url, {
      name: 'shell-codex', thread_id: THREAD_SHELL,
    })
    expect(shell.obj.agent_id).toBeDefined()

    expect(readPreRegs(dbPath)).toEqual([])
    expect(readAgents(dbPath)).toEqual([
      {
        name: 'aoe-codex', tmux_pane_id: null,
        runtime_ui_pid: process.pid, identity_key: null,
      },
      {
        name: 'aoe-codex-r2', tmux_pane_id: '%67',
        runtime_ui_pid: process.pid, identity_key: 'K1',
      },
      {
        name: 'shell-codex', tmux_pane_id: '%99',
        runtime_ui_pid: SHELL_CODEX_PID, identity_key: 'EECF3E35',
      },
    ])

    await shell.close()
    await app.close()
  })

  it('REGRESSION: a restarted codex carries a NEW thread — no same-thread match, pre-reg consumption proceeds', async () => {
    // Restart-recovery flow: the OLD row still has a bound runtime, but its
    // stored thread is the OLD one; the recovery registration mints a NEW
    // thread, so precedence must NOT fire and the launcher's fresh pre-reg
    // row (same recovered identity) is consumed as before.
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%67', tty: 'ttys010' },
    ]
    autoBindOverrides.ttyProcesses = async () => [
      '91131 91131 91131 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U_NEW"',
    ]
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%67',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys010',
      ui_pid: 91131,
    })

    const { app, dbPath, url, logLines } = await startSeededServer({
      agents: [{
        // Dead pid: the pre-restart carrier is gone.
        agent_id: 'holder-old', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: 99997, tty: 'ttys010', identity_key: 'K1',
      }],
      preRegs: [{ pane_id: '%67', uuid: 'U_NEW', identity_key: 'K1' }],
    })

    const rec = await registerCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_NEW,
    })
    expect(rec.obj.agent_id).toBeDefined()
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', ui_pid: 91131 })
    )
    // Unified decision log: the no-evidence outcome is logged too.
    expect(logLines).toContainEqual(expect.stringContaining(
      'outcome=none rows=0 seats=0'
    ))

    expect(readPreRegs(dbPath)).toEqual([])
    expect(readAgents(dbPath)).toEqual([{
      name: 'aoe-codex', tmux_pane_id: '%67',
      runtime_ui_pid: 91131, identity_key: 'K1',
    }])

    await rec.close()
    await app.close()
  })

  it('a pid-less same-thread row binds EXACTLY its recorded tty/pane — no detection, no pre-reg scan', async () => {
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    // ttys020 hosts the consumable foreign candidate.  Detection is mocked
    // to a live result on purpose: the inherit path must never consult it.
    autoBindOverrides.ttyProcesses = async (tty: string) =>
      tty === 'ttys020' ? [SHELL_CODEX_LINE] : ['555 555 555 S+ -zsh']
    detectTmuxPaneMock.mockResolvedValue({
      ok: true,
      pane: {
        pane_id: '%67',
        session_name: 's1',
        window_index: 0,
        pane_index: 1,
        active: true,
        tty: 'ttys010',
        current_path: '/tmp',
        current_command: 'codex-aarch64-a',
        title: 'codex',
        matched_processes: ['123 codex --remote ws://127.0.0.1:8799'],
        score: 99,
      },
      candidates: [],
    })
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%67',
      verification_mode: 'verified_tty_pane',
      tty: 'ttys010',
    })

    const { app, dbPath, url } = await startSeededServer({
      agents: [{
        agent_id: 'holder-a', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: null, tty: 'ttys010', identity_key: 'K1',
      }],
      preRegs: [foreignPreReg],
    })

    const r2 = await registerCodex(url, {
      name: 'aoe-codex-r2', thread_id: THREAD_T,
    })
    expect(r2.obj.agent_id).toBeDefined()
    // The INHERITED seat (the holder's recorded tty and pane) is bound
    // directly; global pane detection is never consulted.
    expect(bindRuntimeIdentityMock).toHaveBeenCalledTimes(1)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex', ui_tty: 'ttys010', tmux_pane_id: '%67',
      })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()

    // The foreign row survived; K1 followed the seat by thread equality.
    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    expect(readAgents(dbPath)).toEqual([
      {
        name: 'aoe-codex', tmux_pane_id: null,
        runtime_ui_pid: null, identity_key: null,
      },
      {
        name: 'aoe-codex-r2', tmux_pane_id: '%67',
        runtime_ui_pid: null, identity_key: 'K1',
      },
    ])

    await r2.close()
    await app.close()
  })

  it('a failed pid inherit FAILS CLOSED: no pre-reg scan, no detection, no bind', async () => {
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })

    const { app, dbPath, url, logLines } = await startSeededServer({
      agents: [{
        agent_id: 'holder-a', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: process.pid, tty: 'ttys010', identity_key: 'K1',
      }],
      preRegs: [foreignPreReg],
    })

    const r2 = await registerCodex(url, {
      name: 'aoe-codex-r2', thread_id: THREAD_T,
    })
    expect(r2.obj.agent_id).toBeDefined()

    // Exactly one bind attempt: the failed inherit.  Once same-thread
    // evidence exists the daemon NEVER falls back to global detection and
    // NEVER scans the pre-reg table — register succeeds unbound.
    expect(bindRuntimeIdentityMock).toHaveBeenCalledTimes(1)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', ui_pid: process.pid })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()
    // Unified decision log: inherit failure with counts, seat owner, reason.
    expect(logLines).toContainEqual(expect.stringContaining(
      'outcome=inherit_fail_closed rows=1 seats=1 agents=holder-a ' +
      'reason=bind_failed'
    ))

    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    expect(readAgents(dbPath)).toEqual([
      // Nothing moved: the holder keeps pane and key, r2 stays unbound.
      {
        name: 'aoe-codex', tmux_pane_id: '%67',
        runtime_ui_pid: process.pid, identity_key: 'K1',
      },
      {
        name: 'aoe-codex-r2', tmux_pane_id: null,
        runtime_ui_pid: null, identity_key: null,
      },
    ])

    await r2.close()
    await app.close()
  })

  it('multiple DISTINCT physical seats FAIL CLOSED: no pre-reg scan, no detection, no bind', async () => {
    // The foreign pre-reg row is fully consumable and detection would find
    // it too: without the fail-closed rule, ambiguous same-thread evidence
    // would fall back to the foreign scan — the incident shape again.
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%99',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys020',
      ui_pid: SHELL_CODEX_PID,
    })

    const { app, dbPath, url, logLines } = await startSeededServer({
      agents: [
        {
          agent_id: 'holder-a', name: 'A', thread_id: THREAD_T,
          pane: '%11', pid: 77001, tty: 'ttys011', identity_key: null,
        },
        {
          agent_id: 'holder-b', name: 'B', thread_id: THREAD_T,
          pane: '%12', pid: 77002, tty: 'ttys012', identity_key: null,
        },
      ],
      preRegs: [foreignPreReg],
    })

    const r2 = await registerCodex(url, {
      name: 'aoe-codex-r2', thread_id: THREAD_T,
    })
    expect(r2.obj.agent_id).toBeDefined()

    // Same-thread evidence that cannot collapse to ONE physical seat is
    // terminal: register succeeds with NO runtime binding, the foreign
    // pre-reg row is untouched, and no detection ever runs.
    expect(bindRuntimeIdentityMock).not.toHaveBeenCalled()
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()
    // Unified decision log: ambiguity with counts and the involved rows.
    const ambiguousLine = logLines.find(line =>
      line.includes('outcome=ambiguous rows=2 seats=2'))
    expect(ambiguousLine).toBeDefined()
    expect(ambiguousLine).toContain('holder-a')
    expect(ambiguousLine).toContain('holder-b')
    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    expect(readAgents(dbPath)).toContainEqual({
      name: 'aoe-codex-r2', tmux_pane_id: null,
      runtime_ui_pid: null, identity_key: null,
    })

    await r2.close()
    await app.close()
  })

  it('a rename chain A→B→C collapses shared-seat rows to the LWW owner and inherits it', async () => {
    // Natural post-chain state: A and B both keep the SAME pid/tty (only
    // the pane is LWW-cleared on the older row).  Two rows, ONE physical
    // seat — the collapse must inherit it instead of treating >1 rows as
    // ambiguity and (worse) reaching the foreign pre-reg scan.
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) =>
        input.ui_pid === process.pid
          ? {
              ok: true,
              tmux_pane_id: '%67',
              verification_mode: 'verified_pid_tty_pane',
              tty: 'ttys010',
              ui_pid: process.pid,
            }
          : { error: 'pid_not_found' }
    )

    const { app, dbPath, url } = await startSeededServer({
      agents: [
        {
          agent_id: 'holder-a', name: 'chain-a', thread_id: THREAD_T,
          pane: null, pid: process.pid, tty: 'ttys010', identity_key: null,
          bound_at: '2026-01-01T00:00:00Z',
        },
        {
          agent_id: 'holder-b', name: 'chain-b', thread_id: THREAD_T,
          pane: '%67', pid: process.pid, tty: 'ttys010', identity_key: 'K1',
          bound_at: '2026-01-02T00:00:00Z',
        },
      ],
      preRegs: [foreignPreReg],
    })

    const r3 = await registerCodex(url, {
      name: 'chain-c', thread_id: THREAD_T,
    })
    expect(r3.obj.agent_id).toBeDefined()

    // One pid bind against the collapsed seat; no detection.
    expect(bindRuntimeIdentityMock).toHaveBeenCalledTimes(1)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', ui_pid: process.pid })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()

    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    // K1 followed the seat from the LWW owner (chain-b) to chain-c.
    expect(readAgents(dbPath)).toEqual([
      {
        name: 'chain-a', tmux_pane_id: null,
        runtime_ui_pid: process.pid, identity_key: null,
      },
      {
        name: 'chain-b', tmux_pane_id: null,
        runtime_ui_pid: process.pid, identity_key: null,
      },
      {
        name: 'chain-c', tmux_pane_id: '%67',
        runtime_ui_pid: process.pid, identity_key: 'K1',
      },
    ])

    await r3.close()
    await app.close()
  })

  it('a same-name same-thread re-register re-binds its OWN preserved seat and skips the pre-reg scan', async () => {
    // C2 shape: the (device, team, name) upsert reuses the caller row and
    // preserves its runtime, so an exclude-caller query sees ZERO evidence
    // — which used to fall through to the foreign pre-reg scan.  The
    // caller's own preserved bound runtime IS same-session evidence when
    // its pre-upsert stored thread equals the registering thread.
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) =>
        input.ui_pid === process.pid
          ? {
              ok: true,
              tmux_pane_id: '%67',
              verification_mode: 'verified_pid_tty_pane',
              tty: 'ttys010',
              ui_pid: process.pid,
            }
          : { error: 'pid_not_found' }
    )

    const { app, dbPath, url } = await startSeededServer({
      agents: [{
        agent_id: 'holder-a', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: process.pid, tty: 'ttys010', identity_key: 'K1',
      }],
      preRegs: [foreignPreReg],
    })

    const again = await registerCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_T,
    })
    expect(again.obj.agent_id).toBeDefined()

    // One pid bind re-verifying the caller's own preserved seat liveness.
    expect(bindRuntimeIdentityMock).toHaveBeenCalledTimes(1)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', ui_pid: process.pid })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()

    // The foreign row is untouched; the caller keeps its own seat and key.
    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    expect(readAgents(dbPath)).toEqual([{
      name: 'aoe-codex', tmux_pane_id: '%67',
      runtime_ui_pid: process.pid, identity_key: 'K1',
    }])

    await again.close()
    await app.close()
  })

  it('REGRESSION: inherit failure + a detect that WOULD return a foreign pane never binds it', async () => {
    // C3 corruption shape: same-thread evidence exists, the pid inherit
    // fails, and the (forbidden) global detection would have handed the
    // caller the UNRELATED shell codex's pane.  The old fallback would bind
    // %99 and corrupt the runtime identity; the fix must not touch it.
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    detectTmuxPaneMock.mockResolvedValue({
      ok: true,
      pane: {
        pane_id: '%99',
        session_name: 's1',
        window_index: 0,
        pane_index: 2,
        active: true,
        tty: 'ttys020',
        current_path: '/tmp',
        current_command: 'codex-aarch64-a',
        title: 'codex',
        matched_processes: [SHELL_CODEX_LINE],
        score: 99,
      },
      candidates: [],
    })
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) =>
        input.ui_pid === process.pid
          ? { error: 'pid_not_found' }
          : {
              ok: true,
              tmux_pane_id: '%99',
              verification_mode: 'verified_pid_tty_pane',
              tty: 'ttys020',
              ui_pid: SHELL_CODEX_PID,
            }
    )

    const { app, dbPath, url } = await startSeededServer({
      agents: [{
        agent_id: 'holder-a', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: process.pid, tty: 'ttys010', identity_key: 'K1',
      }],
      preRegs: [foreignPreReg],
    })

    const r2 = await registerCodex(url, {
      name: 'aoe-codex-r2', thread_id: THREAD_T,
    })
    expect(r2.obj.agent_id).toBeDefined()

    // Only the failed inherit attempt: detection never ran, so the foreign
    // pane it would have returned was never bound.
    expect(bindRuntimeIdentityMock).toHaveBeenCalledTimes(1)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', ui_pid: process.pid })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()

    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    expect(readAgents(dbPath)).toEqual([
      // Nothing moved: the holder keeps pane and key, r2 stays unbound and
      // is NOT sitting on the shell codex's %99 seat.
      {
        name: 'aoe-codex', tmux_pane_id: '%67',
        runtime_ui_pid: process.pid, identity_key: 'K1',
      },
      {
        name: 'aoe-codex-r2', tmux_pane_id: null,
        runtime_ui_pid: null, identity_key: null,
      },
    ])

    await r2.close()
    await app.close()
  })

  // Seat the concurrent writer B gets bound to in the CAS races below.
  const B_SEAT_PID = 202
  const B_SEAT = {
    ok: true,
    tmux_pane_id: '%20',
    verification_mode: 'verified_pid_tty_pane',
    tty: 'ttys021',
    ui_pid: B_SEAT_PID,
  }

  it('CONCURRENCY (stale false-negative): a concurrent same-name registration rewriting the row mid-probe fails the late writer closed — no foreign scan', async () => {
    // Without the CAS check, A's STALE pre-probe capture (old thread T)
    // filters out the caller row even though the row's ACTUAL prior thread
    // at persist time equals A's registering thread (B wrote it during the
    // probe) — 'none' evidence would fall through to the foreign pre-reg
    // scan and consume the unrelated shell codex's row (round-12 C1 shape).
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) => {
        if (input.ui_pid === B_SEAT_PID) return B_SEAT
        if (input.ui_pid === SHELL_CODEX_PID) {
          // The foreign row IS fully consumable: reaching the scan would bind.
          return {
            ok: true,
            tmux_pane_id: '%99',
            verification_mode: 'verified_pid_tty_pane',
            tty: 'ttys020',
            ui_pid: SHELL_CODEX_PID,
          }
        }
        return { error: 'pid_not_found' }
      }
    )

    const { app, dbPath, url, logLines } = await startSeededServer({
      agents: [{
        agent_id: 'holder-old', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: 99997, tty: 'ttys010', identity_key: null,
      }],
      preRegs: [foreignPreReg],
    })

    // A starts registering (same name, NEW thread) and blocks mid-probe.
    const gate = armProbeGate()
    const a = await startRegisterCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_NEW,
    })
    await gate.entered

    // B rewrites the SAME (device, team, name) row to thread NEW and binds
    // its own seat %20/pid202 while A's probe is still pending.
    const b = await registerCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_NEW, ui_pid: B_SEAT_PID,
    })
    expect(b.obj.agent_id).toBeDefined()
    const bindCallsAfterB = bindRuntimeIdentityMock.mock.calls.length

    gate.release()
    const aObj = await a.done
    // Register itself still succeeds — only the runtime auto-bind fails
    // closed for the raced registration.
    expect(aObj.agent_id).toBeDefined()

    // A made NO bind attempt of its own (B's preflight + bind only), never
    // detected, and never touched the consumable foreign pre-reg row.
    expect(bindRuntimeIdentityMock.mock.calls.length).toBe(bindCallsAfterB)
    expect(bindRuntimeIdentityMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ ui_pid: SHELL_CODEX_PID })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()
    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    // A inherited nothing AND the upsert-preserved residue of B's seat was
    // cleared: the drift registration ends fully unbound, so the tmux
    // fallback has no pane to misdeliver to.
    expect(readAgents(dbPath)).toEqual([{
      name: 'aoe-codex', tmux_pane_id: null,
      runtime_ui_pid: null, identity_key: null,
    }])
    expect(readRuntimeSeat(dbPath, 'aoe-codex')).toEqual({
      tmux_pane_id: null,
      runtime_ui_pid: null,
      runtime_tty: null,
      runtime_verification_mode: null,
      runtime_bound_at: null,
    })
    // The CAS drift fail-closed outcome is logged with its own reason.
    expect(logLines).toContainEqual(expect.stringContaining(
      'outcome=cas_drift'
    ))
    expect(logLines).toContainEqual(expect.stringContaining(
      'reason=row_changed_during_register_probe'
    ))
    expect(logLines).toContainEqual(expect.stringContaining(
      'cas drift runtime clear (debug):'
    ))

    await b.close()
    await a.close()
    await app.close()
  })

  it('BIND-STAGE CONCURRENCY (round-14): a bind suspended in verification never stomps a newer same-name registration', async () => {
    // A passes the CAS check (no probe-window race), resolves its own
    // preserved seat S1, and suspends INSIDE the bind verification await.
    // B then completes a same-name registration with thread U and binds
    // seat S2.  A's late FINAL WRITE carries a stale register_generation,
    // so it must change ZERO rows: without the generation-conditional
    // write, the row would end as `thread U + seat S1` — a cross-session
    // hybrid (the takeover transport close does NOT cancel A's running
    // handler promise).
    const A_SEAT_PID = 4141
    let releaseVerify!: () => void
    const verifyBlocked = new Promise<void>(resolve => { releaseVerify = resolve })
    let signalVerifyEntered!: () => void
    const verifyEntered = new Promise<void>(resolve => {
      signalVerifyEntered = resolve
    })

    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) => {
        if (input.ui_pid === A_SEAT_PID) {
          signalVerifyEntered()
          await verifyBlocked
          return {
            ok: true,
            tmux_pane_id: '%67',
            verification_mode: 'verified_pid_tty_pane',
            tty: 'ttys010',
            ui_pid: A_SEAT_PID,
          }
        }
        if (input.ui_pid === B_SEAT_PID) return B_SEAT
        return { error: 'pid_not_found' }
      }
    )

    const { app, dbPath, url, logLines } = await startSeededServer({
      agents: [{
        agent_id: 'caller-row', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%67', pid: A_SEAT_PID, tty: 'ttys010', identity_key: null,
      }],
      preRegs: [foreignPreReg],
    })

    // A: same name + same thread T → CAS passes, inherit starts, then the
    // bind verification blocks.
    const a = await startRegisterCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_T,
    })
    a.done.catch(() => undefined)
    await verifyEntered

    // B: same-name registration with thread U + seat S2 completes while A
    // hangs in verification (this re-mints the row's generation).
    const b = await registerCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_SHELL, ui_pid: B_SEAT_PID,
    })
    expect(b.obj.agent_id).toBeDefined()
    // register-internal fields never leak into the client envelope.
    expect(b.obj).not.toHaveProperty('register_generation')
    expect(b.obj).not.toHaveProperty('prior_snapshot')

    // Release A's verification; its final write must fail closed.  A's
    // transport may have been takeover-closed by B, so the stale-bind log
    // line (not A's envelope) is the completion signal.
    releaseVerify()
    await vi.waitFor(() => {
      expect(logLines).toContainEqual(expect.stringContaining(
        'reason=stale_registration_bind'
      ))
    })

    // The row keeps B's thread U AND B's seat S2 — A wrote nothing.
    expect(readAgents(dbPath)).toEqual([{
      name: 'aoe-codex', tmux_pane_id: '%20',
      runtime_ui_pid: B_SEAT_PID, identity_key: null,
    }])
    const db = openDb(dbPath)
    applySchema(db, { localDevice: 'local' })
    const stored = db.prepare(
      `SELECT json_extract(delivery_payload, '$.thread_id') AS thread_id
       FROM agents WHERE team='aoe' AND name='aoe-codex'`
    ).get() as { thread_id: string }
    db.close()
    expect(stored.thread_id).toBe(THREAD_SHELL)

    // A ran zero seat-follow, and its outcome is the stale-bind fail-closed
    // path through the unified decision log.
    expect(logLines.filter(line => line.includes('seat-follow'))).toEqual([])
    expect(logLines).toContainEqual(expect.stringContaining(
      'outcome=inherit_fail_closed rows=1 seats=1 agents=caller-row ' +
      'reason=bind_failed'
    ))
    // The unrelated consumable pre-reg row was never scanned or consumed.
    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])

    await b.close()
    await a.close().catch(() => undefined)
    await app.close()
  })

  it('CONCURRENCY (stale false-positive): B rewriting the row to a new thread + its seat mid-probe never becomes A\'s inheritance evidence', async () => {
    // Without the CAS check, A's pre-probe capture (thread T) still equals
    // A's registering thread after B rewrote the row (A's persist restores
    // T), so B's freshly-written seat %20/pid202 — preserved by the upsert —
    // would count as A's own caller-row evidence and A would inherit B's
    // seat (cross-session runtime binding).
    autoBindOverrides.listPanes = async () => [
      { pane_id: '%99', tty: 'ttys020' },
    ]
    autoBindOverrides.ttyProcesses = async () => [SHELL_CODEX_LINE]
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) =>
        input.ui_pid === B_SEAT_PID ? B_SEAT : { error: 'pid_not_found' }
    )

    const { app, dbPath, url, logLines } = await startSeededServer({
      agents: [{
        agent_id: 'holder-old', name: 'aoe-codex', thread_id: THREAD_T,
        pane: '%11', pid: 77001, tty: 'ttys011', identity_key: null,
      }],
      preRegs: [foreignPreReg],
    })

    // A re-registers its own (name, thread T) and blocks mid-probe.
    const gate = armProbeGate()
    const a = await startRegisterCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_T,
    })
    await gate.entered

    // B rewrites the same-name row to thread U and binds seat %20/pid202.
    const b = await registerCodex(url, {
      name: 'aoe-codex', thread_id: THREAD_SHELL, ui_pid: B_SEAT_PID,
    })
    expect(b.obj.agent_id).toBeDefined()
    const bindCallsAfterB = bindRuntimeIdentityMock.mock.calls.length
    // A's persist (thread T ≠ B's thread U) will take over the row binding;
    // close B first so the forced session close cannot race the client.
    await b.close()

    gate.release()
    const aObj = await a.done
    expect(aObj.agent_id).toBeDefined()

    // A does NOT inherit B's seat: no bind call beyond B's own, no
    // detection, and the foreign pre-reg row is untouched.
    expect(bindRuntimeIdentityMock.mock.calls.length).toBe(bindCallsAfterB)
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()
    expect(readPreRegs(dbPath)).toEqual([{
      pane_id: '%99',
      xats_agent_id: 'U_SHELL',
      identity_key: 'EECF3E35',
    }])
    // No bind was performed FOR A, and the COALESCE-preserved residue of
    // B's seat was cleared — the row must not end as "A's thread + B's
    // seat" (the tmux fallback would misdeliver A's messages to B's pane).
    expect(readAgents(dbPath)).toEqual([{
      name: 'aoe-codex', tmux_pane_id: null,
      runtime_ui_pid: null, identity_key: null,
    }])
    expect(readRuntimeSeat(dbPath, 'aoe-codex')).toEqual({
      tmux_pane_id: null,
      runtime_ui_pid: null,
      runtime_tty: null,
      runtime_verification_mode: null,
      runtime_bound_at: null,
    })
    expect(logLines).toContainEqual(expect.stringContaining(
      'outcome=cas_drift'
    ))
    expect(logLines).toContainEqual(expect.stringContaining(
      'cas drift runtime clear (debug):'
    ))

    await a.close()
    await app.close()
  })
})
