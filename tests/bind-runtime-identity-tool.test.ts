import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-bind-runtime-tool-'))

describe('bind_runtime_identity tool', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    bindRuntimeIdentityMock.mockReset()
  })

  it('is exposed and persists verified runtime binding for the caller', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys026',
      ui_pid: 81979,
    })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0.0.0' })
    await c.connect(t)

    await c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', model: 'opus', role: 'worker', name: 'alice' },
    })

    const tools = await c.listTools()
    const tool = tools.tools.find(x => x.name === 'bind_runtime_identity')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        agent: expect.anything(),
        ui_pid: expect.anything(),
        ui_tty: expect.anything(),
        tmux_pane_id: expect.anything(),
      }),
      required: expect.arrayContaining(['agent']),
    })

    const resp = await c.callTool({
      name: 'bind_runtime_identity',
      arguments: { agent: 'codex', ui_pid: 81979 },
    })
    const result = JSON.parse((resp.content as Array<{ text: string }>)[0].text) as {
      ok: boolean
      tmux_pane_id: string
      tty: string
    }

    expect(result).toMatchObject({
      ok: true,
      tmux_pane_id: '%1902',
      tty: 'ttys026',
    })
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith({
      callerAgentId: expect.any(String),
      agent: 'codex',
      ui_pid: 81979,
      ui_tty: undefined,
      tmux_pane_id: undefined,
      process_pattern: undefined,
      captureCurrentGeneration: true,
    })

    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      'SELECT tmux_pane_id, runtime_ui_pid, runtime_tty, runtime_verification_mode FROM agents WHERE team=? AND name=?'
    ).get('default', 'alice') as {
      tmux_pane_id: string | null
      runtime_ui_pid: number | null
      runtime_tty: string | null
      runtime_verification_mode: string | null
    }
    expect(row).toEqual({
      tmux_pane_id: '%1902',
      runtime_ui_pid: 81979,
      runtime_tty: 'ttys026',
      runtime_verification_mode: 'verified_pid_tty_pane',
    })
    db.close()

    await t.terminateSession()
    await c.close()
    await app.close()
  })
})
