import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, afterEach, beforeAll } from 'vitest'

export const cli = resolve('plugins/antigravity/src/cli.ts')
export const token = 'test-' + randomUUID()
export const key = randomUUID()
export const base = {
  XATS_AGY_LAUNCH_ID: randomUUID(), XATS_AGY_NAME: 'reader', XATS_AGY_TEAM: 'lab',
  XATS_AGY_IDENTITY_KEY: key, CROSS_AGENT_TEAMS_MCP_TOKEN: token,
  XATS_IDENTITY_KEY: 'another-agent-slot',
}
export const names = ['get_inbox', 'send_message', 'send_message_by_id', 'list_agents',
  'broadcast', 'broadcast_to_role', 'get_delivery_status', 'cancel_unread_alert']
export const tools = names.map(name => ({
  name, description: name + ' from daemon', inputSchema: {
    type: 'object', properties: { body: { type: 'string' } },
  },
}))
export const result = { content: [{ type: 'text', text: 'daemon reply' }],
  structuredContent: { delivered: true }, _meta: { fixture: 1 } }
export const cleanup: (() => Promise<void>)[] = []
export let dir: string
export let agy: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agy-stdio-'))
  agy = join(dir, 'agy')
  const native = join(dir, 'antigravity')
  await copyFile(process.execPath, native, constants.COPYFILE_FICLONE)
  await symlink(native, agy)
})
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})
afterAll(() => rm(dir, { recursive: true, force: true }))

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(err => err ? reject(err) : resolve()))
  })
  return 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/mcp'
}

export async function fixture() {
  const id = randomUUID()
  const calls: Array<{ name: string, arguments?: Record<string, unknown> }> = []
  const state = {
    reply: { agent_id: id, team: 'lab' } as Record<string, unknown>,
    dropSend: false, dropRegister: false, offline: false, pings: 0,
    auth: [] as Array<string | undefined>, sessions: 0,
  }
  const url = await listen(async (req, res) => {
    state.auth.push(req.headers.authorization)
    if (state.offline) return void res.writeHead(503).end('daemon offline for test')
    if (req.method === 'GET') return void res.writeHead(405).end()
    if (req.method === 'DELETE') return void res.writeHead(200).end()
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { id: seq, method, params } = JSON.parse(Buffer.concat(chunks).toString())
    if (seq === undefined) return void res.writeHead(202).end()
    function respond(value: unknown) {
      res.writeHead(200, { 'content-type': 'text/event-stream',
        'mcp-session-id': String(state.sessions) })
      res.end('event: message\ndata: ' +
        JSON.stringify({ jsonrpc: '2.0', id: seq, result: value }) + '\n\n')
    }
    if (method === 'initialize') {
      state.sessions++
      return respond({ protocolVersion: params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'daemon', version: '1' } })
    }
    if (method === 'tools/list') {
      if (params?.cursor) return respond({ tools: tools.slice(3) })
      return respond({ tools: [...tools.slice(0, 3), { ...tools[0], name: 'reconnect' }],
        nextCursor: 'next' })
    }
    if (method === 'ping') {
      state.pings++
      return respond({})
    }
    calls.push(params)
    if (params.name === 'register_agent') {
      if (state.dropRegister) return req.socket.destroy()
      await new Promise(resolve => setTimeout(resolve, 25))
      return respond({ content: [{ type: 'text', text: JSON.stringify(state.reply) }] })
    }
    if (params.name === 'send_message' && state.dropSend) return req.socket.destroy()
    respond(result)
  })
  return { url, state, calls }
}

export async function stdio(
  env: Record<string, string>, mode: 'active' | 'nested' | 'plain' = 'active',
) {
  const spawn = `
    const { spawnSync } = require('node:child_process')
    const [command, ...args] = process.argv.slice(1)
    process.exit(spawnSync(command, args, { stdio: 'inherit' }).status ?? 1)
  `
  const entry = ['--import', 'tsx', cli]
  const child = [process.execPath, ...entry]
  const tree = mode === 'nested' ? [agy, '-e', spawn, ...child] : child
  const transport = new StdioClientTransport({
    command: mode === 'plain' ? process.execPath : agy,
    args: mode === 'plain' ? entry : [
      '-e', 'process.env.XATS_AGY_PID = String(process.pid);' + spawn, ...tree,
    ],
    env, stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', data => { stderr += data })
  const client = new Client({ name: 'agy-test', version: '1' })
  cleanup.push(() => client.close())
  await client.connect(transport)
  return { client, stderr: () => stderr }
}
