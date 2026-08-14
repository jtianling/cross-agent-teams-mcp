import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { scheduleRetry, __peekRetryMap, clearAllRetries } from '../src/mcp/poke-retry.js'
import { scheduleKimiRetry, __peekKimiRetryMap, clearAllKimiRetries } from '../src/mcp/kimi-poke-retry.js'
import {
  __peekCodexRecoverySchedules,
  clearAllCodexRecoverySchedules,
  evaluateCodexRecoveryOnPreRegister,
} from '../src/mcp/codex-recovery-poke.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import type { IdentityKeyMatch } from '../src/storage/agents-repo.js'

describe('daemon shutdown clears pending poke-retry timers', () => {
  const cleanups: string[] = []
  afterEach(() => {
    clearAllRetries()
    clearAllKimiRetries()
    clearAllCodexRecoverySchedules()
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('app.close() invokes onClose hook which clears retry map', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atm-shutdown-retry-'))
    cleanups.push(dir)
    const { app } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })

    scheduleRetry({
      agentId: 'B',
      messageId: 'm-shutdown-1',
      fromAgentId: 'A',
      body: 'hi',
      team: 'default',
      sentAt: '2020-01-01T00:00:00.000Z',
      paneId: '%2',
      paneGuardFn: async () => 'fail',
      pokeFn: async () => { /* noop */ },
      lookupAgentFn: () => ({ agent_id: 'B', tmux_pane_id: '%2', last_seen_at: '2019-12-31T00:00:00.000Z' })
    })
    expect(__peekRetryMap().size).toBeGreaterThanOrEqual(1)

    await app.close()

    expect(__peekRetryMap().size).toBe(0)
  })

  it('app.close() also clears pending codex recovery schedules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atm-shutdown-recovery-'))
    cleanups.push(dir)
    const { app } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })

    // The schedule uses its own db handle plus fully stubbed probes, so no
    // tmux/ps command can ever run out of this test.
    const aux = openDb(join(dir, 'aux.db'))
    applySchema(aux)
    const repo = new CodexPanePreRegRepo(aux)
    repo.upsert({
      pane_id: '%77',
      xats_agent_id: 'U-shutdown',
      identity_key: 'K-shutdown',
      expires_at: '2999-01-01T00:00:00.000Z',
    })
    const holder: IdentityKeyMatch = {
      agent_id: 'holder-shutdown',
      device: 'local',
      team: 'default',
      name: 'codex-shutdown',
      role: 'default',
      runtime_ui_pid: null,
      last_seen_at: '2026-01-01T00:00:00.000Z',
    }
    evaluateCodexRecoveryOnPreRegister(
      {
        pane_id: '%77',
        xats_agent_id: 'U-shutdown',
        identity_key: 'K-shutdown',
        expires_at: '2999-01-01T00:00:00.000Z',
      },
      {
        repo,
        findByIdentityKey: () => [holder],
        findByDeclaredIdentity: () => undefined,
        localDevice: 'local',
        isProcessAlive: () => false,
        listPanes: async () => [],
        probeIntervalMs: 60_000,
      }
    )
    expect(__peekCodexRecoverySchedules()).toEqual(['%77'])

    await app.close()

    expect(__peekCodexRecoverySchedules()).toEqual([])
    aux.close()
  })

  it('app.close() also clears pending kimi retry timers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atm-shutdown-kimi-retry-'))
    cleanups.push(dir)
    const { app } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })

    scheduleKimiRetry({
      agentId: 'K',
      messageId: 'm-shutdown-kimi-1',
      attemptFn: async () => ({ ok: false, reason: 'kimi_session_busy' })
    })
    expect(__peekKimiRetryMap().size).toBeGreaterThanOrEqual(1)

    await app.close()

    expect(__peekKimiRetryMap().size).toBe(0)
  })
})
