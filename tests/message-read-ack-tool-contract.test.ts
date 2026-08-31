import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-ack-tool-'))

interface ToolCallResult {
  content?: Array<{ type: string; text: string }>
  isError?: boolean
}

describe('read-ack tool contract', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  async function client(): Promise<{ c: Client; close: () => Promise<void> }> {
    const dir = tmp(); dirs.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(t)
    return { c, close: async () => { await t.close(); await app.close() } }
  }

  function textOf(resp: unknown): string {
    const r = resp as ToolCallResult
    return (r.content ?? []).map(x => x.text).join('\n')
  }

  async function descriptionOf(c: Client, name: string): Promise<string> {
    const list = await c.listTools()
    const tool = list.tools.find(t => t.name === name)
    if (!tool) throw new Error(`tool ${name} not registered`)
    return tool.description ?? ''
  }

  for (const name of ['send_message', 'send_message_by_id']) {
    it(`${name} description states not_yet is not a failure`, async () => {
      const { c, close } = await client()
      const desc = await descriptionOf(c, name)
      expect(desc).toContain('not_yet')
      expect(desc).toMatch(/NOT a failure/)
      expect(desc).toMatch(/DO NOT change your behaviour/)
      await close()
    })

    it(`${name} description announces the separate unread alert`, async () => {
      const { c, close } = await client()
      const desc = await descriptionOf(c, name)
      expect(desc).toMatch(/15 minutes/)
      expect(desc).toMatch(/ATTEMPTS to poke YOU/)
      await close()
    })

    it(`${name} ties the alert to need_reply`, async () => {
      const { c, close } = await client()
      const desc = await descriptionOf(c, name)
      // An unqualified promise would be false for exactly the callers it
      // reassures: a need_reply:false send never arms the watchdog.
      expect(desc).toMatch(/need_reply:false gets no alert/)
      await close()
    })

    it(`${name} presents the alert as an attempt, never a guarantee`, async () => {
      const { c, close } = await client()
      const desc = await descriptionOf(c, name)
      // The same description tells the caller not to poll, so overstating the
      // alert would walk a trusting agent straight back into the silent stall.
      // Assert against the alert sentence itself: a bare /never retried/ would
      // be satisfied by the unrelated kimi and pane_reassigned skip-reason
      // sentences and would still pass with this whole paragraph deleted.
      expect(desc).toMatch(/A transient failure[^.]*is retried on the following sweeps/)
      expect(desc).toMatch(/a hard failure is not retried and the attempt is then abandoned/)
      expect(desc).toMatch(/rather than a guarantee/)
      expect(desc).not.toMatch(/always reaches you|will reach you|guaranteed/)
      await close()
    })

    it(`${name} description forbids resending after a failed wait`, async () => {
      const { c, close } = await client()
      const desc = await descriptionOf(c, name)
      expect(desc).toMatch(/written BEFORE the wait/)
      expect(desc).toMatch(/NEVER means the message was not sent/)
      await close()
    })
  }

  it('documents channel_sink_failed as a skip reason on both send tools', async () => {
    const { c, close } = await client()
    for (const name of ['send_message', 'send_message_by_id']) {
      const desc = await descriptionOf(c, name)
      expect(desc, `${name} must list the new skip reason`).toContain('channel_sink_failed')
      // Anchored on the explanatory sentence, not the bare token: the token
      // also appears in the skip-reason enumeration, so a match there alone
      // would not prove the meaning is documented.
      expect(desc).toMatch(/channel_sink_failed means[^.]*subscriber was attached but its write threw/)
      expect(desc).toMatch(/channel_sink_failed means[^.]*mailbox row is still written/)
    }
    await close()
  })

  it('get_delivery_status description separates wake_status from read', async () => {
    const { c, close } = await client()
    const desc = await descriptionOf(c, 'get_delivery_status')
    expect(desc).toContain('wake_status')
    expect(desc).toContain('read')
    expect(desc).toMatch(/NOT interchangeable/)
    await close()
  })

  it('actually waits when await_ack_s is omitted', async () => {
    // The published `default: 10` only matters if the SDK applies it to the
    // omitted arg: SendMessageService reads undefined as "no wait", so if the
    // default ever stops being materialised, the wait silently becomes zero
    // while the tool description keeps telling agents it is ten seconds.
    const dir = tmp(); dirs.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)

    const open = async (name: string) => {
      const t = new StreamableHTTPClientTransport(url)
      const c = new Client({ name, version: '0' })
      await c.connect(t)
      await c.callTool({
        name: 'register_agent',
        arguments: { agent_type: 'custom', agent_type_name: 'test', model: 'm', name, team: 'default' },
      })
      return { c, t }
    }
    const sender = await open('sender')
    const recipient = await open('recipient')

    // Reads well inside any real window but long after a zero-length one.
    const reader = setTimeout(() => {
      void recipient.c.callTool({ name: 'get_inbox', arguments: {} })
    }, 300)

    const resp = await sender.c.callTool({
      name: 'send_message',
      arguments: { to_agent_name: 'recipient', body: 'hi' },
    }) as ToolCallResult
    clearTimeout(reader)

    const out = JSON.parse(textOf(resp)) as { ack?: { status: string; waited_ms: number } }
    expect(out.ack?.status).toBe('read')
    expect(out.ack?.waited_ms).toBeGreaterThanOrEqual(250)

    await sender.t.close()
    await recipient.t.close()
    await app.close()
  })

  it('rejects await_ack_s above the 30 second ceiling before writing anything', async () => {
    const dir = tmp(); dirs.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(t)
    await c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', agent_type_name: 'test', model: 'm', name: 'sender', team: 'default' },
    })
    const t2 = new StreamableHTTPClientTransport(url)
    const c2 = new Client({ name: 'test2', version: '0' })
    await c2.connect(t2)
    await c2.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', agent_type_name: 'test', model: 'm', name: 'recipient', team: 'default' },
    })

    // A REAL recipient: sending to a ghost would create no row regardless, so
    // the "nothing was written" half of the scenario would prove nothing.
    const resp = await c.callTool({
      name: 'send_message',
      arguments: { to_agent_name: 'recipient', body: 'hi', await_ack_s: 31 },
    }) as ToolCallResult
    expect(textOf(resp)).toMatch(/await_ack_s|30|validation|less than or equal/i)

    await t.close(); await t2.close(); await app.close()

    const db = openDb(dbPath)
    const count = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }
    db.close()
    expect(count.n).toBe(0)
  })

  it('rejects a negative await_ack_s', async () => {
    const { c, close } = await client()
    const resp = await c.callTool({
      name: 'send_message',
      arguments: { to_agent_name: 'ghost', body: 'hi', await_ack_s: -1 },
    }) as ToolCallResult
    expect(textOf(resp)).toMatch(/await_ack_s|validation|greater than or equal/i)
    await close()
  })

  it('publishes await_ack_s with the 10 second default and the 30 second ceiling', async () => {
    const { c, close } = await client()
    const list = await c.listTools()
    for (const name of ['send_message', 'send_message_by_id']) {
      const tool = list.tools.find(t => t.name === name)!
      const props = (tool.inputSchema as {
        properties?: Record<string, { default?: number; maximum?: number; minimum?: number }>
      }).properties ?? {}
      const field = props.await_ack_s
      expect(field, `${name} must publish await_ack_s`).toBeDefined()
      // The schema-level default is the ONLY thing that turns an omitted
      // await_ack_s into a wait: SendMessageService reads undefined as zero.
      expect(field.default).toBe(10)
      expect(field.maximum).toBe(30)
      expect(field.minimum).toBe(0)
    }
    await close()
  })
})
