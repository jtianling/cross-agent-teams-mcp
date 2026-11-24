import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport }
  from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { RegisterOpencodeSelfService } from '../src/mcp/register-opencode-self.js'

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: async () => ({ error: 'not_found', candidates: [] }),
}))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
  vi.restoreAllMocks()
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xats-handoff-http-'))
  const dbPath = join(dir, 'data.db')
  const log = vi.fn()
  const started = await startServer({ dbPath, port: 0, localDevice: 'local',
    token: 'handoff-test-bearer', mcpLog: log,
    handoffRuntimeProbe: async () => undefined })
  const headers = { authorization: 'Bearer handoff-test-bearer' }
  cleanup.push(async () => {
    await started.app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const connect = async () => {
    const client = new Client({ name: 'handoff-test', version: '1' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${started.host}:${started.port}/mcp`),
      { requestInit: { headers } })
    await client.connect(transport)
    cleanup.push(async () => { await client.close(); await transport.close() })
    return client
  }
  const post = (name: string, payload: object, extra = {}) => started.app.inject({
    method: 'POST', url: `/api/runtime/handoff/${name}`, headers, payload, ...extra,
  })
  return { ...started, dbPath, headers, connect, post, log }
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args })
  return JSON.parse((response.content as Array<{ text: string }>)[0].text)
}

describe('runtime handoff HTTP and MCP lifecycle', () => {
  it('keeps source usable until commit, blocks its old connection, and binds target', async () => {
    const h = await setup()
    const source = await h.connect()
    const key = 'http-handoff-key'
    const thread = randomUUID()
    const registered = await tool(source, 'register_agent', {
      agent_type: 'codex', name: 'worker', team: 'project', thread_id: thread,
      identity_key: key, delivery: { kind: 'codex-appserver',
        thread_id: thread, ws_url: 'ws://127.0.0.1:8799/' },
    })
    expect(registered.agent_id).toBeDefined()
    const prepared = (await h.post('prepare', { protocol_version: 1,
      identity_key: key, request_id: randomUUID(), name: 'worker', team: 'project',
      source_agent_type: 'codex', target_agent_type: 'opencode' })).json()
    expect(prepared.state).toBe('prepared')
    expect(await tool(source, 'get_inbox', {})).toHaveProperty('messages')
    const control = { protocol_version: 1, identity_key: key, fence: prepared.fence }
    const committed = (await h.post('commit', { ...control, runtime: {
      agent_type: 'opencode', base_url: 'http://127.0.0.1:12345',
      session_id: 'ses_new_target',
    } })).json()
    expect(committed).toMatchObject({ state: 'committed', current: {
      agent_id: registered.agent_id, runtime_generation: 1 } })
    expect(Object.keys(committed).sort()).toEqual([
      'current', 'fence', 'ok', 'protocol_version', 'recovery_prompt',
      'source', 'state', 'target_agent_type',
    ])
    await expect(tool(source, 'get_inbox', {})).rejects.toMatchObject({ code: 409 })
    await expect(tool(source, 'register_agent', { agent_type: 'codex',
      name: 'worker', team: 'project', thread_id: thread }))
      .rejects.toMatchObject({ code: 409 })
    vi.spyOn(RegisterOpencodeSelfService.prototype, 'validateExactSession')
      .mockResolvedValue({ ok: true })
    const target = await h.connect()
    const reconnected = await tool(target, 'reconnect', {
      identity_key: key, agent_type: 'opencode',
      base_url: 'http://127.0.0.1:12345', session_id: 'ses_new_target',
      runtime_generation: committed.current.runtime_generation,
    })
    expect(reconnected).toMatchObject({ ok: true, agent_id: registered.agent_id })
    expect(await tool(target, 'get_inbox', {})).toHaveProperty('messages')
    const db = openDb(h.dbPath)
    try {
      expect(db.prepare('SELECT count(*) AS n FROM agents WHERE name=?')
        .get('worker')).toEqual({ n: 1 })
    } finally { db.close() }
  })

  it('enforces bearer, actual loopback and strict schemas with stable business errors', async () => {
    const h = await setup()
    const payload = { protocol_version: 1, identity_key: 'missing', fence: {
      handoff_id: randomUUID(), register_generation: 1 } }
    expect((await h.post('status', payload, { headers: {} })).statusCode).toBe(401)
    expect((await h.post('status', payload, { remoteAddress: '192.0.2.1' }))
      .statusCode).toBe(403)
    const missing = await h.post('status', payload)
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ ok: false, protocol_version: 1,
      error: 'not_found', detail: 'Handoff not found', retryable: false })
    const invalid = await h.post('status', { ...payload, unexpected: 1 })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ error: 'invalid_request', retryable: false })
    expect((await h.app.inject({ method: 'POST',
      url: '/api/runtime/handoff/status', headers: {
        ...h.headers, 'content-type': 'application/json' }, payload: '{broken',
    })).json()).toMatchObject({ error: 'invalid_request', retryable: false })
  })
})
