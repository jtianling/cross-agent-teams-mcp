import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const registerCodexSelfMock = vi.fn()
const detectTmuxPaneMock = vi.fn()
const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/mcp/register-codex-self.js', () => ({
  RegisterCodexSelfService: class {
    register(input: unknown) {
      return registerCodexSelfMock(input)
    }
  },
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-register-client-route-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('register_agent client routing', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    registerCodexSelfMock.mockReset()
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
  })

  it('routes client=codex through the internal codex self-registration path', async () => {
    registerCodexSelfMock.mockResolvedValue({
      agent_id: 'agent-codex-1',
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
      prior_snapshot: null,
      register_generation: 1,
    })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'codex',
        model: 'gpt-5',
        role: 'worker',
        name: 'alice',
        thread_id: '11111111-1111-4111-8111-111111111111',
      },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      agent_id: 'agent-codex-1',
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
    })
    expect(registerCodexSelfMock).toHaveBeenCalledWith({
      connection_id: expect.any(String),
      name: 'alice',
      model: 'gpt-5',
      role: 'worker',
      team: undefined,
      project_dir: undefined,
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: '',
      auth_token_ref: undefined,
    })
    expect(detectTmuxPaneMock).toHaveBeenCalledWith({ agent: 'codex' })

    await t.close()
    await c.close()
    await app.close()
  })

  it('INVARIANT: a register result without register_generation fails the runtime auto-bind closed', async () => {
    registerCodexSelfMock.mockResolvedValue({
      agent_id: 'agent-codex-1',
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
      // register_generation deliberately missing: the conditional final
      // writes must not degrade into unconditional ones.
    })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const logLines: string[] = []
    const { app, port, host } = await startServer({
      dbPath: join(dir, 'data.db'),
      port: 0,
      mcpLog: line => { logLines.push(line) },
    })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'codex',
        model: 'gpt-5',
        role: 'worker',
        name: 'alice',
        thread_id: '11111111-1111-4111-8111-111111111111',
      },
    })
    const obj = await parseTool(resp)

    // Register itself still succeeds; only the runtime auto-bind is skipped.
    expect(obj.agent_id).toBe('agent-codex-1')
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()
    expect(bindRuntimeIdentityMock).not.toHaveBeenCalled()
    expect(logLines).toContainEqual(
      expect.stringContaining('register invariant error:')
    )

    await t.close()
    await c.close()
    await app.close()
  })

  it('INVARIANT (isolated W1): a missing prior_snapshot FIELD with a VALID generation is treated as CAS drift', async () => {
    registerCodexSelfMock.mockResolvedValue({
      agent_id: 'agent-codex-1',
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
      register_generation: 1,
      // prior_snapshot field deliberately missing: without the W1 check
      // this would fake a CAS match against the null pre-upsert capture.
    })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const logLines: string[] = []
    const { app, port, host } = await startServer({
      dbPath: join(dir, 'data.db'),
      port: 0,
      mcpLog: line => { logLines.push(line) },
    })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'codex',
        model: 'gpt-5',
        role: 'worker',
        name: 'alice',
        thread_id: '11111111-1111-4111-8111-111111111111',
      },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBe('agent-codex-1')
    // Treated as drift: no evidence path, no scan, no detection, no bind.
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()
    expect(bindRuntimeIdentityMock).not.toHaveBeenCalled()
    expect(logLines).toContainEqual(
      expect.stringContaining('no prior_snapshot field')
    )
    expect(logLines).toContainEqual(
      expect.stringContaining('outcome=cas_drift')
    )
    // The generation IS valid, so the drift residue clear still ran.
    expect(logLines).toContainEqual(
      expect.stringContaining('cas drift runtime clear (debug):')
    )

    await t.close()
    await c.close()
    await app.close()
  })

  it('INVARIANT (isolated W2): CAS drift with a non-positive-safe-integer generation skips the clear and says so', async () => {
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const logLines: string[] = []
    const { app, port, host } = await startServer({
      dbPath: join(dir, 'data.db'),
      port: 0,
      mcpLog: line => { logLines.push(line) },
    })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const priorOfAnotherSession = {
      agent_id: 'agent-codex-1',
      codex_thread_id: 'raced-thread',
      runtime_ui_pid: 202,
      runtime_tty: 'ttys021',
      tmux_pane_id: '%20',
      runtime_bound_at: '2026-01-01T00:00:00Z',
    }
    for (const badGeneration of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
      registerCodexSelfMock.mockResolvedValueOnce({
        agent_id: 'agent-codex-1',
        team: 'default',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
        // Non-null prior vs a null pre-upsert capture: genuine CAS drift.
        prior_snapshot: priorOfAnotherSession,
        register_generation: badGeneration,
      })
      const before = logLines.length

      const resp = await c.callTool({
        name: 'register_agent',
        arguments: {
          agent_type: 'codex',
          model: 'gpt-5',
          role: 'worker',
          name: 'alice',
          thread_id: '11111111-1111-4111-8111-111111111111',
        },
      })
      const obj = await parseTool(resp)
      const fresh = logLines.slice(before)

      expect(obj.agent_id).toBe('agent-codex-1')
      // The dedicated invariant hint replaces the misleading no-pane hint.
      expect(String(obj.hint)).toContain(
        'invariant error (invalid register_generation)'
      )
      expect(fresh).toContainEqual(
        expect.stringContaining('no valid register_generation')
      )
      expect(fresh).toContainEqual(expect.stringContaining(
        'reason=invalid_register_generation; residual seat may remain'
      ))
      expect(fresh).not.toContainEqual(
        expect.stringContaining('cas drift runtime clear (debug):')
      )
      expect(detectTmuxPaneMock).not.toHaveBeenCalled()
      expect(bindRuntimeIdentityMock).not.toHaveBeenCalled()
    }

    await t.close()
    await c.close()
    await app.close()
  })
})
