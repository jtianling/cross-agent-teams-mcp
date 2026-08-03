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

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-opencode-schema-'))

async function setupInMemory() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  const holder: { current: string | undefined } = { current: undefined }
  const sessionId = 'session-opencode-schema'
  registerBusinessTools(
    server,
    db,
    () => holder.current ?? sessionId,
    undefined,
    (agentId) => { holder.current = agentId },
    () => sessionId,
    undefined,
  )
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  await client.connect(ct)
  return { dir, db, server, client, transport: ct }
}

describe('register_agent({agent_type:"opencode"}) schema rejection', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  async function callRegister(args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
    const { dir, db, server, client, transport } = await setupInMemory()
    cleanups.push(dir)
    const resp = await client.callTool({
      name: 'register_agent',
      arguments: args,
    }) as { isError?: boolean; content: Array<{ text: string }> }
    await transport.close()
    await client.close()
    db.close()
    await server.close()
    return { isError: resp.isError, text: resp.content[0].text }
  }

  it('rejects agent_type=opencode with missing base_url', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'opencode',
      name: 'oc-1',
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/base_url/i)
    expect(text).toMatch(/OPENCODE_XATS_BASE_URL/i)
  })

  it('rejects agent_type=opencode with malformed base_url (not a URL)', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'opencode',
      name: 'oc-1',
      base_url: 'not-a-url',
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/base_url/i)
  })

  it('rejects agent_type=opencode with ws:// base_url (protocol mismatch)', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'opencode',
      name: 'oc-1',
      base_url: 'ws://127.0.0.1:18888',
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/base_url/i)
  })

  it('rejects agent_type=opencode with invalid session_id (not starting ses)', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'opencode',
      name: 'oc-1',
      base_url: 'http://127.0.0.1:18888',
      session_id: 'abc',
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/session_id/i)
  })

  it('rejects base_url supplied without agent_type=opencode', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'custom',
      agent_type_name: 'cursor',
      name: 'oc-1',
      base_url: 'http://127.0.0.1:18888',
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/agent_type=opencode/i)
  })

  it('rejects session_id supplied without agent_type=opencode', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'custom',
      agent_type_name: 'cursor',
      name: 'oc-1',
      session_id: 'ses_abc',
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/agent_type=opencode/i)
  })

  it('rejects runtime_generation without exact session_id', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'opencode',
      name: 'oc-1',
      base_url: 'http://127.0.0.1:18888',
      identity_key: 'key',
      runtime_generation: 1,
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/session_id/i)
  })

  it('rejects runtime_generation without identity_key', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'opencode',
      name: 'oc-1',
      base_url: 'http://127.0.0.1:18888',
      session_id: 'ses_runtime',
      runtime_generation: 1,
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/identity_key/i)
  })

  it('rejects runtime_generation on non-OpenCode registration', async () => {
    const { isError, text } = await callRegister({
      agent_type: 'custom',
      agent_type_name: 'cursor',
      name: 'custom-1',
      runtime_generation: 1,
    })
    expect(isError).toBe(true)
    expect(text).toMatch(/runtime_generation/i)
  })
})
