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
import {
  OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION,
} from '../src/mcp/opencode-runtime-recovery.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'xats-control-tools-'))

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

describe('OpenCode runtime control tools', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('keeps the launcher MCP connection unbound after exact commit', async () => {
    const promptBodies: unknown[] = []
    const opencode = createServer((request, response) => {
      const url = request.url ?? ''
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
      if (
        request.method === 'POST'
        && url === '/session/ses_ready/prompt_async'
      ) {
        let body = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { body += chunk })
        request.on('end', () => {
          promptBodies.push(JSON.parse(body))
          response.writeHead(204)
          response.end()
        })
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
    repo.register({
      agent_type: 'opencode',
      name: 'open',
      team: 'dev',
      identity_key: 'control-secret',
      opencode_runtime_generation: 1,
      delivery: {
        kind: 'opencode-server',
        base_url: `http://127.0.0.1:${opencodePort}`,
        session_id: 'ses_old',
        runtime_generation: 1,
      },
    })
    seed.close()

    const transport = new StreamableHTTPClientTransport(
      new URL(`http://${daemon.host}:${daemon.port}/mcp`)
    )
    const client = new Client({ name: 'launcher', version: '0.0.0' })
    await client.connect(transport)
    try {
      expect(parseTool(await client.callTool({
        name: 'reserve_opencode_runtime',
        arguments: {
          identity_key: 'control-secret',
          runtime_generation: 2,
          protocol_version: OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION,
        },
      }))).toMatchObject({ ok: true, state: 'reserved' })
      expect(parseTool(await client.callTool({
        name: 'commit_opencode_runtime',
        arguments: {
          identity_key: 'control-secret',
          runtime_generation: 2,
          base_url: `http://127.0.0.1:${opencodePort}`,
          session_id: 'ses_ready',
          protocol_version: OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION,
        },
      }))).toMatchObject({
        ok: true,
        delivery_committed: true,
        connection_bound: false,
      })
      expect(parseTool(await client.callTool({
        name: 'get_inbox',
        arguments: {},
      }))).toMatchObject({ error: 'unknown_agent' })
      expect(promptBodies).toHaveLength(1)
      expect(promptBodies[0]).toMatchObject({ noReply: false })
      expect(JSON.stringify(promptBodies[0])).not.toContain('control-secret')
    } finally {
      await transport.close()
      await client.close()
      await daemon.app.close()
      await closeServer(opencode)
    }
  })

  it('rejects incomplete control shapes at the MCP schema boundary', async () => {
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
    const client = new Client({ name: 'launcher', version: '0.0.0' })
    await client.connect(transport)
    try {
      const response = await client.callTool({
        name: 'commit_opencode_runtime',
        arguments: {
          identity_key: 'key',
          runtime_generation: 1,
          base_url: 'http://127.0.0.1:3000',
          protocol_version: OPENCODE_RUNTIME_RECOVERY_PROTOCOL_VERSION,
        },
      }) as { isError?: boolean }
      expect(response.isError).toBe(true)
    } finally {
      await transport.close()
      await client.close()
      await daemon.app.close()
    }
  })
})
