import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [node, cli] = process.argv.slice(2)
async function connect() {
  const transport = new StdioClientTransport({
    command: node, args: ['--import', 'tsx', cli], env: {
      XATS_AGY_DEFER_REGISTRATION: '1', XATS_AGY_PID: String(process.pid),
      XATS_AGY_LAUNCH_ID: process.env.XATS_AGY_LAUNCH_ID!,
      XATS_AGY_IDENTITY_KEY: process.env.XATS_AGY_IDENTITY_KEY!,
      CROSS_AGENT_TEAMS_MCP_URL: process.env.CROSS_AGENT_TEAMS_MCP_URL!,
    },
  })
  const client = new Client({ name: 'agy', version: '1' })
  await client.connect(transport)
  return client
}

const first = await connect()
try {
  await first.callTool({ name: 'register_agent', arguments: { name: 'reader', team: 'lab' } })
  await first.callTool({ name: 'send_message', arguments: {
    to_agent_name: 'reader', body: 'before bridge restart', auto_poke: false, await_ack_s: 0,
  } })
} finally { await first.close() }

const second = await connect()
try {
  const mail = await second.callTool({ name: 'get_inbox' })
  console.log(JSON.stringify(mail.content))
} finally { await second.close() }
