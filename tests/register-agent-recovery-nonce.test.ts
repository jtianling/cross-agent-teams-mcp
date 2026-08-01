import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { __testOverrides as autoBindOverrides } from '../src/mcp/auto-bind-codex-pane.js'
import {
  clearAllCodexRecoveryNonces,
  mintCodexRecoveryNonce,
} from '../src/mcp/codex-recovery-nonce.js'

const detectTmuxPaneMock = vi.fn()
const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

// Two pending rows is exactly the seeding trigger's firing condition, so this
// fixture would otherwise start real schedules that probe real tmux/ps and
// paste into whatever pane %10 happens to be on this machine.  The tokens here
// are minted by hand: what this file tests is the scan half of the mechanism.
const { evaluateSeedingMock } = vi.hoisted(() => ({
  evaluateSeedingMock: vi.fn(),
}))

vi.mock('../src/mcp/codex-seeding-poke.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/mcp/codex-seeding-poke.js')>()
  return { ...actual, evaluateCodexSeedingOnPreRegister: evaluateSeedingMock }
})

// Recorder only — it calls straight through, so recovery behaves normally.
// Its sole purpose is to pin the ORDER of the two evaluations (see the
// ordering test below).
const { recoveryOrderSpy } = vi.hoisted(() => ({
  recoveryOrderSpy: vi.fn(),
}))

vi.mock('../src/mcp/codex-recovery-poke.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/mcp/codex-recovery-poke.js')>()
  return {
    ...actual,
    evaluateCodexRecoveryOnPreRegister: (
      ...args: Parameters<typeof actual.evaluateCodexRecoveryOnPreRegister>
    ) => {
      recoveryOrderSpy()
      return actual.evaluateCodexRecoveryOnPreRegister(...args)
    },
  }
})

vi.mock('../src/mcp/register-codex-self.js', () => {
  return {
    RegisterCodexSelfService: class {
      constructor(private readonly registerSvc: { register: (input: unknown) => unknown }) {}
      register(input: {
        connection_id: string
        name: string
        model?: string
        team?: string
        thread_id?: string
        ws_url?: string
      }) {
        const result = this.registerSvc.register({
          connection_id: input.connection_id,
          agent_type: 'codex',
          model: input.model ?? 'codex',
          name: input.name,
          team: input.team,
          delivery: {
            kind: 'codex-appserver',
            thread_id: input.thread_id,
            ws_url: input.ws_url || 'ws://127.0.0.1:8799',
          },
        }) as Record<string, unknown>
        if ('error' in result) return result
        return { ...result, thread_id: input.thread_id, ws_url: 'ws://127.0.0.1:8799' }
      }
    },
  }
})

const THREAD_A = '11111111-1111-4111-8111-111111111111'
const THREAD_B = '22222222-2222-4222-8222-222222222222'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-recovery-nonce-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

// Two panes, each hosting its own carrier carrying its OWN row's uuid — the
// ordinary shape after one restart fans out to two panes, and the shape that
// makes the scan's "exactly one machine-wide candidate" rule fail closed.
const PANES = [
  { pane_id: '%10', tty: 'ttys001', uuid: 'U_LEFT', pid: 5010 },
  { pane_id: '%20', tty: 'ttys002', uuid: 'U_RIGHT', pid: 5020 },
]

function carrierLine(pid: number, uuid: string): string {
  return `${pid} ${pid} ${pid} Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="${uuid}"`
}

