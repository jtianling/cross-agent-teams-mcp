import { expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { runUnreadWatchdogScan } from '../src/mcp/unread-watchdog.js'
import { insertAgent } from './helpers/insert-agent.js'

it('consumes MCP mail and lets only the sender dismiss outstanding alerts', async () => {
  const db = openDb(':memory:')
  applySchema(db)
  for (const agent_id of ['A', 'B', 'C']) insertAgent(db, { agent_id })
  const server = new McpServer({ name: 'test', version: '1' })
  const client = new Client({ name: 'test', version: '1' })
  let caller = 'A'
  registerBusinessTools(server, db, () => caller)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  await client.connect(ct)
  async function call(name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args })
    return JSON.parse((res.content as Array<{ text: string }>)[0].text)
  }
  const send = async (to: string) => (await call('send_message_by_id', {
    to_agent_id: to, body: 'x', auto_poke: false, await_ack_s: 0,
  })).message_id as string
  const dismiss = (id: string, batch = false) => call('cancel_unread_alert', {
    message_id: id, same_recipient_pending: batch,
  })
  try {
    const tools = (await client.listTools()).tools
    const inbox = tools.find(tool => tool.name === 'get_inbox')
    expect(Object.keys(inbox!.inputSchema.properties!)).toEqual(['limit'])
    const read = await send('B')
    const first = await send('B')
    const second = await send('B')
    const otherRecipient = await send('C')
    caller = 'B'
    expect((await call('get_inbox', { limit: 1 })).messages[0].id).toBe(read)
    expect(await dismiss(first, true)).toEqual({ error: 'unknown_message' })
    caller = 'C'
    const otherSender = await send('B')
    caller = 'A'
    expect((await call('get_delivery_status', { message_id: read }))
      .statuses[0].read).toBe(true)
    expect(await dismiss(first)).toEqual({ cancelled: 1 })
    expect(await dismiss(first)).toEqual({ cancelled: 0 })
    await dismiss(first, true)
    expect((await call('get_delivery_status', { message_id: second }))
      .statuses[0].read).toBe(false)
    const later = await send('B')
    const alerts: string[] = []
    await runUnreadWatchdogScan({
      db, now: () => Date.now() + 3600000,
      pokeFn: async (_, prompt) => {
        alerts.push(prompt)
        return { ok: true, transport_used: 'claude-channel', channel_session_id: 'x' }
      },
    })
    expect(alerts).toHaveLength(3)
    for (const id of [otherSender, otherRecipient, later]) {
      expect(alerts.some(prompt => prompt.includes(id))).toBe(true)
    }
  } finally {
    await client.close()
    await server.close()
    db.close()
  }
})
