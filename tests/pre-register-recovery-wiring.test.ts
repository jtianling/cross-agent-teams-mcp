import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { findDeclaredIdentityHolder } from '../src/mcp/tools.js'
import { insertAgent } from './helpers/insert-agent.js'
import {
  __peekCodexRecoverySchedules,
  clearAllCodexRecoverySchedules,
} from '../src/mcp/codex-recovery-poke.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-recovery-wiring-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

// Only the no-schedule branches (key miss, live holder) run through the real
// daemon here: they never start probe polling, so no tmux/ps command can be
// touched. The scheduling and send paths are unit-tested with injected stubs
// in codex-recovery-poke.test.ts.
describe('pre_register_codex_pane recovery wiring', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    clearAllCodexRecoverySchedules()
  })

  afterEach(() => {
    clearAllCodexRecoverySchedules()
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('declared lookup is device-scoped and includes a proxy holder', () => {
    const db = openDb(':memory:')
    applySchema(db, { localDevice: 'local' })
    insertAgent(db, {
      agent_id: 'remote-holder',
      device: 'remote',
      team: 'monkeys',
      name: 'mvr-coder',
      runtime_ui_pid: 1111,
    })
    insertAgent(db, {
      agent_id: 'local-proxy',
      device: 'local',
      team: 'monkeys',
      name: 'mvr-coder',
      role: '__channel_proxy__',
      runtime_ui_pid: 2222,
      last_seen_at: '2026-01-01T00:00:00.000Z',
    })

    expect(findDeclaredIdentityHolder(
      new AgentsRepo(db),
      'local',
      'monkeys',
      'mvr-coder'
    )).toMatchObject({
      agent_id: 'local-proxy',
      device: 'local',
      role: '__channel_proxy__',
      runtime_ui_pid: 2222,
      last_seen_at: '2026-01-01T00:00:00.000Z',
    })
    db.close()
  })

  it('stores the key and schedules nothing on a key miss', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })
    const t = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`))
    const c = new Client({ name: 'launcher', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'pre_register_codex_pane',
      arguments: { pane_id: '%1972', xats_agent_id: 'U1', identity_key: 'K9' },
    })
    expect(await parseTool(resp)).toMatchObject({ ok: true })
    expect(__peekCodexRecoverySchedules()).toEqual([])

    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      `SELECT identity_key FROM codex_pane_pre_registrations WHERE pane_id='%1972'`
    ).get() as { identity_key: string | null }
    expect(row.identity_key).toBe('K9')
    db.close()

    await t.close()
    await c.close()
    await app.close()
  })

  it('schedules nothing when the key holder process is alive', async () => {
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })

    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    seed.prepare(
      `INSERT INTO agents
         (agent_id, device, team, role, name, registered_at, last_seen_at,
          runtime_ui_pid, identity_key)
       VALUES (?, 'local', 'aoe', 'default', 'aoe-codex', ?, ?, ?, 'K1')`
    ).run(
      'holder-1',
      '2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',
      process.pid
    )
    seed.close()

    const t = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`))
    const c = new Client({ name: 'launcher', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'pre_register_codex_pane',
      arguments: { pane_id: '%1972', xats_agent_id: 'U1', identity_key: 'K1' },
    })
    expect(await parseTool(resp)).toMatchObject({ ok: true })
    expect(__peekCodexRecoverySchedules()).toEqual([])

    await t.close()
    await c.close()
    await app.close()
  })
})
