import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { getLaunch } from '../plugins/antigravity/src/launch.js'
import { startServer } from '../src/daemon/server.js'
import { claims } from './antigravity-stdio-claims.js'
import {
  agy, base, cleanup, cli, fixture, result, stdio, tools,
} from './antigravity-stdio-harness.js'

vi.mock('../src/mcp/antigravity-pty.js', () => ({
  requestAgyLauncher: vi.fn(async () => ({ status: 'ready' })),
}))
vi.mock('../src/daemon/tmux-control/binding.js', () => ({
  bindingProbes: () => undefined,
}))

const identity = { name: 'reader', team: 'lab' }
const registration = (name = identity.name) => ({
  name: 'register_agent', arguments: { ...identity, name },
})
const inbox = { name: 'get_inbox' }
async function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  const socket = await claims()
  const daemon = await fixture()
  const env = { ...socket.env, CROSS_AGENT_TEAMS_MCP_URL: daemon.url, ...extraEnv }
  const bridge = await stdio(env)
  return { socket, daemon, env, ...bridge }
}

describe('deferred stdio registration', { timeout: 15000 }, () => {
  it('reads persisted mail after restarting only the bridge under the same PID',
    async () => {
      const socket = await claims()
      const { app, port } = await startServer({
        dbPath: ':memory:', port: 0, localDevice: 'local', mcpLog: vi.fn(),
      })
      cleanup.push(async () => { await app.close() })
      const runner = resolve('tests/antigravity-stdio-restart.ts')
      const { stdout } = await promisify(execFile)(agy,
        ['--import', 'tsx', runner, process.execPath, cli], { env: {
          ...socket.env, CROSS_AGENT_TEAMS_MCP_URL: `http://127.0.0.1:${port}/mcp`,
        }, timeout: 12000 })
      const [item] = JSON.parse(stdout)
      expect(JSON.parse(item.text).messages).toMatchObject([{ body: 'before bridge restart' }])
      expect(socket.ops()).toEqual(['prepare', 'commit', 'status'])
    })

  it('reports capabilities before reading a launch or starting stdio', async () => {
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', cli, '--capabilities-json'], { env: {
        XATS_AGY_LAUNCH_ID: 'invalid', XATS_AGY_PID: 'invalid',
        XATS_AGY_NAME: 'unused', XATS_AGY_TEAM: 'unused',
      } })
    expect(stdout.trim()).toBe('{"defer_registration":1}')
    expect(stderr).toBe('')
  })

  it('requires a slot key of 16-256 UTF-8 bytes', () => {
    const env = { ...base, XATS_AGY_DEFER_REGISTRATION: '1', XATS_AGY_PID: '2' }
    for (const bytes of [16, 256]) {
      expect(getLaunch({ ...env, XATS_AGY_IDENTITY_KEY: 'é'.repeat(bytes / 2) }))
        .toMatchObject({ mode: 'deferred' })
    }
    for (const value of [undefined, '', 'short', 'é'.repeat(129)]) {
      expect(getLaunch({ ...env, XATS_AGY_IDENTITY_KEY: value })).toBeUndefined()
    }
  })

  it.each(['missing key', 'nested agy'])('keeps %s quiet and offline', async mode => {
    const socket = await claims()
    const daemon = await fixture()
    const { XATS_AGY_IDENTITY_KEY, ...env } = { ...base, ...socket.env }
    const { client, stderr } = await stdio({
      ...env, CROSS_AGENT_TEAMS_MCP_URL: daemon.url,
      ...(mode === 'nested agy' && { XATS_AGY_IDENTITY_KEY }),
    }, mode === 'nested agy' ? 'nested' : 'active')
    expect(await client.listTools()).toEqual({ tools: [] })
    await expect(client.callTool(registration())).rejects.toThrow('unavailable')
    expect(stderr()).toBe('')
    expect(socket.frames).toEqual([])
    expect(daemon.state.sessions).toBe(0)
  })

  it('publishes cacheable schemas, gates calls, and serializes explicit registration',
    async () => {
      const { daemon, socket, client } = await setup()
      expect(daemon.state.sessions).toBe(0)
      const { tools: [register, ...business] } = await client.listTools()
      expect(register.inputSchema).toMatchObject({
        required: ['name', 'team'], additionalProperties: false,
      })
      expect(business).toEqual(tools)
      for (const extra of [{ role: 'other' }, { identity_key: 'other' }, { name: '' },
        { team: ' spaced' }, { name: 'x\0y' }, { name: 'x'.repeat(257) }]) {
        await expect(client.callTool({ name: register.name, arguments: {
          ...identity, ...extra,
        } })).rejects.toThrow()
      }
      expect(socket.frames).toEqual([])
      await expect(client.callTool(inbox)).rejects.toThrow('register_agent first')
      expect(socket.ops()).toEqual(['status'])
      expect(daemon.calls).toEqual([])
      expect(daemon.state.pings).toBe(0)
      const [a, b, other] = await Promise.allSettled([
        client.callTool(registration()), client.callTool(registration()),
        client.callTool(registration('other')),
      ])
      expect(a.status).toBe('fulfilled')
      expect(b).toEqual(a)
      expect(other.status).toBe('rejected')
      expect(socket.ops()).toEqual(['status', 'prepare', 'commit'])
      expect(socket.frames[1].attempt).toBe(socket.frames[2].attempt)
      expect(daemon.calls).toHaveLength(1)
      expect(daemon.calls[0].arguments).toEqual({ ...identity,
        agy_launch_id: socket.env.XATS_AGY_LAUNCH_ID, agent_type: 'antigravity',
        identity_key: socket.env.XATS_AGY_IDENTITY_KEY,
      })
      expect(await client.callTool(inbox)).toEqual(result)
    })

  it.each(['identity_key_conflict', 'opencode_runtime_coordinates_required'])(
    'releases its fresh prepare after explicit %s', async error => {
    const { daemon, socket, client } = await setup()
    const success = daemon.state.reply
    daemon.state.reply = { error }
    await expect(client.callTool(registration())).rejects.toThrow(error)
    expect(socket.ops()).toEqual(['prepare', 'abort'])
    expect(socket.frames[0].attempt).toBe(socket.frames[1].attempt)
    daemon.state.reply = success
    await client.callTool(registration('another'))
    expect(socket.ops()).toEqual(['prepare', 'abort', 'prepare', 'commit'])
    expect(socket.frames[2].attempt).not.toBe(socket.frames[0].attempt)
  })

  it.each(['network', 'malformed', 'storage', 'wrong team', 'mixed result'])(
    'keeps the fence on %s and a later explicit rejection', async mode => {
      const { daemon, socket, client } = await setup()
      const success = daemon.state.reply
      daemon.state.dropRegister = mode === 'network'
      daemon.state.reply = {
        malformed: {}, storage: { error: 'storage_unavailable' },
        'wrong team': { ...success, team: 'wrong' },
        'mixed result': { ...success, error: 'identity_key_conflict' },
      }[mode] ?? success
      await expect(client.callTool(registration())).rejects.toThrow()
      await expect(client.callTool(registration('other'))).rejects.toThrow('original')
      await expect(client.callTool(inbox)).rejects.toThrow('register_agent first')
      daemon.state.dropRegister = false
      daemon.state.reply = { error: 'identity_key_conflict' }
      await expect(client.callTool(registration())).rejects.toThrow('identity_key_conflict')
      expect(socket.ops()).toEqual(['prepare', 'prepare'])
      expect(socket.frames[0].attempt).toBe(socket.frames[1].attempt)
      expect(daemon.state.pings).toBe(0)
      daemon.state.reply = success
      await client.callTool(registration())
      expect(socket.ops()).toEqual(['prepare', 'prepare', 'prepare', 'commit'])
    })

  it.each(['prepare', 'commit', 'abort'])('pins name after losing %s reply', async op => {
    const { daemon, socket, client } = await setup()
    const success = daemon.state.reply
    if (op === 'abort') daemon.state.reply = { error: 'agent_id_collision' }
    socket.state.respond = req => req.op === op ? null : { status: 'prepared' }
    await expect(client.callTool(registration())).rejects.toThrow(op)
    await expect(client.callTool(registration('other'))).rejects.toThrow('original')
    await expect(client.callTool(inbox)).rejects.toThrow('register_agent first')
    expect(daemon.state.pings).toBe(0)
    socket.state.respond = undefined
    daemon.state.reply = success
    await client.callTool(registration())
    expect(await client.callTool(inbox)).toEqual(result)
    const attempts = socket.frames.map(frame => frame.attempt)
    if (op === 'abort') {
      expect(socket.ops()).toEqual(['prepare', 'abort', 'abort', 'prepare', 'commit'])
      expect(attempts[0]).toBe(attempts[2])
      expect(attempts[0]).not.toBe(attempts[3])
    } else {
      expect(new Set(attempts).size).toBe(1)
    }
  })

  it.each(['agy_unavailable', 'invalid_request', 'invalid_proof', 'identity_mismatch'])(
    'permits a new candidate after first prepare reports %s', async code => {
      const { socket, daemon, client } = await setup()
      socket.state.respond = () => ({ status: 'unavailable', detail: code })
      await expect(client.callTool(registration())).rejects.toThrow(code)
      socket.state.respond = undefined
      await client.callTool(registration('another'))
      expect(socket.ops()).toEqual(['prepare', 'prepare', 'commit'])
      expect(socket.frames[0].attempt).not.toBe(socket.frames[1].attempt)
      expect(daemon.calls).toHaveLength(1)
    })

  it('counts Unicode code points and rejects unpaired surrogates', async () => {
    const { socket, client } = await setup()
    for (const invalid of ['😀'.repeat(257), '\ud800', 'x\udc00']) {
      await expect(client.callTool(registration(invalid))).rejects.toThrow()
    }
    expect(socket.frames).toEqual([])
    await client.callTool(registration('😀'.repeat(256)))
    expect(socket.ops()).toEqual(['prepare', 'commit'])
  })

  it('recovers the committed identity after losing a wrong-name prepare reply', async () => {
    const { socket, client } = await setup()
    socket.state.bound = { status: 'bound', ...identity }
    socket.state.respond = () => null
    await expect(client.callTool(registration('wrong'))).rejects.toThrow('prepare')
    socket.state.respond = () => ({ status: 'unavailable', detail: 'identity_mismatch' })
    await expect(client.callTool(registration('wrong'))).rejects.toThrow('identity_mismatch')
    socket.state.respond = undefined
    expect(await client.callTool(inbox)).toEqual(result)
    expect(socket.ops()).toEqual(['prepare', 'prepare', 'status'])
  })

  it('keeps cached mailbox tools offline and releases after a definite refusal on retry',
    async () => {
      const { socket, daemon, client, stderr } = await setup()
      daemon.state.offline = true
      const changed = vi.fn()
      client.setNotificationHandler(ToolListChangedNotificationSchema, changed)
      const cached = (await client.listTools()).tools.map(tool => tool.name)
      expect(cached).toEqual(['register_agent', 'get_inbox', 'send_message'])
      await expect(client.callTool(inbox)).rejects.toThrow('register_agent first')
      await expect(client.callTool(registration())).rejects.toThrow(/503|offline/)
      expect(stderr()).toContain('daemon offline for test')
      expect(daemon.calls).toEqual([])
      expect(changed).not.toHaveBeenCalled()
      socket.state.respond = () => ({ status: 'unavailable', detail: 'agy_unavailable' })
      await expect(client.callTool(registration())).rejects.toThrow('agy_unavailable')
      socket.state.respond = undefined
      daemon.state.offline = false
      const success = daemon.state.reply
      daemon.state.reply = { error: 'identity_key_conflict' }
      await expect(client.callTool(registration())).rejects.toThrow('identity_key_conflict')
      expect(socket.ops()).toEqual(['status', 'prepare', 'prepare', 'prepare', 'abort'])
      expect(new Set(socket.frames.slice(1).map(req => req.attempt)).size).toBe(1)
      daemon.state.reply = success
      await client.callTool(registration('free'))
      await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1))
      for (const name of cached.slice(1)) {
        expect(await client.callTool({ name })).toEqual(result)
      }
      expect((await client.listTools()).tools.slice(1)).toEqual(tools)
    })

  it('never releases an already committed claim on daemon rejection', async () => {
    const { socket, daemon, client } = await setup()
    socket.state.bound = { status: 'bound', ...identity }
    daemon.state.reply = { error: 'identity_key_conflict' }
    await expect(client.callTool(registration())).rejects.toThrow('identity_key_conflict')
    expect(socket.ops()).toEqual(['prepare'])
  })

  it('keeps the same fence after a successful write and a lost commit response',
    async () => {
      const { socket, daemon, client } = await setup()
      socket.state.respond = req => req.op === 'commit' ? null : { status: 'prepared' }
      await expect(client.callTool(registration())).rejects.toThrow('commit failed')
      daemon.state.reply = { error: 'agent_id_collision' }
      await expect(client.callTool(registration())).rejects.toThrow('agent_id_collision')
      expect(socket.ops()).toEqual(['prepare', 'commit', 'prepare'])
      expect(new Set(socket.frames.map(frame => frame.attempt)).size).toBe(1)
      await expect(client.callTool(registration('other'))).rejects.toThrow('original')
    })

  it('serializes recovery with an explicit registration for the committed name',
    async () => {
      const { socket, daemon, client } = await setup()
      socket.state.bound = { status: 'bound', ...identity }
      const [mail] = await Promise.all([
        client.callTool(inbox), client.callTool(registration()), client.callTool(inbox),
      ])
      expect(mail).toEqual(result)
      expect(socket.ops()).toEqual(['status'])
      expect(daemon.calls.filter(call => call.name === 'register_agent')).toHaveLength(1)
      await expect(client.callTool(registration('other'))).rejects.toThrow('original')
    })

  it('rejects unavailable or malformed status without calling the daemon', async () => {
    const { socket, daemon, client } = await setup()
    for (const reply of [
      { status: 'unavailable', detail: 'invalid_proof' },
      { status: 'bound', name: identity.name }, { status: 'unbound', ...identity },
    ]) {
      socket.state.respond = () => reply
      await expect(client.callTool(inbox)).rejects.toThrow('status failed')
    }
    expect(socket.ops()).toEqual(['status', 'status', 'status'])
    expect(daemon.calls).toEqual([])
  })

  it('guides channel binding when XATS_AGY_AGENTAPI=1', async () => {
    const { client } = await setup({ XATS_AGY_AGENTAPI: '1' })
    const { tools: [register] } = await client.listTools()
    expect(register.description).toContain('xats-agy-channel-bind')
    const reply = await client.callTool(registration()) as {
      content: Array<{ type: string; text: string }>
    }
    const payload = JSON.parse(reply.content[0].text)
    expect(payload).toMatchObject({ team: identity.team })
    expect(payload.next_step).toContain('xats-agy-channel-bind')
  })
})
