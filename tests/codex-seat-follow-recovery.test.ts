import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import { followSeatIdentityKey } from '../src/mcp/codex-seat-follow.js'
import {
  clearAllCodexRecoverySchedules,
  evaluateCodexRecoveryOnPreRegister,
  type CodexRecoveryDeps,
} from '../src/mcp/codex-recovery-poke.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-seat-follow-recovery-'))

const CODEX_LINE =
  '91131 91131 91131 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'
const FG_CODEX_LINE =
  '91131 91131 91131 S+ codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"'

// Recovery interaction: after seat-follow migrated the key from X to Y, the
// recovery module needs NO change — findByIdentityKey resolves to Y and the
// recovery poke content names Y.
describe('codex recovery after a seat-follow migration', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    clearAllCodexRecoverySchedules()
  })

  afterEach(() => {
    clearAllCodexRecoverySchedules()
    vi.useRealTimers()
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('resolves the migrated key to Y and pokes with Y, not X', async () => {
    const dir = tmp()
    cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const agents = new AgentsRepo(db)
    const preReg = new CodexPanePreRegRepo(db)

    const renameThread = '33333333-3333-4333-8333-333333333333'
    const x = agents.register({
      agent_type: 'codex', name: 'X', team: 'aoe', identity_key: 'K1',
      delivery: {
        kind: 'codex-appserver',
        thread_id: renameThread,
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    agents.setRuntimeBinding(x.agent_id, {
      tmux_pane_id: '%1972',
      runtime_ui_pid: 4242,
      runtime_tty: 'ttys001',
      runtime_verification_mode: 'verified_pid_tty_pane',
    })
    // The rename registers with the SAME codex-appserver thread the holder
    // row carries — the thread equality is what authorizes the alive-holder
    // migration (the fallback-bound pid is heuristic, never proof).
    const y = agents.register({
      agent_type: 'codex', name: 'Y', team: 'aoe',
      delivery: {
        kind: 'codex-appserver',
        thread_id: renameThread,
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    agents.setRuntimeBinding(y.agent_id, {
      tmux_pane_id: '%1972',
      runtime_ui_pid: 4242,
      runtime_tty: 'ttys001',
      runtime_verification_mode: 'verified_pid_tty_pane',
    })

    followSeatIdentityKey({
      callerAgentId: y.agent_id,
      deps: {
        findCaller: agentId => {
          const row = agents.findById(agentId)
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
        findKeyHoldersBySeat: agentId =>
          agents.findKeyHoldersBySeat(agentId, 'local'),
        applyPlan: (plan, attachAgentId, key) => {
          const tx = db.transaction(() => {
            if (plan.kind === 'migrate') {
              agents.clearIdentityKey(plan.from_agent_id)
            }
            agents.bindIdentityKey(attachAgentId, key)
          })
          tx()
        },
        isProcessAlive: () => true,
      },
    })

    const resolved = agents.findByIdentityKey('K1', 'local')
    expect(resolved).toHaveLength(1)
    expect(resolved[0]).toMatchObject({ agent_id: y.agent_id, name: 'Y' })
    expect(agents.findById(x.agent_id)?.identity_key).toBeNull()

    // Pane restart: the launcher pre-registers with K1 again; recovery must
    // now guide the pane back to Y.
    const row = {
      pane_id: '%1972',
      xats_agent_id: 'U1',
      identity_key: 'K1',
      expires_at: '2999-01-01T00:00:00.000Z',
    }
    preReg.upsert({
      pane_id: row.pane_id,
      xats_agent_id: row.xats_agent_id,
      identity_key: row.identity_key,
      expires_at: row.expires_at,
    })
    const tmuxPoke = vi.fn(
      async (_args: { pane_id: string; content: string }) => ({
        ok: true as const,
        pane_tail_before: '',
        pane_tail_after: '',
      })
    )
    const deps: CodexRecoveryDeps = {
      repo: preReg,
      findByIdentityKey: key => agents.findByIdentityKey(key, 'local'),
      findByDeclaredIdentity: () => undefined,
      localDevice: 'local',
      isProcessAlive: () => false,
      listPanes: async () => [{ pane_id: '%1972', tty: 'ttys001' }],
      ttyProcesses: async () => [CODEX_LINE],
      foregroundProbeSync: () => [FG_CODEX_LINE],
      probeIntervalMs: 1_000,
      tmuxPoke,
      verifyPaneHost: vi.fn(async () => ({ ok: true as const })),
      paneGuard: vi.fn(async () => 'pass' as const),
      log: vi.fn(),
    }
    evaluateCodexRecoveryOnPreRegister(row, deps)
    await vi.advanceTimersByTimeAsync(0)

    expect(tmuxPoke).toHaveBeenCalledTimes(1)
    const content = tmuxPoke.mock.calls[0][0].content
    expect(content).toContain('name="Y"')
    expect(content).toContain('team="aoe"')
    expect(content).not.toContain('name="X"')
    expect(content).not.toContain('K1')

    db.close()
  })
})
