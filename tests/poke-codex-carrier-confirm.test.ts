import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
  return {
    ...actual,
    isTmuxAvailable: vi.fn(async () => true),
    capturePaneTail: vi.fn(async () => 'tail'),
    loadBuffer: vi.fn(async () => {}),
    pasteBuffer: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    deleteBuffer: vi.fn(async () => {}),
  }
})

// The legacy NULL-agent_type regression drives poke() through a real
// codex-appserver delivery row; the app-server transport itself must fail
// with an ordinary error so the dispatcher takes the tmux fallback.
vi.mock('../src/mcp/codex-appserver-dispatch.js', () => ({
  dispatchCodexAppserverPoke: vi.fn(async () => ({
    error: 'codex_turn_start_failed',
    detail: { code: -32002, message: 'busy' },
    transport_used: 'codex-appserver' as const,
  })),
}))

import * as tmuxCli from '../src/daemon/tmux-cli.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { poke, type PokeDeps } from '../src/mcp/poke.js'
import type { TmuxPaneRow } from '../src/daemon/tmux-pane-list.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-codex-carrier-'))

// The bound codex pid must read as alive to the pane-host verifier; the test
// process's own pid is the only pid guaranteed alive without touching ps.
const PID = process.pid
const FG_CODEX = `${PID} ${PID} ${PID} S+ codex --remote ws://127.0.0.1:8799`
const BG_CODEX = `${PID} ${PID} 555 S codex --remote ws://127.0.0.1:8799`
const FG_SHELL = '555 555 555 S+ -zsh'
// Real aoe launch shape: the bound ui_pid is the node wrapper (process-group
// leader) whose argv is `node .../bin/codex --remote ...`; the native child
// shares the pgid and sits on the same tty.
const FG_WRAPPER_CODEX =
  `${PID} ${PID} ${PID} Ss+ node /Users/jtianling/.nvm/versions/node/`
  + 'v22.11.0/bin/codex --remote ws://127.0.0.1:8799'
const FG_SIBLING_CHILD =
  `${PID + 1} ${PID} ${PID} S+ /Users/jtianling/.local/share/`
  + 'codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex --remote '
  + 'ws://127.0.0.1:8799'

