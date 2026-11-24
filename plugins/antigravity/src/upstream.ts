import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { daemonUrl, ownsLaunch, type Launch } from './launch.js'

export const info = { name: 'xats-agy-mcp', version: '1' }
export const allowed = new Set([
  'get_inbox', 'send_message', 'send_message_by_id', 'list_agents', 'broadcast',
  'broadcast_to_role', 'get_delivery_status', 'cancel_unread_alert',
])

export function detail(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause ? `${error.message}: ${detail(error.cause)}` : error.message
}

export function redact(text: string, env: NodeJS.ProcessEnv) {
  for (const secret of [
    env.CROSS_AGENT_TEAMS_MCP_TOKEN, env.XATS_AGY_IDENTITY_KEY, env.XATS_AGY_BIND_TOKEN,
  ]) {
    if (secret) {
      const escaped = JSON.stringify(secret).slice(1, -1)
      text = text.replaceAll(escaped, '[redacted]').replaceAll(secret, '[redacted]')
    }
  }
  return text
}

function payload(result: CallToolResult): unknown {
  if (result.structuredContent) return result.structuredContent
  const first = result.content[0]
  if (first?.type !== 'text') return undefined
  try { return JSON.parse(first.text) } catch { return first.text }
}

const registered = z.object({ agent_id: z.string().uuid(), team: z.string() })
const rejection = z.object({ error: z.string() })
const refused = z.object({
  error: z.enum(['identity_key_conflict', 'agent_id_collision', 'invalid_agy_launch',
    'invalid_name_label', 'invalid_team_label', 'local_launch_required',
    'agy_launcher_not_ready', 'invalid_delivery', 'opencode_runtime_coordinates_required']),
  agent_id: z.never().optional(), ok: z.literal(false).optional(),
})
export class RegistrationRejected extends Error {}
export class RegistrationOutcomeUnknown extends Error {}

async function register(client: Client, launch: Launch, expected?: string) {
  const result = CallToolResultSchema.parse(await client.callTool({
    name: 'register_agent', arguments: { ...launch, agent_type: 'antigravity' },
  }))
  const value = payload(result)
  const failed = rejection.safeParse(value)
  if (result.isError || failed.success) {
    const message = 'register_agent failed: ' + JSON.stringify(value)
    // Only an unambiguous daemon rejection can authorize releasing a fresh claim.
    if (refused.safeParse(value).success && !result.structuredContent
      && result.content.length === 1) {
      throw new RegistrationRejected(message)
    }
    throw new Error(message)
  }
  const identity = registered.parse(value)
  if (identity.team !== launch.team || (expected && identity.agent_id !== expected)) {
    throw new Error('register_agent returned a different identity')
  }
  return identity.agent_id
}

type Owner = { fields: Launch, pid: number }

async function openClient(env: NodeJS.ProcessEnv, pid: number) {
  if (!await ownsLaunch(pid)) throw new Error('Lost launcher process ancestry')
  const url = await daemonUrl(env)
  const token = env.CROSS_AGENT_TEAMS_MCP_TOKEN
  const client = new Client(info)
  const report = (err: unknown) => console.error(redact(detail(err), env))
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: token ? { Authorization: 'Bearer ' + token } : {} },
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error',
      signal: init?.method === 'DELETE' ? AbortSignal.timeout(2000) : init?.signal,
    }),
  })
  async function close() {
    try { await transport.terminateSession() } catch (err) { report(err) }
    await client.close()
  }
  client.onerror = report
  try {
    await client.connect(transport)
    return { client, close }
  } catch (err) {
    await close()
    throw err
  }
}

export async function discoverTools(env: NodeJS.ProcessEnv, pid: number) {
  const session = await openClient(env, pid)
  try { return await listTools(session.client) } finally { await session.close() }
}

async function connect(env: NodeJS.ProcessEnv, owner: Owner, expected?: string) {
  const session = await openClient(env, owner.pid)
  try {
    const id = await register(session.client, owner.fields, expected)
    return { ...session, id }
  } catch (err) {
    try { await session.close() } catch (closeErr) {
      console.error(redact(detail(closeErr), env))
    }
    const message = redact(detail(err), env)
    if (err instanceof RegistrationRejected) throw new RegistrationRejected(message)
    throw new RegistrationOutcomeUnknown(message)
  }
}

export class Upstream {
  private current?: {
    ready: ReturnType<typeof connect>
    users: number
  }
  private agentId?: string

  constructor(private env: NodeJS.ProcessEnv, private launch: Owner) {}

  identity() {
    return this.run(async (_client, _retire, id) => id)
  }

  async run<T>(
    op: (client: Client, retire: () => void, id: string) => Promise<T>,
  ): Promise<T> {
    const current = this.current ??= {
      ready: connect(this.env, this.launch, this.agentId), users: 0,
    }
    const retire = () => {
      if (this.current === current) this.current = undefined
    }
    current.users++
    try {
      const session = await current.ready
      this.agentId = session.id
      return await op(session.client, retire, session.id)
    } catch (err) {
      retire()
      const message = redact(detail(err), this.env)
      if (err instanceof RegistrationRejected || err instanceof RegistrationOutcomeUnknown) {
        throw err
      }
      throw new Error(message)
    } finally {
      current.users--
      if (current !== this.current && current.users === 0) {
        await this.dispose(current.ready)
      }
    }
  }

  close() {
    const current = this.current
    this.current = undefined
    if (current?.users === 0) return this.dispose(current.ready)
  }

  private async dispose(ready: ReturnType<typeof connect>) {
    // A failed handshake already disposed its transport.
    const session = await ready.catch(() => undefined)
    await session?.close()
  }
}

export async function listTools(client: Client) {
  const tools = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client.listTools({ cursor })
    tools.push(...page.tools.filter(tool => allowed.has(tool.name)))
    cursor = page.nextCursor
    if (cursor && cursors.has(cursor)) throw new Error('Repeated tools/list cursor')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return { tools }
}

export async function callTool(
  client: Client, name: string, args: Record<string, unknown> | undefined,
  signal: AbortSignal, retire: () => void,
) {
  let result
  try {
    result = CallToolResultSchema.parse(await client.callTool(
      { name, arguments: args ?? {} }, CallToolResultSchema, { signal },
    ))
  } catch (err) {
    throw new Error(`${name}: outcome unknown; request was not replayed: ${detail(err)}`)
  }
  const failed = rejection.safeParse(payload(result))
  if (failed.success && failed.data.error === 'unknown_agent') retire()
  return result
}
