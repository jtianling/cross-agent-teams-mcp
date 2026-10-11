import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-toolsdesc-'))

describe('broadcast tool description — default-on semantics', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  interface ToolInfo { name: string; description?: string }
  async function listTools(): Promise<ToolInfo[]> {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0.0.0' })
    await c.connect(t)
    const resp = await c.listTools()
    await t.close(); await app.close()
    return resp.tools as unknown as ToolInfo[]
  }

  it('broadcast description states auto-poke default-on and documents auto_poke:false opt-out', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'broadcast')
    expect(tool).toBeDefined()
    const d = tool!.description!
    // Default-on language: mentions auto-poke and "default"
    expect(d).toMatch(/auto-poke/i)
    expect(d).toMatch(/default/i)
    // Opt-out mechanism: auto_poke:false explicitly called out
    expect(d).toMatch(/auto_poke:\s*false/i)
    // Quiet-guard behavior is described
    expect(d).toMatch(/quiet-guard|quiet guard/i)
    // Retry-backoff still mentioned
    expect(d).toMatch(/retry/i)
  })

  it('fan-out descriptions state the 7-day activity window', async () => {
    const tools = await listTools()
    for (const name of ['broadcast', 'broadcast_to_role']) {
      const d = tools.find(t => t.name === name)!.description!
      expect(d).toMatch(/active within the last 7 days/)
      expect(d).toMatch(/skipped_inactive/)
      expect(d).toMatch(/send_message reaches a specific agent regardless/)
    }
  })
})
