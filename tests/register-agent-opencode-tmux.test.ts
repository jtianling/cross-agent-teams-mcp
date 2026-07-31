import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { insertAgent } from './helpers/insert-agent.js'
import { poke } from '../src/mcp/poke.js'
import { fakePaneSnapshot } from './helpers/pane-snapshot.js'
import { resolveLocalDeviceLabel } from '../src/daemon/local-device.js'

const bindRuntimeIdentityMock = vi.fn()
const detectTmuxPaneMock = vi.fn()

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/tmux-cli.js', () => ({
  isTmuxAvailable: async () => true,
  capturePaneTail: async () => 'pane-tail-placeholder',
  loadBuffer: async () => undefined,
  pasteBuffer: async () => undefined,
  sendEnter: async () => undefined,
}))

// Host verification needs a live pid whose pane_pid matches, so the fixture
// binds this test process rather than a synthetic pid.
const UI_PID = process.pid

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-opencode-tmux-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('opencode harness via custom + agent_type_name (tmux fallback path)', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    bindRuntimeIdentityMock.mockReset()
    detectTmuxPaneMock.mockReset()
  })

  it('registers as custom+agent_type_name=opencode, binds tmux pane explicitly, and poke uses tmux-poke', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%77',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys077',
      ui_pid: UI_PID,
    })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'opencode-cli', version: '0.0.0' })
    await c.connect(t)

    // Per the spec, `agent_type='opencode'` now requires `base_url` (HTTP transport).
    // The supported tmux-only path is `agent_type='custom'` + `agent_type_name='opencode'`.
    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'custom',
        agent_type_name: 'opencode',
        model: 'opencode-default',
        role: 'worker',
        name: 'alice',
        ui_pid: UI_PID,
      },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()

    // Explicit runtime binding via bind_runtime_identity (auto-bind does not
    // fire for agent_type='custom').
    const bindResp = await c.callTool({
      name: 'bind_runtime_identity',
      arguments: {
        agent: 'opencode',
        ui_pid: UI_PID,
      },
    })
    const bindObj = await parseTool(bindResp)
    expect(bindObj.ok).toBe(true)
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith({
      callerAgentId: expect.any(String),
      agent: 'opencode',
      ui_pid: UI_PID,
      ui_tty: undefined,
      tmux_pane_id: undefined,
      process_pattern: undefined,
      captureCurrentGeneration: true,
    })

    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      'SELECT agent_type, agent_type_name, tmux_pane_id, runtime_ui_pid FROM agents WHERE team=? AND name=?'
    ).get('default', 'alice') as {
      agent_type: string | null
      agent_type_name: string | null
      tmux_pane_id: string | null
      runtime_ui_pid: number | null
    }
    expect(row).toEqual({
      agent_type: 'custom',
      agent_type_name: 'opencode',
      tmux_pane_id: '%77',
      runtime_ui_pid: UI_PID,
    })

    const callerAgentId = insertAgent(db, {
      agent_id: 'caller-agent',
      agent_type: 'claude-code',
      role: 'lead',
      name: 'caller',
      tmux_pane_id: '%1',
    })

    const pokeResult = await poke(
      {
        db,
        callerAgentId,
        localDevice: resolveLocalDeviceLabel(),
        paneSnapshot: fakePaneSnapshot([{ pane_id: '%77', pane_pid: UI_PID }]),
      },
      { target_agent_id: String(obj.agent_id), prompt: 'wake up' }
    )

    expect(pokeResult).toMatchObject({
      ok: true,
      transport_used: 'tmux-poke',
      pane_id: '%77',
      pane_tail_before: expect.any(String),
      pane_tail_after: expect.any(String),
    })

    db.close()
    await t.close()
    await c.close()
    await app.close()
  })
})
