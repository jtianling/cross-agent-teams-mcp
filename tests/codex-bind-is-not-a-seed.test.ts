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
  __peekCodexRecoverySchedules,
  clearAllCodexRecoverySchedules,
} from '../src/mcp/codex-recovery-poke.js'
import {
  __peekCodexSeedingSchedules,
  clearAllCodexSeedingSchedules,
} from '../src/mcp/codex-seeding-poke.js'

const detectTmuxPaneMock = vi.fn()
const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

// See register-agent-codex-pre-reg.test.ts: skip the codex-appserver WS
// handshake while keeping the real agent-row writes this file asserts on.
vi.mock('../src/mcp/register-codex-self.js', () => {
  return {
    RegisterCodexSelfService: class {
      constructor(private readonly registerSvc: { register: (input: unknown) => unknown }) {}
      register(input: {
        connection_id: string
        name: string
        team?: string
        thread_id?: string
      }) {
        const result = this.registerSvc.register({
          connection_id: input.connection_id,
          agent_type: 'codex',
          model: 'codex',
          name: input.name,
          team: input.team,
          delivery: {
            kind: 'codex-appserver',
            thread_id: input.thread_id,
            ws_url: 'ws://127.0.0.1:8799',
          },
        }) as Record<string, unknown>
        if ('error' in result) return result
        return { ...result, thread_id: input.thread_id, ws_url: 'ws://127.0.0.1:8799' }
      }
    },
  }
})

const VALID_THREAD_ID = '33333333-3333-4333-8333-333333333333'
const PANE = '%30'
const TTY = 'ttys003'
const CARRIER_PID = 7030
const CARRIER_LINE =
  `${CARRIER_PID} ${CARRIER_PID} ${CARRIER_PID} S+ codex --remote `
  + 'ws://127.0.0.1:8799 -c xats.agent_id="U_FALLBACK"'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-bind-not-seed-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

// Measured in production: an agent row with a bound pid, delivering pokes, and
// no identity_key at all.  From outside that state is indistinguishable from a
// recoverable one, and reading "it binds fine" as "it will recover" is what let
// the seeding gap stand — so the difference is asserted rather than assumed.
describe('a runtime bind is not an identity seed', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
    clearAllCodexRecoverySchedules()
    clearAllCodexSeedingSchedules()
    detectTmuxPaneMock.mockResolvedValue({
      ok: true,
      pane: { pane_id: PANE, tty: TTY },
    })
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: PANE,
      verification_mode: 'verified_pid_tty_pane',
      tty: TTY,
      ui_pid: CARRIER_PID,
    })
    autoBindOverrides.listPanes = async () => [{ pane_id: PANE, tty: TTY }]
    autoBindOverrides.ttyProcesses = async () => [CARRIER_LINE]
  })

  afterEach(() => {
    clearAllCodexRecoverySchedules()
    clearAllCodexSeedingSchedules()
    delete autoBindOverrides.listPanes
    delete autoBindOverrides.ttyProcesses
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('the detect fallback binds a pid and attaches no key, so nothing recovers', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({
      dbPath, port: 0, localDevice: 'local',
    })
    const url = new URL(`http://${host}:${port}/mcp`)

    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)
    // No pending pre-reg row exists, so the scan finds nothing and the
    // detect_tmux_pane fallback is what binds this pane.
    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'codex', name: 'codex-r2', team: 'aoe',
        thread_id: VALID_THREAD_ID,
      },
    })
    expect((await parseTool(resp)).agent_id).toBeDefined()

    const db = openDb(dbPath)
    applySchema(db, { localDevice: 'local' })
    const row = db.prepare(
      'SELECT tmux_pane_id, runtime_ui_pid, identity_key FROM agents ' +
      'WHERE team=? AND name=?'
    ).get('aoe', 'codex-r2') as {
      tmux_pane_id: string | null
      runtime_ui_pid: number | null
      identity_key: string | null
    }
    // Bound and deliverable...
    expect(row.tmux_pane_id).toBe(PANE)
    expect(row.runtime_ui_pid).toBe(CARRIER_PID)
    // ...and holding no key, so it has no restart recovery at all.
    expect(row.identity_key).toBeNull()
    db.close()

    // The restart: the launcher announces the same pane with a key, and the
    // daemon finds no identity holding it, so no recovery round exists to
    // schedule.  One pending row is also below the seeding trigger.
    const launcherT = new StreamableHTTPClientTransport(url)
    const launcher = new Client({ name: 'launcher', version: '0.0.0' })
    await launcher.connect(launcherT)
    const preReg = await launcher.callTool({
      name: 'pre_register_codex_pane',
      arguments: {
        pane_id: PANE, xats_agent_id: 'U_FALLBACK_2', identity_key: 'K_R2',
      },
    })
    expect(await parseTool(preReg)).toMatchObject({ ok: true })
    expect(__peekCodexRecoverySchedules()).toEqual([])
    expect(__peekCodexSeedingSchedules()).toEqual([])

    await launcherT.close()
    await launcher.close()
    await t.close()
    await c.close()
    await app.close()
  })
})
