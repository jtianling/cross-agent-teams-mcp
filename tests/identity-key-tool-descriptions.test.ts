import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-identity-key-desc-'))

async function listTools() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const server = new McpServer({ name: 'test-server', version: '0.0.0' })
  const sessionId = 'session-identity-key-desc'
  registerBusinessTools(server, db, () => sessionId, undefined, () => {}, () => sessionId)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'claude-code', version: '0.0.0' })
  await client.connect(ct)
  const resp = await client.listTools()
  return { dir, db, server, client, transport: ct, tools: resp.tools }
}

describe('identity key tool descriptions', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('register_agent exposes identity_key and instructs reading XATS_IDENTITY_KEY', async () => {
    const { dir, db, server, client, transport, tools } = await listTools()
    cleanups.push(dir)
    const tool = tools.find(t => t.name === 'register_agent')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({
      properties: expect.objectContaining({ identity_key: expect.anything() }),
    })
    const desc = tool!.description!
    expect(desc).toContain('XATS_IDENTITY_KEY')
    expect(desc).toContain('`identity_key`')
    // Must cover the FIRST registration, not just recovery.
    expect(desc).toMatch(/EVERY `register_agent` call, including the very first one/)
    expect(desc).toContain('identity_key_conflict')

    await transport.close(); await client.close(); db.close(); await server.close()
  })

  it('keeps the key out of the numbered agent_type DETECTION sequence', async () => {
    const { dir, db, server, client, transport, tools } = await listTools()
    cleanups.push(dir)
    const desc = tools.find(t => t.name === 'register_agent')!.description!

    const start = desc.indexOf('DETECTION (')
    const end = desc.indexOf('Calling this tool again')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const detectionBlock = desc.slice(start, end)
    expect(detectionBlock).not.toContain('XATS_IDENTITY_KEY')

    // The four runtime probes are untouched.
    expect(detectionBlock).toContain('1. `printenv KIMI_XATS_BASE_URL`')
    expect(detectionBlock).toContain('2. `printenv OPENCODE_XATS_BASE_URL`')
    expect(detectionBlock).toContain('3. `printenv CODEX_THREAD_ID`')
    expect(detectionBlock).toContain('4. `printenv CLAUDECODE`')

    await transport.close(); await client.close(); db.close(); await server.close()
  })

  it('documents declared identity variables for every agent type', async () => {
    const { dir, db, server, client, transport, tools } = await listTools()
    cleanups.push(dir)
    const desc = tools.find(t => t.name === 'register_agent')!.description!

    expect(desc).toContain('XATS_TEAM')
    expect(desc).toContain('XATS_AGENT_NAME')
    expect(desc).toContain('applies to every `agent_type`')
    expect(desc).toContain('launcher\'s declaration')
    expect(desc).toContain('seat rebuild')
    expect(desc).toContain('Pass each non-empty value unchanged')
    expect(desc).toContain('register with that complete identity')

    await transport.close(); await client.close(); db.close(); await server.close()
  })

  it('keeps declared identity out of detection and explains codex', async () => {
    const { dir, db, server, client, transport, tools } = await listTools()
    cleanups.push(dir)
    const desc = tools.find(t => t.name === 'register_agent')!.description!
    const start = desc.indexOf('DETECTION (')
    const end = desc.indexOf('Calling this tool again')
    const detectionBlock = desc.slice(start, end)

    expect(detectionBlock).not.toContain('XATS_TEAM')
    expect(detectionBlock).not.toContain('XATS_AGENT_NAME')
    expect(detectionBlock).toContain('1. `printenv KIMI_XATS_BASE_URL`')
    expect(detectionBlock).toContain('2. `printenv OPENCODE_XATS_BASE_URL`')
    expect(detectionBlock).toContain('3. `printenv CODEX_THREAD_ID`')
    expect(detectionBlock).toContain('4. `printenv CLAUDECODE`')

    const codex = desc.slice(desc.indexOf('Codex is the exception'))
    expect(codex).toContain('shared app-server')
    expect(codex).toContain('pre_register_codex_pane')

    await transport.close(); await client.close(); db.close(); await server.close()
  })

  it('documents declared recovery on pre_register_codex_pane', async () => {
    const { dir, db, server, client, transport, tools } = await listTools()
    cleanups.push(dir)
    const tool = tools.find(t => t.name === 'pre_register_codex_pane')!
    expect(tool.inputSchema).toMatchObject({
      properties: expect.objectContaining({
        team: expect.anything(),
        agent_name: expect.anything(),
      }),
    })
    expect(tool.description).toContain('complete declaration')
    expect(tool.description).toContain('key misses')
    expect(tool.description).toContain('liveness-unknown')

    await transport.close(); await client.close(); db.close(); await server.close()
  })

  it('warns codex that the readable key belongs to the app-server, not the caller', async () => {
    // A codex tool call runs inside the shared app-server, so the variable it
    // can read names another pane.  Left unsaid, a caller passing it in good
    // faith claims a key that is not its own.
    const { dir, db, server, client, transport, tools } = await listTools()
    cleanups.push(dir)
    const desc = tools.find(t => t.name === 'register_agent')!.description!

    const caveat = desc.slice(desc.indexOf('CAVEAT for `agent_type="codex"`'))
    expect(caveat).not.toBe('')
    expect(caveat).toContain('app-server')
    expect(caveat).toMatch(/do NOT pass `identity_key`/)
    expect(caveat).toContain('pre_register_codex_pane')

    await transport.close(); await client.close(); db.close(); await server.close()
  })

  it('reconnect presents the identity-key branch before the remembers branches', async () => {
    const { dir, db, server, client, transport, tools } = await listTools()
    cleanups.push(dir)
    const tool = tools.find(t => t.name === 'reconnect')!
    expect(tool.inputSchema).toMatchObject({
      properties: expect.objectContaining({ identity_key: expect.anything() }),
    })
    const desc = tool.description!
    const keyAt = desc.indexOf('XATS_IDENTITY_KEY')
    expect(keyAt).toBeGreaterThan(-1)
    expect(keyAt).toBeLessThan(desc.indexOf('Otherwise pass exactly one runtime lookup key'))
    expect(keyAt).toBeLessThan(desc.indexOf('If you still remember (team, name)'))
    expect(desc).toContain('reconnect({identity_key: <that value>, ui_pid: $PPID})')
    expect(desc).toContain('thread_id: $CODEX_THREAD_ID})')
    // need_register → ask the user → carry the same key onto register_agent.
    expect(desc).toMatch(
      /`need_register` result, ask the user for \(team, name\)[^.]*same `identity_key`/
    )
    // Pre-existing routing must survive.
    expect(desc).toContain('重连 xats')
    expect(desc).toContain('base_url=$OPENCODE_XATS_BASE_URL')

    await transport.close(); await client.close(); db.close(); await server.close()
  })
})
