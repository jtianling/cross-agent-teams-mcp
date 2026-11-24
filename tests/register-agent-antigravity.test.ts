import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { bindRuntimeIdentity } from '../src/daemon/runtime-identity.js'
import { detectTmuxPane } from '../src/daemon/tmux-pane-detect.js'
import { requestAgyLauncher } from '../src/mcp/antigravity-pty.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

vi.mock('../src/mcp/antigravity-pty.js', () => ({ requestAgyLauncher: vi.fn() }))
vi.mock('../src/daemon/tmux-pane-detect.js', () => ({ detectTmuxPane: vi.fn() }))
vi.mock('../src/daemon/runtime-identity.js', () => ({ bindRuntimeIdentity: vi.fn() }))

describe('Antigravity registration', () => {
  let db: ReturnType<typeof openDb>
  const closers: Array<() => Promise<void>> = []
  const agy = { agent_type: 'antigravity', name: 'reader', team: 'test' }
  const legacy = { ...agy, agent_type: 'custom', agent_type_name: 'Antigravity' }
  const identity_key = 'reader-key'

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    vi.clearAllMocks()
    vi.mocked(requestAgyLauncher).mockReset()
  })

  afterEach(async () => {
    for (const close of closers.splice(0)) await close()
    db.close()
    expect(detectTmuxPane).not.toHaveBeenCalled()
    expect(bindRuntimeIdentity).not.toHaveBeenCalled()
  })

  async function connect(origin: 'local' | 'remote' = 'local') {
    const session = randomUUID()
    const info = { name: 'codex-cli', version: '1' }
    let caller: string | undefined
    const server = new McpServer({ name: 'test', version: '1' })
    registerBusinessTools(server, db, () => caller, undefined,
      id => { caller = id }, () => session, undefined, undefined, () => info,
      () => ({ origin, remote_addr: origin === 'local' ? null : '192.0.2.1' }))
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await server.connect(st)
    const client = new Client(info)
    await client.connect(ct)
    closers.push(async () => {
      await client.close()
      await server.close()
    })
    return client
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args })
    expect(res.isError).toBeFalsy()
    const [item] = res.content as Array<{ text: string }>
    return JSON.parse(item.text)
  }

  it('publishes the canonical type and explains mailbox registration', async () => {
    const { tools } = await (await connect()).listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    expect(tool?.inputSchema.properties?.agent_type).toMatchObject({
      enum: expect.arrayContaining(['antigravity']),
    })
    expect(tool?.description).toContain('Antigravity CLI (agy)')
    expect(tool?.description).toContain('get_inbox')
    expect(tool?.inputSchema.properties?.agy_launch_id).toMatchObject({ type: 'string' })
    expect(tool?.description).toContain('printenv XATS_AGY_LAUNCH_ID')
    expect(tools.find(t => t.name === 'reconnect')?.description)
      .toContain('new XATS_AGY_LAUNCH_ID')
  })

  it('keeps mail and identity across a new MCP connection', async () => {
    const first = await connect()
    const result = await call(first, 'register_agent', {
      ...agy, identity_key, model: 'claude-sonnet',
    })
    expect(result).toEqual({ agent_id: expect.any(String), team: agy.team })
    expect(db.prepare('SELECT * FROM agents').get()).toMatchObject({
      agent_type: 'antigravity', agent_type_name: null, model: 'claude-sonnet',
      delivery_kind: 'none', delivery_payload: null, tmux_pane_id: null,
      runtime_ui_pid: null, claude_ui_pid: null, identity_key,
    })
    const sender = await connect()
    await call(sender, 'register_agent', { ...legacy, name: 'sender' })
    await call(sender, 'send_message', {
      to_agent_name: agy.name, body: 'mail for agy', auto_poke: false, await_ack_s: 0,
    })
    const next = await connect()
    const recovered = await call(next, 'reconnect', { identity_key })
    expect(recovered).toMatchObject({ ...result, name: agy.name, ok: true })
    expect(db.prepare('SELECT agent_type FROM agents WHERE agent_id=?')
      .get(result.agent_id)).toEqual({ agent_type: 'antigravity' })
    expect(await call(next, 'get_inbox', {})).toMatchObject({
      messages: [{ body: 'mail for agy', to_agent_id: result.agent_id }],
    })
  })

  it('replays legacy custom and drops old coordinates on explicit upgrade', async () => {
    const client = await connect()
    const old = await call(client, 'register_agent', {
      ...legacy, identity_key, delivery: { kind: 'claude-channel', channel_session_id: 'old' },
    })
    const next = await connect()
    expect(await call(next, 'reconnect', { identity_key })).toMatchObject({
      ok: true, agent_id: old.agent_id,
    })
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?')
    expect(row.get(old.agent_id)).toMatchObject({
      agent_type: 'custom', agent_type_name: 'Antigravity', delivery_kind: 'claude-channel',
    })
    db.prepare(`UPDATE agents SET tmux_pane_id='%17', prev_tmux_pane_id='%18',
      runtime_ui_pid=123, claude_ui_pid=124 WHERE agent_id=?`).run(old.agent_id)
    for (const key of [undefined, 'other']) {
      expect(await call(next, 'register_agent', { ...agy, identity_key: key }))
        .toMatchObject({ error: 'identity_key_conflict' })
      expect(row.get(old.agent_id)).toMatchObject({
        agent_type: 'custom', identity_key, tmux_pane_id: '%17',
      })
    }
    expect(await call(next, 'register_agent', { ...agy, identity_key })).toEqual({
      agent_id: old.agent_id, team: agy.team,
    })
    expect(row.get(old.agent_id)).toMatchObject({
      agent_type: 'antigravity', agent_type_name: null, delivery_kind: 'none',
      delivery_payload: null, tmux_pane_id: null, prev_tmux_pane_id: null,
      runtime_ui_pid: null, claude_ui_pid: null, identity_key,
    })
  })

  it('requires the legacy key and exact labels for a verified upgrade', async () => {
    const client = await connect()
    const original = await call(client, 'register_agent', { ...legacy, identity_key })
    const id = randomUUID()
    const probe = vi.mocked(requestAgyLauncher).mockResolvedValue({ status: 'ready' })
    const request = { ...agy, agy_launch_id: id }
    for (const key of [undefined, 'wrong']) {
      expect(await call(client, 'register_agent', { ...request, identity_key: key }))
        .toMatchObject({ error: 'identity_key_conflict' })
    }
    expect(probe).not.toHaveBeenCalled()
    expect(await call(client, 'register_agent', { ...request, name: 'other', identity_key }))
      .toMatchObject({ error: 'identity_key_conflict' })
    expect(await call(client, 'register_agent', { ...request, identity_key })).toEqual({
      agent_id: original.agent_id, team: agy.team,
    })
    expect(db.prepare('SELECT * FROM agents').all()).toMatchObject([{
      agent_id: original.agent_id, identity_key, delivery_kind: 'antigravity-pty',
    }])
  })

  it('rejects invalid or remote launcher claims before probing', async () => {
    const client = await connect()
    const id = randomUUID()
    const pty = { kind: 'antigravity-pty', launch_id: id }
    for (const args of [
      { agy_launch_id: 'not-a-uuid' },
      { agy_launch_id: '10a39009-d75b-11ed-afa1-0242ac120002' },
      { agy_launch_id: id, team: undefined, project_dir: '/test' },
      { agy_launch_id: id, team: '   ' },
      { agy_launch_id: id, agent_type: 'custom' },
      { agy_launch_id: id, delivery: pty },
      { agent_type: 'custom', delivery: pty },
      { agent_type: 'codex', delivery: pty },
    ]) {
      const res = await client.callTool({
        name: 'register_agent', arguments: { ...agy, ...args },
      })
      expect(res.isError, JSON.stringify(args)).toBe(true)
    }
    for (const [origin, device] of [
      ['local', 'foreign'], ['remote', 'foreign'], ['remote', 'local'],
    ] as const) {
      expect(await call(await connect(origin), 'register_agent', {
        ...agy, agy_launch_id: id, device,
      })).toMatchObject({ error: 'local_launch_required' })
    }
    const svc = new RegisterAgentService(db)
    expect(svc.register({ connection_id: 'test', name: 'other',
      agent_type: 'custom', delivery: pty })).toMatchObject({ error: 'invalid_delivery' })
    expect(requestAgyLauncher).not.toHaveBeenCalled()
    expect(db.prepare('SELECT agent_id FROM agents').all()).toEqual([])
  })

  it('requires ready from the launcher before any registry write', async () => {
    const client = await connect()
    for (const status of ['busy', 'delivered', 'unavailable'] as const) {
      vi.mocked(requestAgyLauncher).mockResolvedValueOnce({ status, detail: 'reason' })
      const id = randomUUID()
      expect(await call(client, 'register_agent', { ...agy, agy_launch_id: id }))
        .toEqual({ error: 'agy_launcher_not_ready', status, detail: 'reason' })
      expect(requestAgyLauncher).toHaveBeenLastCalledWith('probe', {
        launch_id: id, name: agy.name, team: agy.team,
      })
    }
    expect(db.prepare('SELECT agent_id FROM agents').all()).toEqual([])
  })

  it('reuses the identity after exit and rejects live or indeterminate owners', async () => {
    const old = randomUUID()
    const next = randomUUID()
    const client = await connect()
    const probe = vi.mocked(requestAgyLauncher)
    const register = (id: string) => call(client, 'register_agent', {
      ...agy, identity_key, agy_launch_id: id,
    })
    probe.mockResolvedValue({ status: 'ready' })
    const bound = await register(old)
    expect(bound.agent_id).toEqual(expect.any(String))
    expect(await register(old)).toEqual(bound)
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?')
    for (const reply of [
      { status: 'ready' }, { status: 'busy' },
      { status: 'unavailable', detail: 'launcher timed out' },
    ] as const) {
      probe.mockResolvedValueOnce(reply)
      expect(await register(next)).toMatchObject({ error: 'agent_id_collision' })
      expect(probe).toHaveBeenLastCalledWith('probe', {
        launch_id: old, name: agy.name, team: agy.team,
      })
      expect(row.get(bound.agent_id)).toMatchObject({
        delivery_kind: 'antigravity-pty', delivery_payload: JSON.stringify({ launch_id: old }),
      })
    }
    probe.mockResolvedValueOnce({ status: 'unavailable', detail: 'ENOENT: lstat' })
    expect(await register(next)).toEqual(bound)
    expect(row.get(bound.agent_id)).toMatchObject({
      delivery_kind: 'antigravity-pty', delivery_payload: JSON.stringify({ launch_id: next }),
      identity_key, tmux_pane_id: null, runtime_ui_pid: null,
    })
    expect(await call(client, 'register_agent', { ...agy, identity_key }))
      .toMatchObject({ error: 'agent_id_collision' })
    probe.mockResolvedValueOnce({ status: 'unavailable', detail: 'ENOENT: lstat' })
    expect(await call(await connect(), 'reconnect', { identity_key }))
      .toMatchObject({ ok: true, agent_id: bound.agent_id })
    expect(row.get(bound.agent_id)).toMatchObject({
      identity_key, delivery_kind: 'none', delivery_payload: null,
    })
  })

  it('rejects a late probe when another same-name registration won', async () => {
    const [first, second] = await Promise.all([connect(), connect()])
    let started!: () => void
    let release!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const finish = new Promise<void>(resolve => { release = resolve })
    vi.mocked(requestAgyLauncher).mockImplementationOnce(async () => {
      started()
      await finish
      return { status: 'ready' }
    }).mockResolvedValue({ status: 'ready' })
    const pending = call(first, 'register_agent', { ...agy, agy_launch_id: randomUUID() })
    await start
    const id = randomUUID()
    const winner = await call(second, 'register_agent', { ...agy, agy_launch_id: id })
    release()
    expect(await pending).toMatchObject({ error: 'agent_id_collision' })
    expect(db.prepare('SELECT * FROM agents').all()).toMatchObject([{
      agent_id: winner.agent_id, delivery_payload: JSON.stringify({ launch_id: id }),
    }])
  })

  it('rejects explicit runtime fields at the MCP boundary before writing', async () => {
    const client = await connect()
    for (const args of [
      { agent_type: 'agy' }, { agent_type_name: 'Antigravity' },
      { ui_pid: 123 }, { tmux_pane_id: '%17' }, { ui_tty: '/dev/tty1' },
      { claude_ui_pid: 123, role: '__channel_proxy__' }, { recovery_nonce: 'nonce' },
      { delivery: { kind: 'none' } },
      { delivery: { kind: 'claude-channel', channel_session_id: 'foreign' } },
      { channel_session_id: 'foreign' }, { thread_id: 'thread' },
      { ws_url: 'ws://localhost' }, { base_url: 'http://localhost' },
      { auth_token_ref: 'ref' }, { session_id: 'ses1' }, { runtime_generation: 1 },
    ]) {
      const res = await client.callTool({
        name: 'register_agent', arguments: { ...agy, ...args },
      })
      expect(res.isError, JSON.stringify(args)).toBe(true)
    }
    expect(db.prepare('SELECT agent_id FROM agents').all()).toEqual([])
  })

  it('rejects internal registration coordinates before writing', () => {
    const svc = new RegisterAgentService(db)
    for (const fields of [
      { runtime_ui_pid: 123 }, { tmux_pane_id: '%42' }, { claude_ui_pid: 123 },
      { delivery: { kind: 'none' } }, { opencode_runtime_generation: 1 },
    ]) {
      expect(svc.register({
        ...agy, agent_type: 'antigravity', connection_id: 'test', ...fields,
      })).toEqual({
        error: 'invalid_delivery', reason: 'antigravity_transport_unsupported',
      })
    }
    expect(db.prepare('SELECT agent_id FROM agents').all()).toEqual([])
  })
})
