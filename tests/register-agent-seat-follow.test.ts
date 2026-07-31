import { afterEach, describe, expect, it, vi } from 'vitest'
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

const THREAD_X = '11111111-1111-4111-8111-111111111111'
const THREAD_UNRELATED = '22222222-2222-4222-8222-222222222222'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-seat-follow-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

// The rename scenario: the pre-reg row was consumed at the first
// registration, so nothing but the seat-follow hook can move the
// launcher-minted identity_key to the new row.  A same-thread rename now
// takes the SAME-THREAD PRECEDENCE path first (inheriting the holder row's
// pid when it has one); a pid-less holder still flows through the
// detect_tmux_pane FALLBACK bind.  AUTHORIZATION: an ALIVE holder migrates
// ONLY on codex-appserver thread equality — a same-conversation rename
// registers with the SAME thread_id the holder row already carries.  The
// pid the fallback carrier probe hands the caller comes from a GLOBAL pane
// heuristic never tied to this caller, so pid equality must never move an
// alive holder's key.
describe('register_agent seat-follow (rename on the same pane)', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
    delete autoBindOverrides.listPanes
    delete autoBindOverrides.ttyProcesses
    delete autoBindOverrides.now
  })

  function mockDetectedPane(): void {
    detectTmuxPaneMock.mockResolvedValue({
      ok: true,
      pane: {
        pane_id: '%1902',
        session_name: 's1',
        window_index: 0,
        pane_index: 1,
        active: true,
        tty: 'ttys026',
        current_path: '/tmp',
        current_command: 'codex-aarch64-a',
        title: 'codex',
        matched_processes: ['123 codex --remote ws://127.0.0.1:8799'],
        score: 99,
      },
      candidates: [],
    })
  }

  async function startSeededServer(
    opts: { holderPid?: number | null } = {}
  ): Promise<{
    app: { close: () => Promise<void> }
    dbPath: string
    url: URL
  }> {
    const holderPid = opts.holderPid === undefined
      ? process.pid
      : opts.holderPid
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })

    // Seed the pre-rename row X: seat bound at seeding time (pane, tty, and
    // by default the STILL-RUNNING codex process pid — or NO pid at all for
    // the liveness-unknown shape), holding the launcher key K1 and a
    // codex-appserver delivery carrying its conversation thread.
    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    seed.prepare(
      `INSERT INTO agents
         (agent_id, device, team, role, name, registered_at, last_seen_at,
          tmux_pane_id, runtime_ui_pid, runtime_tty, identity_key,
          delivery_kind, delivery_payload)
       VALUES (?, 'local', 'aoe', 'default', 'X', ?, ?, '%1902', ?,
               'ttys026', 'K1', 'codex-appserver', ?)`
    ).run(
      'holder-x',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
      holderPid,
      JSON.stringify({ thread_id: THREAD_X, ws_url: 'ws://127.0.0.1:8799' })
    )
    seed.close()

    return { app, dbPath, url: new URL(`http://${host}:${port}/mcp`) }
  }

  async function registerY(url: URL, threadId: string): Promise<{
    obj: Record<string, unknown>
    close: () => Promise<void>
  }> {
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)
    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'codex',
        model: 'gpt-5',
        name: 'Y',
        team: 'aoe',
        thread_id: threadId,
      },
    })
    const obj = await parseTool(resp)
    return {
      obj,
      close: async () => {
        await t.close()
        await c.close()
      },
    }
  }

  function readRows(dbPath: string): Array<{
    name: string
    tmux_pane_id: string | null
    identity_key: string | null
  }> {
    const db = openDb(dbPath)
    applySchema(db, { localDevice: 'local' })
    const rows = db.prepare(
      `SELECT name, tmux_pane_id, identity_key FROM agents
       WHERE team='aoe' ORDER BY name`
    ).all() as Array<{
      name: string
      tmux_pane_id: string | null
      identity_key: string | null
    }>
    db.close()
    return rows
  }

  it('migrates the key on a same-thread rename via the inherited-pid bind', async () => {
    mockDetectedPane()
    // Same-thread precedence: the rename inherits the holder row's
    // still-running pid directly (no pane detection, no carrier probe).
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys026',
      ui_pid: process.pid,
    })

    const { app, dbPath, url } = await startSeededServer()
    // Same conversation renaming itself: SAME thread as the holder row.
    const { obj, close } = await registerY(url, THREAD_X)
    expect(obj.agent_id).toBeDefined()
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        ui_pid: process.pid,
      })
    )
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()

    expect(readRows(dbPath)).toEqual([
      // The abandoned row lost both the pane binding and the key.
      { name: 'X', tmux_pane_id: null, identity_key: null },
      { name: 'Y', tmux_pane_id: '%1902', identity_key: 'K1' },
    ])

    await close()
    await app.close()
  })

  it('migrates the key on a same-thread rename even when the bind lands pid-less', async () => {
    mockDetectedPane()
    // Same-thread precedence inherits the holder pid, but the bind result
    // records no pid (verified_tty_pane shape).  The thread equality — not
    // any pid — is what authorizes the migration.
    autoBindOverrides.ttyProcesses = async () => ['555 555 555 S+ -zsh']
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_tty_pane',
      tty: 'ttys026',
    })

    const { app, dbPath, url } = await startSeededServer()
    const { obj, close } = await registerY(url, THREAD_X)
    expect(obj.agent_id).toBeDefined()

    expect(readRows(dbPath)).toEqual([
      { name: 'X', tmux_pane_id: null, identity_key: null },
      { name: 'Y', tmux_pane_id: '%1902', identity_key: 'K1' },
    ])

    await close()
    await app.close()
  })

  it('REGRESSION: an unrelated codex handed the holder pane/pid never takes the key', async () => {
    // Reviewer repro: the global detect heuristic picks ALIVE holder X's
    // pane, the carrier probe hands unrelated caller Y X's very pid, and Y
    // registers with a DIFFERENT codex thread.  Pid equality must not move
    // the key: every row's identity_key stays exactly as before.
    mockDetectedPane()
    autoBindOverrides.ttyProcesses = async () => [
      `${process.pid} ${process.pid} ${process.pid} S+ codex --remote ws://127.0.0.1:8799`,
    ]
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys026',
      ui_pid: process.pid,
    })

    const { app, dbPath, url } = await startSeededServer()
    expect(readRows(dbPath)).toEqual([
      { name: 'X', tmux_pane_id: '%1902', identity_key: 'K1' },
    ])

    const { obj, close } = await registerY(url, THREAD_UNRELATED)
    expect(obj.agent_id).toBeDefined()

    expect(readRows(dbPath)).toEqual([
      // X keeps its identity key: alive holder, thread mismatch — no move.
      // (The pane binding itself still follows last-writer-wins.)
      { name: 'X', tmux_pane_id: null, identity_key: 'K1' },
      { name: 'Y', tmux_pane_id: '%1902', identity_key: null },
    ])

    await close()
    await app.close()
  })

  it('keeps the key on an ALIVE holder when the fallback stays pid-less and threads differ', async () => {
    mockDetectedPane()
    // No foreground codex carrier on the tty (shell only): the fallback
    // binds tty/pane without a pid; the caller's thread differs from the
    // alive holder's, so seat-follow must fail closed.
    autoBindOverrides.ttyProcesses = async () => ['555 555 555 S+ -zsh']
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_tty_pane',
      tty: 'ttys026',
    })

    const { app, dbPath, url } = await startSeededServer()
    const { obj, close } = await registerY(url, THREAD_UNRELATED)
    expect(obj.agent_id).toBeDefined()
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        ui_tty: 'ttys026',
        tmux_pane_id: '%1902',
      })
    )

    expect(readRows(dbPath)).toEqual([
      { name: 'X', tmux_pane_id: null, identity_key: 'K1' },
      { name: 'Y', tmux_pane_id: '%1902', identity_key: null },
    ])

    await close()
    await app.close()
  })

  it('REGRESSION: a pid-less holder is liveness-UNKNOWN — a different-thread caller never takes its key', async () => {
    // Reviewer repro: X bound its seat WITHOUT a pid (verified_tty_pane is a
    // legitimate LIVE state), an unrelated codex Y is handed the same pane
    // and registers with a DIFFERENT thread.  A missing pid must read as
    // liveness unknown — not dead — so every identity_key stays put.
    mockDetectedPane()
    autoBindOverrides.ttyProcesses = async () => ['555 555 555 S+ -zsh']
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_tty_pane',
      tty: 'ttys026',
    })

    const { app, dbPath, url } = await startSeededServer({ holderPid: null })
    const { obj, close } = await registerY(url, THREAD_UNRELATED)
    expect(obj.agent_id).toBeDefined()

    expect(readRows(dbPath)).toEqual([
      // X keeps its identity key: liveness unknown + thread mismatch — no
      // move.  (The pane binding itself still follows last-writer-wins.)
      { name: 'X', tmux_pane_id: null, identity_key: 'K1' },
      { name: 'Y', tmux_pane_id: '%1902', identity_key: null },
    ])

    await close()
    await app.close()
  })

  it('migrates the key from a pid-less holder on a same-thread rename', async () => {
    // Same conversation renaming itself when its original bind recorded no
    // pid: thread equality authorizes the move exactly as for an alive
    // holder.
    mockDetectedPane()
    autoBindOverrides.ttyProcesses = async () => ['555 555 555 S+ -zsh']
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_tty_pane',
      tty: 'ttys026',
    })

    const { app, dbPath, url } = await startSeededServer({ holderPid: null })
    const { obj, close } = await registerY(url, THREAD_X)
    expect(obj.agent_id).toBeDefined()

    expect(readRows(dbPath)).toEqual([
      { name: 'X', tmux_pane_id: null, identity_key: null },
      { name: 'Y', tmux_pane_id: '%1902', identity_key: 'K1' },
    ])

    await close()
    await app.close()
  })

  it('REGRESSION: a failed carrier-pid bind never degrades to a tty fallback', async () => {
    // The carrier probe returns a pid but the pid bind fails
    // (pid_not_found): exactly one bind attempt, no tty-only retry, no
    // seat-follow, no key movement, and X keeps its pane binding.  The
    // caller registers with an UNRELATED thread so the carrier-probe path
    // (not same-thread inheritance) is what gets exercised.
    mockDetectedPane()
    autoBindOverrides.ttyProcesses = async () => [
      `${process.pid} ${process.pid} ${process.pid} S+ codex --remote ws://127.0.0.1:8799`,
    ]
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })

    const { app, dbPath, url } = await startSeededServer()
    const { obj, close } = await registerY(url, THREAD_UNRELATED)
    expect(obj.agent_id).toBeDefined()

    expect(bindRuntimeIdentityMock).toHaveBeenCalledTimes(1)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        ui_pid: process.pid,
        tmux_pane_id: '%1902',
      })
    )

    expect(readRows(dbPath)).toEqual([
      // Nothing persisted: X keeps pane and key, Y stays unbound and keyless.
      { name: 'X', tmux_pane_id: '%1902', identity_key: 'K1' },
      { name: 'Y', tmux_pane_id: null, identity_key: null },
    ])

    await close()
    await app.close()
  })
})