function seedAgent(
  db: ReturnType<typeof openDb>,
  args: {
    agentId: string
    name: string
    agentType?: string
    paneId?: string
    uiPid?: number
    deliveryKind?: string
    deliveryPayload?: string
  }
): void {
  db.prepare(
    `INSERT INTO agents
       (agent_id, device, team, role, name, agent_type, registered_at,
        last_seen_at, tmux_pane_id, runtime_ui_pid, delivery_kind,
        delivery_payload)
     VALUES (?, 'local', 'default', 'impl', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.agentId,
    args.name,
    args.agentType ?? null,
    '2026-01-01T00:00:00Z',
    '2026-01-01T00:00:00Z',
    args.paneId ?? null,
    args.uiPid ?? null,
    args.deliveryKind ?? 'none',
    args.deliveryPayload ?? null
  )
}

const CODEX_APPSERVER_PAYLOAD = JSON.stringify({
  thread_id: '11111111-1111-4111-8111-111111111111',
  ws_url: 'ws://127.0.0.1:8799',
})

function paneRow(paneId: string): TmuxPaneRow {
  return {
    pane_id: paneId,
    session_name: 's',
    window_index: 0,
    pane_index: 0,
    active: true,
    tty: 'ttys001',
    current_path: '/tmp',
    current_command: 'zsh',
    title: '',
    pane_pid: PID,
  }
}

// Reviewer repro for the GENERIC codex poke path: the DB-only ownership read
// cannot see a backgrounded codex whose shell owns the tty foreground, so the
// write checkpoints must also demand the foreground-carrier proof.
describe('generic codex tmux fallback carrier confirm', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>

  beforeEach(() => {
    vi.clearAllMocks()
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    seedAgent(db, { agentId: 'caller-1', name: 'caller' })
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function makeDeps(overrides: Partial<PokeDeps> = {}): PokeDeps {
    return {
      db,
      callerAgentId: 'caller-1',
      localDevice: 'local',
      paneSnapshot: async () => new Map([['%10', paneRow('%10')]]),
      paneTtySync: vi.fn(() => 'ttys001'),
      foregroundProbeSync: vi.fn(() => [FG_CODEX]),
      ...overrides,
    }
  }

  function expectNothingWritten(): void {
    expect(vi.mocked(tmuxCli.capturePaneTail)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.loadBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
  }

  it('a backgrounded codex with a foreground shell blocks the wake', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', agentType: 'codex',
      paneId: '%10', uiPid: PID,
    })
    const deps = makeDeps({
      foregroundProbeSync: vi.fn(() => [BG_CODEX, FG_SHELL]),
    })
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ error: 'pane_reassigned' })
    expectNothingWritten()
  })

  it('a foreground codex passes all three checkpoints and executes', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', agentType: 'codex',
      paneId: '%10', uiPid: PID,
    })
    const deps = makeDeps()
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke' })
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
    // Pre-capture, pre-paste, and pre-Enter each re-ran the carrier probe.
    expect(deps.foregroundProbeSync).toHaveBeenCalledTimes(3)
  })

  it('a node-wrapper leader line with a sibling child passes the proof', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', agentType: 'codex',
      paneId: '%10', uiPid: PID,
    })
    const deps = makeDeps({
      foregroundProbeSync: vi.fn(() => [FG_WRAPPER_CODEX, FG_SIBLING_CHILD]),
    })
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke' })
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
    expect(deps.foregroundProbeSync).toHaveBeenCalledTimes(3)
  })

  it('a codex backgrounded during the settle window loses the Enter', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', agentType: 'codex',
      paneId: '%10', uiPid: PID,
    })
    const probes = [[FG_CODEX], [FG_CODEX], [BG_CODEX, FG_SHELL]]
    const deps = makeDeps({
      foregroundProbeSync: vi.fn(() => probes.shift() ?? [FG_SHELL]),
    })
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ error: 'ownership_lost' })
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
  })

  it('a carrier-probe error fails closed', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', agentType: 'codex',
      paneId: '%10', uiPid: PID,
    })
    const deps = makeDeps({
      foregroundProbeSync: vi.fn(() => { throw new Error('ps: EPERM') }),
    })
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ error: 'pane_reassigned' })
    expectNothingWritten()
  })

  it('an unresolvable pane tty fails closed', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', agentType: 'codex',
      paneId: '%10', uiPid: PID,
    })
    const deps = makeDeps({ paneTtySync: vi.fn(() => undefined) })
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ error: 'pane_reassigned' })
    expectNothingWritten()
  })

  it('a codex row without runtime_ui_pid keeps the DB-only confirm', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', agentType: 'codex', paneId: '%10',
    })
    const deps = makeDeps()
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke' })
    expect(deps.foregroundProbeSync).not.toHaveBeenCalled()
  })

  // C1 regression: the raw row has agent_type=NULL, but its codex-appserver
  // delivery resolves the EFFECTIVE type to codex; the tmux fallback after an
  // ordinary app-server error must still demand the carrier proof.
  it('a legacy NULL agent_type codex-appserver row still demands the proof', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', paneId: '%10', uiPid: PID,
      deliveryKind: 'codex-appserver', deliveryPayload: CODEX_APPSERVER_PAYLOAD,
    })
    const deps = makeDeps({
      foregroundProbeSync: vi.fn(() => [BG_CODEX, FG_SHELL]),
    })
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ error: 'pane_reassigned' })
    expect(deps.foregroundProbeSync).toHaveBeenCalled()
    expectNothingWritten()
  })

  it('a legacy NULL agent_type row with a foreground codex proceeds on fallback', async () => {
    seedAgent(db, {
      agentId: 'codex-1', name: 'worker', paneId: '%10', uiPid: PID,
      deliveryKind: 'codex-appserver', deliveryPayload: CODEX_APPSERVER_PAYLOAD,
    })
    const deps = makeDeps()
    const res = await poke(deps, {
      target_agent_id: 'codex-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke' })
    expect(deps.foregroundProbeSync).toHaveBeenCalledTimes(3)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
  })

  it('non-codex targets never consult the carrier probe', async () => {
    seedAgent(db, {
      agentId: 'claude-1', name: 'reviewer', agentType: 'claude-code',
      paneId: '%10', uiPid: PID,
    })
    const deps = makeDeps()
    const res = await poke(deps, {
      target_agent_id: 'claude-1', prompt: 'wake', skipGuard: true,
    })
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke' })
    expect(deps.foregroundProbeSync).not.toHaveBeenCalled()
    expect(deps.paneTtySync).not.toHaveBeenCalled()
  })
})
