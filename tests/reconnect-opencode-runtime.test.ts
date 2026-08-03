import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-runtime-reconnect-'))

function parseTool(response: unknown): Record<string, unknown> {
  const content = (response as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0]!.text) as Record<string, unknown>
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen_failed')
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

describe('identity-key OpenCode runtime reconnect', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('binds the owning MCP connection and then reads inbox', async () => {
    const requests: string[] = []
    const opencode = createServer((request, response) => {
      const url = request.url ?? ''
      requests.push(url)
      if (request.method === 'GET' && url === '/global/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"healthy":true}')
        return
      }
      if (request.method === 'GET' && url === '/session/ses_ready') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end('{"id":"ses_ready"}')
        return
      }
      response.writeHead(404)
      response.end()
    })
    const opencodePort = await listen(opencode)
    const dir = tmp()
    dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const daemon = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })
    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    const repo = new AgentsRepo(seed)
    const registered = repo.register({
      agent_type: 'opencode',
      name: 'open',
      team: 'dev',
      role: 'worker',
      identity_key: 'runtime-secret',
      opencode_runtime_generation: 4,
      delivery: {
        kind: 'opencode-server',
        base_url: `http://127.0.0.1:${opencodePort}`,
        session_id: 'ses_ready',
        auth_token_ref: 'OPENCODE_PASSWORD',
        runtime_generation: 4,
      },
    })
    seed.prepare(
      `UPDATE agents SET last_processed_event_id = 17 WHERE agent_id = ?`
    ).run(registered.agent_id)
    seed.close()

    const originalPassword = process.env.OPENCODE_PASSWORD
    process.env.OPENCODE_PASSWORD = 'password'
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${daemon.host}:${daemon.port}/mcp`)
    )
    const client = new Client({ name: 'opencode', version: '0.0.0' })
    await client.connect(transport)
    try {
      expect(parseTool(await client.callTool({
        name: 'reconnect',
        arguments: {
          identity_key: 'runtime-secret',
          agent_type: 'opencode',
          base_url: `http://127.0.0.1:${opencodePort}`,
          session_id: 'ses_ready',
          runtime_generation: 4,
        },
      }))).toMatchObject({
        ok: true,
        agent_id: registered.agent_id,
        connection_bound: true,
        runtime_generation: 4,
      })
      expect(parseTool(await client.callTool({
        name: 'get_inbox',
        arguments: { since_event_id: 17 },
      }))).toMatchObject({ messages: [] })
      expect(requests).toEqual([
        '/global/health',
        '/session/ses_ready',
      ])

      const verify = openDb(dbPath)
      applySchema(verify, { localDevice: 'local' })
      const row = verify.prepare(
        `SELECT agent_id, last_processed_event_id, register_generation,
                opencode_runtime_generation, delivery_payload
         FROM agents WHERE identity_key = 'runtime-secret'`
      ).get() as {
        agent_id: string
        last_processed_event_id: number
        register_generation: number
        opencode_runtime_generation: number
        delivery_payload: string
      }
      expect(row).toMatchObject({
        agent_id: registered.agent_id,
        register_generation: registered.register_generation,
        opencode_runtime_generation: 4,
      })
      expect(JSON.parse(row.delivery_payload)).toMatchObject({
        auth_token_ref: 'OPENCODE_PASSWORD',
      })
      verify.close()
    } finally {
      if (originalPassword === undefined) delete process.env.OPENCODE_PASSWORD
      else process.env.OPENCODE_PASSWORD = originalPassword
      await transport.close()
      await client.close()
      await daemon.app.close()
      await closeServer(opencode)
    }
  })

  it('does zero HTTP for unknown key, type conflict, stale, and '
    + 'mismatched delivery', async () => {
    const requests: string[] = []
    const opencode = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(500)
      response.end()
    })
    const opencodePort = await listen(opencode)
    const dir = tmp()
    dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const daemon = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })
    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    const repo = new AgentsRepo(seed)
    repo.register({
      agent_type: 'opencode',
      name: 'open',
      team: 'dev',
      identity_key: 'open-key',
      opencode_runtime_generation: 3,
      delivery: {
        kind: 'opencode-server',
        base_url: `http://127.0.0.1:${opencodePort}`,
        session_id: 'ses_ready',
        runtime_generation: 3,
      },
    })
    repo.register({
      agent_type: 'codex',
      name: 'codex',
      team: 'dev',
      identity_key: 'codex-key',
      delivery: {
        kind: 'codex-appserver',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
      },
    })
    seed.close()

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${daemon.host}:${daemon.port}/mcp`)
    )
    const client = new Client({ name: 'opencode', version: '0.0.0' })
    await client.connect(transport)
    const reconnect = async (overrides: Record<string, unknown>) => parseTool(
      await client.callTool({
        name: 'reconnect',
        arguments: {
          identity_key: 'open-key',
          agent_type: 'opencode',
          base_url: `http://127.0.0.1:${opencodePort}`,
          session_id: 'ses_ready',
          runtime_generation: 3,
          ...overrides,
        },
      })
    )
    try {
      expect(await reconnect({ identity_key: 'missing' })).toMatchObject({
        need_register: true,
      })
      expect(await reconnect({ identity_key: 'codex-key' })).toMatchObject({
        error: 'agent_type_conflict',
      })
      expect(await reconnect({ runtime_generation: 2 })).toMatchObject({
        error: 'stale_runtime_generation',
      })
      expect(await reconnect({ session_id: 'ses_other' })).toMatchObject({
        error: 'runtime_delivery_mismatch',
      })
      expect(requests).toEqual([])
      expect(parseTool(await client.callTool({
        name: 'get_inbox',
        arguments: {},
      }))).toEqual({ error: 'unknown_agent' })
    } finally {
      await transport.close()
      await client.close()
      await daemon.app.close()
      await closeServer(opencode)
    }
  })

  it('rejects key-only reconnect for a stored OpenCode identity', async () => {
    const dir = tmp()
    dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const daemon = await startServer({
      dbPath,
      port: 0,
      localDevice: 'local',
    })
    const seed = openDb(dbPath)
    applySchema(seed, { localDevice: 'local' })
    const registered = new AgentsRepo(seed).register({
      agent_type: 'opencode',
      name: 'recovering',
      team: 'dev',
      identity_key: 'recovering-key',
      opencode_runtime_generation: 1,
      delivery: {
        kind: 'opencode-server',
        base_url: 'http://127.0.0.1:1',
        session_id: 'ses_old',
        runtime_generation: 1,
      },
    })
    seed.prepare(
      `UPDATE agents SET opencode_runtime_generation = 2 WHERE agent_id = ?`
    ).run(registered.agent_id)
    seed.close()

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${daemon.host}:${daemon.port}/mcp`)
    )
    const client = new Client({ name: 'opencode', version: '0.0.0' })
    await client.connect(transport)
    try {
      expect(parseTool(await client.callTool({
        name: 'reconnect',
        arguments: { identity_key: 'recovering-key' },
      }))).toMatchObject({
        error: 'opencode_runtime_coordinates_required',
      })
      expect(parseTool(await client.callTool({
        name: 'get_inbox',
        arguments: {},
      }))).toEqual({ error: 'unknown_agent' })
    } finally {
      await transport.close()
      await client.close()
      await daemon.app.close()
    }
  })

  it('accepts only the complete key-based OpenCode schema arm', async () => {
    const dir = tmp()
    dirs.push(dir)
    const daemon = await startServer({
      dbPath: join(dir, 'data.db'),
      port: 0,
      localDevice: 'local',
    })
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${daemon.host}:${daemon.port}/mcp`)
    )
    const client = new Client({ name: 'opencode', version: '0.0.0' })
    await client.connect(transport)
    const invalid = [
      {
        identity_key: 'key',
        agent_type: 'opencode',
        base_url: 'http://127.0.0.1:3000',
        runtime_generation: 1,
      },
      {
        identity_key: 'key',
        agent_type: 'opencode',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_ready',
      },
      {
        identity_key: 'key',
        agent_type: 'opencode',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_ready',
        runtime_generation: 1,
        ui_pid: 42,
      },
      {
        identity_key: 'key',
        agent_type: 'opencode',
        base_url: 'http://user@127.0.0.1:3000',
        session_id: 'ses_ready',
        runtime_generation: 1,
      },
      {
        identity_key: 'key',
        agent_type: 'opencode',
        base_url: 'http://127.0.0.1:3000?',
        session_id: 'ses_ready',
        runtime_generation: 1,
      },
      {
        identity_key: 'key',
        agent_type: 'opencode',
        base_url: 'http://127.0.0.1:3000',
        session_id: 'ses_ready',
        runtime_generation: Number.MAX_SAFE_INTEGER + 1,
      },
    ]
    try {
      for (const args of invalid) {
        const response = await client.callTool({
          name: 'reconnect',
          arguments: args,
        }) as { isError?: boolean }
        expect(response.isError, JSON.stringify(args)).toBe(true)
      }
      const accepted = await client.callTool({
        name: 'reconnect',
        arguments: {
          identity_key: 'missing',
          agent_type: 'opencode',
          base_url: 'http://127.0.0.1:3000',
          session_id: 'ses_ready',
          runtime_generation: 1,
        },
      }) as { isError?: boolean }
      expect(accepted.isError).toBeFalsy()
      expect(parseTool(accepted)).toMatchObject({ need_register: true })
    } finally {
      await transport.close()
      await client.close()
      await daemon.app.close()
    }
  })
})
