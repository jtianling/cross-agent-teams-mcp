// Lab MCP client: performs one tool call against the LAB daemon over its own
// MCP session, optionally holding the session open.
//
//   node lab/lab-mcp.mjs register_agent '{"agent_type":"codex","name":"a", ...}'
//   node lab/lab-mcp.mjs --hold register_agent '{...}'      # keep session alive
//
// Why --hold matters: the daemon binds an agent identity to the MCP SESSION
// that registered it.  A stub codex that exits right after registering drops
// its session, so anything session-scoped (takeover, unknown_session, poke
// routing) behaves differently than with a real codex whose session lives on.
// Hold the session for the whole scenario when standing in for a codex.
//
// Env: XATS_LAB_HOME (default ~/.xats-lab), XATS_LAB_PORT (default 9199).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const lab = process.env.XATS_LAB_HOME ?? join(homedir(), '.xats-lab')
const port = Number(process.env.XATS_LAB_PORT ?? 9199)
const token = readFileSync(join(lab, 'token'), 'utf8').trim()

const argv = process.argv.slice(2)
const hold = argv[0] === '--hold'
const [tool, rawArgs] = hold ? argv.slice(1) : argv

if (!tool) {
  console.error('usage: node lab/lab-mcp.mjs [--hold] <tool> [json-args]')
  process.exit(2)
}
if (port === 9100) {
  console.error('refusing to talk to the production port 9100')
  process.exit(2)
}

const client = new Client({ name: 'xats-lab-client', version: '0.1.0' })
const transport = new StreamableHTTPClientTransport(
  new URL(`http://127.0.0.1:${port}/mcp`),
  { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
)

await client.connect(transport)
const res = await client.callTool({
  name: tool,
  arguments: rawArgs ? JSON.parse(rawArgs) : {},
})
const text = res?.content?.[0]?.text
console.log(text ?? JSON.stringify(res))

if (hold) {
  // Park until killed; the scenario driver owns this process's lifetime.
  process.stdin.resume()
  const bye = async () => {
    try { await client.close() } catch { /* best-effort */ }
    process.exit(0)
  }
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
} else {
  await client.close()
}
