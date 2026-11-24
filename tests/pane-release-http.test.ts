import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport }
  from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { PaneProbeError, type PaneProbes } from '../src/pane-lookup/probes.js'

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: async () => ({ error: 'not_found', candidates: [] }),
}))

const serverStart = 1793000000
const tmux = { socket_path: '/private/release-test/socket', server_pid: 200,
  server_started_at: serverStart, pane_id: '%7' }
const process = { pid: 201, pgid: 201, tpgid: 201, tty: 'pts/7',
  started_at: (serverStart + 2) * 1000, stat: 'S+', command: '/usr/bin/claude' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
  vi.restoreAllMocks()
})

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'xats-pane-release-api-'))
  const dbPath = join(dir, 'data.db')
  const probes: PaneProbes = {
    socket: vi.fn(async () => ({ path: tmux.socket_path,
      device: 1, inode: 2, uid: 501 })),
    panes: vi.fn(async () => [{ ...tmux, pane_pid: 201, tty: 'pts/7' }]),
    process: vi.fn(async () => ({ ...process })),
    ttyProcesses: vi.fn(async () => [{ ...process }]),
  }
  const started = await startServer({ dbPath, port: 0, localDevice: 'local',
    token: 'isolated-release-token', paneReleaseProbes: probes, mcpLog: vi.fn() })
  cleanups.push(async () => {
    await started.app.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const db = openDb(dbPath)
  cleanups.push(async () => { db.close() })
  const headers = { authorization: 'Bearer isolated-release-token' }
  const post = (payload: object, extra = {}) => started.app.inject({
    method: 'POST', url: '/api/runtime/panes/release', headers, payload, ...extra,
  })
  const bind = (id: string) => db.prepare(`UPDATE agents SET tmux_pane_id='%7',
    runtime_ui_pid=201,runtime_tty='pts/7',runtime_verification_mode='verified_pid_tty_pane',
    runtime_bound_at=? WHERE agent_id=?`)
    .run(new Date((serverStart + 20) * 1000).toISOString(), id)
  const connect = async () => {
    const client = new Client({ name: 'pane-release-test', version: '1' })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${started.host}:${started.port}/mcp`),
      { requestInit: { headers } })
    await client.connect(transport)
    cleanups.push(async () => { await client.close() })
    return { client, transport }
  }
  return { ...started, db, probes, post, bind, connect, headers }
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args })
  return JSON.parse((response.content as Array<{ text: string }>)[0].text)
}

describe('launcher pane release HTTP boundary', () => {
  it('preserves a historical identity, its messages and MCP session after proving an empty current pane', async () => {
    const h = await setup()
    const owner = await h.connect()
    const retired = await tool(owner.client, 'register_agent', {
      agent_type: 'claude-code', name: 'retired', team: 'history',
      identity_key: 'retired-fixture-key', delivery: {
        kind: 'claude-channel', channel_session_id: 'retired-channel',
      },
    })
    h.bind(retired.agent_id)
    h.db.prepare(`UPDATE agents SET runtime_ui_pid=901,runtime_tty='pts/old',
      runtime_bound_at=? WHERE agent_id=?`)
      .run(new Date((serverStart - 1000) * 1000).toISOString(), retired.agent_id)
    vi.mocked(h.probes.process).mockImplementation(async pid =>
      pid === process.pid ? { ...process } : undefined)
    const sender = await h.connect()
    await tool(sender.client, 'register_agent', { agent_type: 'custom',
      agent_type_name: 'fixture', name: 'sender', team: 'history' })
    const sent = await tool(sender.client, 'send_message', {
      to_agent_name: 'retired', body: 'history remains intact',
      auto_poke: false, need_reply: false, await_ack_s: 0,
    })
    const result = await h.post({ protocol_version: 1,
      targets: [{ tmux, identity_key: 'current-fixture-key' }] })
    expect(result.statusCode).toBe(200)
    expect(result.json()).toEqual({ ok: true, protocol_version: 1,
      results: [{ index: 0, state: 'already_unregistered', agent: null }] })
    const row = new AgentsRepo(h.db).findById(retired.agent_id)
    expect(row?.identity_key).toBe('retired-fixture-key')
    expect(row?.tmux_pane_id).toBe('%7')
    const inbox = await tool(owner.client, 'get_inbox', {})
    expect(inbox.messages.some((message: { id: string }) => message.id === sent.message_id))
      .toBe(true)
  })

  it('still rejects unknown logical Codex owners and logs the exact safe 409 reason', async () => {
    const h = await setup()
    const row = new AgentsRepo(h.db).register({ name: 'unlocated', device: 'local',
      agent_type: 'codex', delivery: { kind: 'codex-appserver',
        ws_url: 'ws://127.0.0.1:8799', thread_id: 'fixture-thread' } })
    const carrier = { ...process,
      command: 'codex --remote ws://127.0.0.1:8799 -c xats.agent_id="fixture-launch"' }
    vi.mocked(h.probes.process).mockImplementation(async pid =>
      pid === carrier.pid ? carrier : undefined)
    vi.mocked(h.probes.ttyProcesses!).mockResolvedValue([carrier])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await h.post({ protocol_version: 1,
      targets: [{ tmux, identity_key: 'current-fixture-key' }] })
    expect(result.statusCode).toBe(409)
    expect(result.json()).toMatchObject({ error: 'pane_unverifiable',
      detail: 'no_verified_current_carrier', target_index: 0 })
    expect(new AgentsRepo(h.db).findById(row.agent_id)).toBeDefined()
    expect(JSON.stringify(logged.mock.calls)).toContain('no_verified_current_carrier')
    expect(JSON.stringify(logged.mock.calls)).not.toContain('current-fixture-key')
  })

  it('closes only the released member MCP sessions, preserves messages, and frees its name', async () => {
    const h = await setup()
    const source = await h.connect()
    const original = await tool(source.client, 'register_agent', {
      agent_type: 'claude-code', name: 'worker', team: 'project', identity_key: 'opaque-key',
      delivery: { kind: 'claude-channel', channel_session_id: 'fixture-channel' },
    })
    h.bind(original.agent_id)
    const session = source.transport.sessionId!
    const sender = await h.connect()
    const sibling = await tool(sender.client, 'register_agent', { agent_type: 'custom',
      agent_type_name: 'fixture', name: 'sender', team: 'project' })
    const message = await tool(sender.client, 'send_message', {
      to_agent_name: 'worker', to_team: 'project', body: 'test message remains',
      auto_poke: false, need_reply: false, await_ack_s: 0,
    })
    const request = { protocol_version: 1, targets: [{ tmux, identity_key: 'opaque-key' }] }
    const response = await h.post(request)
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true, protocol_version: 1, results: [{
      index: 0, state: 'released', agent: { agent_id: original.agent_id,
        name: 'worker', team: 'project', agent_type: 'claude-code' },
    }] })
    expect(h.db.prepare('SELECT id FROM messages WHERE id=?').get(message.message_id))
      .toEqual({ id: message.message_id })
    expect(new AgentsRepo(h.db).findById(sibling.agent_id)).toBeDefined()
    const oldRequest = await h.app.inject({ method: 'POST', url: '/mcp', headers: {
      ...h.headers, 'mcp-session-id': session,
      accept: 'application/json, text/event-stream',
    }, payload: { jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'get_inbox', arguments: {} } },
    })
    expect(oldRequest.statusCode).toBe(404)
    expect((await h.post(request)).json()).toMatchObject({ results: [{
      state: 'already_unregistered', agent: null }] })
    const replacement = await h.connect()
    const registered = await tool(replacement.client, 'register_agent', {
      agent_type: 'claude-code', name: 'worker', team: 'project', identity_key: 'new-key',
      delivery: { kind: 'claude-channel', channel_session_id: 'replacement-channel' },
    })
    expect(registered.agent_id).toBeDefined()
    expect(registered.agent_id).not.toBe(original.agent_id)
  })

  it('enforces actual loopback, bearer and complete strict request validation', async () => {
    const h = await setup()
    const input = { protocol_version: 1, targets: [{ tmux }] }
    expect((await h.post(input, { headers: {} })).statusCode).toBe(401)
    const remote = await h.post(input, { remoteAddress: '192.0.2.1',
      headers: { ...h.headers, 'x-forwarded-for': '127.0.0.1' } })
    expect(remote.statusCode).toBe(403)
    expect(remote.json()).toEqual({ ok: false, protocol_version: 1,
      error: 'remote_forbidden', detail: 'Pane release requires loopback',
      target_index: null, retryable: false })
    for (const payload of [{ ...input, extra: true }, { ...input, targets: [] },
      { ...input, targets: [{ tmux, identity_key: ' ' }] },
      { ...input, targets: [{ tmux: { ...tmux, socket_path: 'relative' } }] }]) {
      const result = await h.post(payload)
      expect(result.statusCode).toBe(400)
      expect(result.json()).toMatchObject({ ok: false, error: 'invalid_request',
        target_index: null, retryable: false })
    }
    const malformed = await h.app.inject({ method: 'POST',
      url: '/api/runtime/panes/release', headers: { ...h.headers,
        'content-type': 'application/json' }, payload: '{broken' })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toMatchObject({ error: 'invalid_request' })
    expect(h.probes.socket).not.toHaveBeenCalled()
  })

  it('reports probe failures with retry classification and keeps registry unchanged', async () => {
    const h = await setup()
    const row = new AgentsRepo(h.db).register({ name: 'worker',
      agent_type: 'claude-code', identity_key: 'secret-fixture-key', device: 'local' })
    h.bind(row.agent_id)
    vi.mocked(h.probes.socket).mockRejectedValue(new PaneProbeError('socket_inspection_failed',
      new Error('socket denied for secret-fixture-key')))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await h.post({ protocol_version: 1,
      targets: [{ tmux, identity_key: 'secret-fixture-key' }] })
    expect(result.statusCode).toBe(503)
    expect(result.json()).toEqual({ ok: false, protocol_version: 1,
      error: 'probe_failed', detail: 'socket_inspection_failed',
      target_index: 0, retryable: true })
    expect(JSON.stringify(errorLog.mock.calls)).toContain('socket denied')
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret-fixture-key')
    expect(new AgentsRepo(h.db).findById(row.agent_id)).toBeDefined()
  })
})