describe('register_agent selects its pre-reg row by recovery nonce', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
    evaluateSeedingMock.mockReset()
    recoveryOrderSpy.mockClear()
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    clearAllCodexRecoveryNonces()
    autoBindOverrides.listPanes = async () =>
      PANES.map(p => ({ pane_id: p.pane_id, tty: p.tty }))
    autoBindOverrides.ttyProcesses = async (tty: string) => {
      const pane = PANES.find(p => p.tty === tty)
      return pane ? [carrierLine(pane.pid, pane.uuid)] : []
    }
    bindRuntimeIdentityMock.mockImplementation(
      async (input: { ui_pid?: number }) => {
        const pane = PANES.find(p => p.pid === input.ui_pid)
        if (!pane) return { error: 'pid_not_found' }
        return {
          ok: true,
          tmux_pane_id: pane.pane_id,
          verification_mode: 'verified_pid_tty_pane',
          tty: pane.tty,
          ui_pid: pane.pid,
        }
      }
    )
  })

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    delete autoBindOverrides.listPanes
    delete autoBindOverrides.ttyProcesses
    clearAllCodexRecoveryNonces()
  })

  async function startWithBothPanesPending(): Promise<{
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
      dbPath, port: 0, mcpLog: line => { logLines.push(line) },
    })
    const url = new URL(`http://${host}:${port}/mcp`)

    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'launcher', version: '0.0.0' })
    await c.connect(t)
    for (const pane of PANES) {
      const resp = await c.callTool({
        name: 'pre_register_codex_pane',
        arguments: { pane_id: pane.pane_id, xats_agent_id: pane.uuid },
      })
      expect(await parseTool(resp)).toMatchObject({ ok: true })
    }
    // The trigger is wired to run on every accepted write, not only the one
    // that makes the count ambiguous.
    expect(evaluateSeedingMock).toHaveBeenCalledTimes(PANES.length)
    // "One live token per pane" holds only if recovery has already claimed its
    // panes by the time seeding decides which ones still need a token.  Run
    // the other way round, a pane would take a seeding token and then a
    // recovery schedule as well, and whichever minted last would silently
    // invalidate the notice already sitting in the pane.  A comment at the
    // call site is not enough to keep an ordering that load-bearing.
    expect(recoveryOrderSpy).toHaveBeenCalledTimes(PANES.length)
    expect(recoveryOrderSpy.mock.invocationCallOrder[0])
      .toBeLessThan(evaluateSeedingMock.mock.invocationCallOrder[0])
    await t.close()
    await c.close()
    return { app, dbPath, url, logLines }
  }

  async function registerCodex(
    url: URL,
    args: { name: string; thread_id: string; recovery_nonce?: string }
  ): Promise<{ obj: Record<string, unknown>; close: () => Promise<void> }> {
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)
    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'codex', team: 'lab', ...args },
    })
    return {
      obj: await parseTool(resp),
      close: async () => { await t.close(); await c.close() },
    }
  }

  function readRow(dbPath: string, name: string): {
    tmux_pane_id: string | null
    runtime_ui_pid: number | null
  } {
    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      'SELECT tmux_pane_id, runtime_ui_pid FROM agents WHERE team=? AND name=?'
    ).get('lab', name) as { tmux_pane_id: string | null; runtime_ui_pid: number | null }
    db.close()
    return row
  }

  function readPreRegPanes(dbPath: string): string[] {
    const db = openDb(dbPath)
    applySchema(db)
    const rows = db.prepare(
      'SELECT pane_id FROM codex_pane_pre_registrations ORDER BY pane_id'
    ).all() as Array<{ pane_id: string }>
    db.close()
    return rows.map(r => r.pane_id)
  }

  it('two overlapping pre-reg windows: each caller binds ITS OWN pane', async () => {
    // Today both registrations are refused with candidate_count and neither
    // binds — which also blocks the consume step, the only way an identity key
    // ever reaches an agent row.  The nonce is issued by the daemon to ONE
    // known pane, so echoing it back says which row is whose.
    const { app, dbPath, url, logLines } = await startWithBothPanesPending()

    const left = await registerCodex(url, {
      name: 'agent-left',
      thread_id: THREAD_A,
      recovery_nonce: mintCodexRecoveryNonce('%10'),
    })
    expect(left.obj.agent_id).toBeDefined()

    const right = await registerCodex(url, {
      name: 'agent-right',
      thread_id: THREAD_B,
      recovery_nonce: mintCodexRecoveryNonce('%20'),
    })
    expect(right.obj.agent_id).toBeDefined()

    expect(readRow(dbPath, 'agent-left')).toEqual({
      tmux_pane_id: '%10', runtime_ui_pid: 5010,
    })
    expect(readRow(dbPath, 'agent-right')).toEqual({
      tmux_pane_id: '%20', runtime_ui_pid: 5020,
    })
    expect(readPreRegPanes(dbPath)).toEqual([])
    expect(logLines.filter(l => l.includes('candidate_count'))).toEqual([])

    await left.close()
    await right.close()
    await app.close()
  })

  it('an unrelated pending row does not block a nonce-directed registration', async () => {
    // Measured in the lab: an entirely unrelated session's pending row made a
    // single-pane recovery fail.  The blast radius is "any recovery while
    // another codex pane started within the TTL", not "sessions with two panes".
    const { app, dbPath, url, logLines } = await startWithBothPanesPending()

    const left = await registerCodex(url, {
      name: 'agent-left',
      thread_id: THREAD_A,
      recovery_nonce: mintCodexRecoveryNonce('%10'),
    })
    expect(left.obj.agent_id).toBeDefined()

    expect(readRow(dbPath, 'agent-left')).toEqual({
      tmux_pane_id: '%10', runtime_ui_pid: 5010,
    })
    // The stranger's row is untouched — targeting must not consume it.
    expect(readPreRegPanes(dbPath)).toEqual(['%20'])
    expect(logLines.filter(l => l.includes('candidate_count'))).toEqual([])

    await left.close()
    await app.close()
  })

  it('no nonce keeps today behaviour exactly: candidate_count, nothing consumed', async () => {
    // The fallback must stay byte-for-byte what it is now, so that a model
    // which ignores the instruction is no worse off than before.
    const { app, dbPath, url, logLines } = await startWithBothPanesPending()

    const left = await registerCodex(url, { name: 'agent-left', thread_id: THREAD_A })
    expect(left.obj.agent_id).toBeDefined()

    expect(readRow(dbPath, 'agent-left')).toEqual({
      tmux_pane_id: null, runtime_ui_pid: null,
    })
    expect(readPreRegPanes(dbPath)).toEqual(['%10', '%20'])
    expect(logLines).toContainEqual(expect.stringContaining(
      'reason=candidate_count'
    ))

    await left.close()
    await app.close()
  })

  it('a stale or invented nonce falls back instead of erroring', async () => {
    // An unknown token means "no correlation offered", never a failed call.
    const { app, dbPath, url, logLines } = await startWithBothPanesPending()

    const left = await registerCodex(url, {
      name: 'agent-left',
      thread_id: THREAD_A,
      recovery_nonce: 'not-a-real-nonce',
    })
    expect(left.obj.agent_id).toBeDefined()
    expect(left.obj.error).toBeUndefined()

    expect(readPreRegPanes(dbPath)).toEqual(['%10', '%20'])
    expect(logLines).toContainEqual(expect.stringContaining(
      'reason=candidate_count'
    ))

    await left.close()
    await app.close()
  })
})
