import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  base, cleanup, dir, fixture, key, listen, names, result, stdio, token, tools,
} from './antigravity-stdio-harness.js'
import { daemonUrl } from '../plugins/antigravity/src/launch.js'
import { startServer } from '../src/daemon/server.js'
import { requestAgyLauncher } from '../src/mcp/antigravity-pty.js'

vi.mock('../src/mcp/antigravity-pty.js', () => ({
  requestAgyLauncher: vi.fn(async (op: string) => ({
    status: op === 'probe' ? 'ready' : 'delivered',
  })),
}))
vi.mock('../src/daemon/tmux-control/binding.js', () => ({
  bindingProbes: () => undefined,
}))

describe('xats-agy-mcp stdio', { timeout: 15000 }, () => {
  it('receives cross-team mail while idle and can reply to the sender', async () => {
    const { app, port } = await startServer({
      dbPath: ':memory:', port: 0, localDevice: 'local', mcpLog: vi.fn(),
    })
    cleanup.push(async () => { await app.close() })
    const url = `http://127.0.0.1:${port}/mcp`
    const env = { ...base, CROSS_AGENT_TEAMS_MCP_URL: url, CROSS_AGENT_TEAMS_MCP_TOKEN: '' }
    const { client: reader } = await stdio(env)
    await vi.waitFor(() => expect(requestAgyLauncher).toHaveBeenCalledWith('probe', {
      launch_id: base.XATS_AGY_LAUNCH_ID, name: 'reader', team: 'lab',
    }))
    const { client: sender } = await stdio({
      ...env, XATS_AGY_LAUNCH_ID: randomUUID(), XATS_AGY_NAME: 'sender',
      XATS_AGY_TEAM: 'other', XATS_AGY_IDENTITY_KEY: '',
    })
    const sent = await sender.callTool({ name: 'send_message', arguments: {
      to_agent_name: 'reader', to_team: 'lab', body: 'idle mail', await_ack_s: 0,
    } })
    expect(sent.isError).toBeFalsy()
    expect(requestAgyLauncher).toHaveBeenCalledWith('wake', {
      launch_id: base.XATS_AGY_LAUNCH_ID, name: 'reader', team: 'lab',
    })
    expect((await reader.listTools()).tools.map(t => t.name).sort())
      .toEqual([...names].sort())
    const mail = await reader.callTool({ name: 'get_inbox' })
    expect(mail.content).toEqual([{
      type: 'text', text: expect.stringContaining('idle mail'),
    }])
    const [envelope] = mail.content as Array<{ text: string }>
    const [message] = JSON.parse(envelope.text).messages
    await reader.callTool({ name: 'send_message', arguments: {
      to_agent_name: message.from_name, to_team: message.from_team,
      body: 'cross-team reply', await_ack_s: 0,
    } })
    expect((await sender.callTool({ name: 'get_inbox' })).content).toEqual([{
      type: 'text', text: expect.stringContaining('cross-team reply'),
    }])
  })

  it('registers an idle native child and forwards only daemon communication tools',
    async () => {
      const { url, state, calls } = await fixture()
      const { client } = await stdio({ ...base, CROSS_AGENT_TEAMS_MCP_URL: url })
      await vi.waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0]).toEqual({ name: 'register_agent', arguments: {
        agent_type: 'antigravity', agy_launch_id: base.XATS_AGY_LAUNCH_ID,
        name: 'reader', team: 'lab', identity_key: key,
      } })
      expect(await client.listTools()).toEqual({ tools })
      for (const name of ['register_agent', 'reconnect', 'unregister_self']) {
        await expect(client.callTool({ name })).rejects.toThrow('unavailable')
      }
      await Promise.all(names.map(async name => {
        expect(await client.callTool({ name, arguments: { body: name } })).toEqual(result)
      }))
      expect(calls.slice(1)).toHaveLength(names.length)
      expect(calls.slice(1)).toEqual(expect.arrayContaining(names.map(name =>
        ({ name, arguments: { body: name } }))))
      expect(state.sessions).toBe(1)
      expect(new Set(state.auth)).toEqual(new Set(['Bearer ' + token]))
    })

  it.each(['plain', 'nested'] as const)('stays silent and offline for %s agy',
    async mode => {
      const { url, state } = await fixture()
      const env = mode === 'plain' ? {} : base
      const { client, stderr } = await stdio({ ...env, CROSS_AGENT_TEAMS_MCP_URL: url },
        mode)
      expect(await client.listTools()).toEqual({ tools: [] })
      await expect(client.callTool({ name: 'send_message' })).rejects.toThrow()
      expect(state.auth).toEqual([])
      expect(stderr()).toBe('')
    })

  it('omits identity_key when only the inherited generic key exists', async () => {
    const { url, calls } = await fixture()
    const { XATS_AGY_IDENTITY_KEY: _key, ...env } = base
    const { client } = await stdio({ ...env, CROSS_AGENT_TEAMS_MCP_URL: url })
    await client.listTools()
    expect(calls[0].arguments).not.toHaveProperty('identity_key')
  })

  it('shares registration, never replays a lost write, and pins identity on reconnect',
    async () => {
      const { url, state, calls } = await fixture()
      await writeFile(join(dir, 'daemon.pid'), JSON.stringify({
        pid: process.pid, port: Number(new URL(url).port),
      }))
      const { client } = await stdio({ ...base, CROSS_AGENT_TEAMS_MCP_HOME: dir })
      await Promise.all([client.listTools(), client.listTools()])
      state.dropSend = true
      await expect(client.callTool({ name: 'send_message' }))
        .rejects.toThrow('outcome unknown')
      expect(calls.map(c => c.name)).toEqual(['register_agent', 'send_message'])
      expect(await client.callTool({ name: 'list_agents' })).toEqual(result)
      expect(calls.map(c => c.name)).toEqual([
        'register_agent', 'send_message', 'register_agent', 'list_agents',
      ])
      await expect(client.callTool({ name: 'send_message' })).rejects.toThrow()
      state.reply.agent_id = randomUUID()
      await expect(client.listTools()).rejects.toThrow('different identity')
    })

  it.each([
    [{ agent_id: 'invalid', team: 'lab' }, 'uuid'],
    [{ agent_id: randomUUID(), team: 'other' }, 'different identity'],
    [{ error: 'denied ' + token + ' ' + key }, 'denied [redacted] [redacted]'],
  ] as const)('gates discovery and direct calls after registration rejection %#',
    async (reply, message) => {
      const { url, state, calls } = await fixture()
      state.reply = reply
      const { client, stderr } = await stdio({ ...base, CROSS_AGENT_TEAMS_MCP_URL: url })
      await expect(client.listTools()).rejects.toThrow(message)
      await expect(client.callTool({ name: 'broadcast' })).rejects.toThrow(message)
      expect(calls.every(c => c.name === 'register_agent')).toBe(true)
      expect(stderr()).not.toContain(token)
      expect(stderr()).not.toContain(key)
    })

  it('rejects redirects before sending credentials or MCP calls to another endpoint',
    async () => {
      const target = await fixture()
      const url = await listen((_req, res) => res.writeHead(307, {
        location: target.url,
      }).end())
      const { client } = await stdio({ ...base, CROSS_AGENT_TEAMS_MCP_URL: url })
      await expect(client.listTools()).rejects.toThrow(/fetch|redirect/)
      expect(target.state.auth).toEqual([])
    })

  it('retries named startup registration quickly after transient agent_id_collision',
    async () => {
      const { url, state, calls } = await fixture()
      let attempts = 0
      const originalReply = state.reply
      Object.defineProperty(state, 'reply', {
        get() {
          attempts++
          return attempts === 1 ? { error: 'agent_id_collision' } : originalReply
        },
      })
      const { client } = await stdio({ ...base, CROSS_AGENT_TEAMS_MCP_URL: url })
      await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
      expect(calls[0].name).toBe('register_agent')
      expect(calls[1].name).toBe('register_agent')
      expect(await client.callTool({ name: 'list_agents' })).toEqual(result)
    })

  it.each(['http://127.evil.example/mcp', 'https://x@localhost/mcp',
    'http://localhost/mcp?', 'http://localhost/mcp#', 'file://localhost/mcp',
    'http://localhost/path/../mcp', 'http://localhost/mcp/', 'http://localhost/MCP',
    'http://127.1/mcp', 'http://localhost:0/mcp'])(
    'rejects invalid explicit URL without discovery: %s', async url => {
      await expect(daemonUrl({ CROSS_AGENT_TEAMS_MCP_URL: url,
        CROSS_AGENT_TEAMS_MCP_HOME: dir })).rejects.toThrow('loopback')
    })
})
