import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-toolhint-'))

describe('tool descriptions: auto-poke and delivery status', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  interface ToolInfo {
    name: string
    description?: string
    inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] }
  }
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

  it('send_message description mentions auto-poke default + quiet-guard', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'send_message')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/poke/i)
    expect(d).toMatch(/by default|default/i)
    expect(d).toMatch(/quiet-guard|guard/i)
    expect(d).toMatch(/auto_poke/)
    expect(d).toMatch(/poked/)
    expect(d).toMatch(/poke_skip_reasons/)
    // retry-on-guard_failed behavior is documented
    expect(d).toMatch(/retry|backoff/i)
    expect(d).toMatch(/retry_scheduled/)
    expect(d).toMatch(/retry_delays_s/)
  })

  it('broadcast description states auto-poke is default-on and explains auto_poke:false opt-out', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'broadcast')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/poke/i)
    expect(d).toMatch(/auto-poke/i)
    expect(d).toMatch(/default/i)
    expect(d).toMatch(/auto_poke:\s*false/i)
    expect(d).toMatch(/quiet-guard|guard/i)
    expect(d).toMatch(/poked/)
    expect(d).toMatch(/poke_skip_reasons/)
    expect(d).toMatch(/retry|backoff/i)
    expect(d).toMatch(/retry_scheduled/)
    expect(d).toMatch(/retry_delays_s/)
  })

  it('send_message description states auto-poke injects only a short hint, not the body', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'send_message')
    const d = tool!.description!
    expect(d).toMatch(/only.*short.*hint|短.*提醒|only.*hint/i)
    expect(d).toMatch(/get_inbox/)
    expect(d).toMatch(/新邮件 from/)
    // The documented example must show the target segment, otherwise callers
    // are told a format the daemon no longer injects.
    expect(d).toMatch(/新邮件 from <sender> → </)
  })

  it('broadcast description states auto-poke injects only a short hint, not the body', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'broadcast')
    const d = tool!.description!
    expect(d).toMatch(/only.*short.*hint|短.*提醒|only.*hint/i)
    expect(d).toMatch(/get_inbox/)
    expect(d).toMatch(/新邮件 from/)
    // The documented example must show the target segment, otherwise callers
    // are told a format the daemon no longer injects.
    expect(d).toMatch(/新邮件 from <sender> → </)
  })

  it('send_message and broadcast tool schemas expose auto_poke as optional boolean', async () => {
    const tools = await listTools()
    const sm = tools.find(t => t.name === 'send_message')
    const bc = tools.find(t => t.name === 'broadcast')
    expect(sm).toBeDefined()
    expect(bc).toBeDefined()
    const smSchema = sm!.inputSchema!
    const bcSchema = bc!.inputSchema!
    expect(smSchema.properties?.auto_poke?.type).toBe('boolean')
    expect(bcSchema.properties?.auto_poke?.type).toBe('boolean')
    expect(smSchema.required ?? []).not.toContain('auto_poke')
    expect(bcSchema.required ?? []).not.toContain('auto_poke')
  })

  it('task tools are not exposed publicly', async () => {
    const tools = await listTools()
    expect(tools.map(tool => tool.name)).not.toEqual(
      expect.arrayContaining(['task_add', 'task_claim', 'task_complete', 'task_list'])
    )
  })

  it('get_inbox description does NOT recommend poke (poke pushes, get_inbox pulls — no self-wake)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'get_inbox')
    expect(tool).toBeDefined()
    expect(tool!.description).not.toMatch(/poke/i)
  })

  it('poke tool is not exposed publicly', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'poke')
    expect(tool).toBeUndefined()
  })

  it('get_delivery_status exposes sender-side wake status lookup', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'get_delivery_status')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/delivery status/i)
    expect(d).toMatch(/auto-poke/i)
    expect(tool!.inputSchema?.properties?.message_id?.type).toBe('string')
  })

  it('register_agent description documents best-effort runtime binding plus explicit fallback', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/client/)
    expect(d).toMatch(/ui_pid/)
    expect(d).toMatch(/best-effort attempts runtime binding|best-effort runtime binding/i)
    expect(d).toMatch(/bind_runtime_identity/)
    expect(d).toMatch(/detect_tmux_pane/)
    expect(d).toMatch(/tmux_pane_id/)
    expect(d).toMatch(/recognized local clients|automatic|explicit runtime binding/i)
  })

  it('register_agent description avoids exposing matcher-selection details', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    const d = tool!.description!
    expect(d).not.toMatch(/conservatively|choose the built-in process matcher/i)
  })

  it('register_agent description explains tmux remains unavailable until automatic or explicit binding succeeds', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    const d = tool!.description!
    expect(d).toMatch(/tmux-based poke delivery stays unavailable/i)
    expect(d).toMatch(/automatic or explicit runtime binding succeeds/i)
  })

  it('register_agent description states identity reuse on (device, team, name)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    const d = tool!.description!
    expect(d).toMatch(/reuse|reuses/i)
    expect(d).toMatch(/device.*team.*name|\(device, team, name\)/i)
    expect(d).toMatch(/tmux_pane_id/)
  })

  it('register_agent description documents the unified Codex registration path', async () => {
    const tools = await listTools()
    const d = tools.find(t => t.name === 'register_agent')!.description!
    expect(d).toMatch(/unified registration entry point/i)
    expect(d).toMatch(/client/)
    expect(d).toMatch(/codex/i)
    expect(d).toMatch(/thread_id/)
    expect(d).toMatch(/CODEX_THREAD_ID/)
    expect(d).toMatch(/Mac Codex App/)
    expect(d).toMatch(/not conversation-scoped/)
  })

  it('register_agent describes project_dir team derivation', async () => {
    const tools = await listTools()
    const registerAgent = tools.find(t => t.name === 'register_agent')!.description!
    expect(registerAgent).toMatch(/project_dir/)
    expect(registerAgent).toMatch(/current working directory/)
    expect(registerAgent).toMatch(/team/)
    expect(registerAgent).toMatch(/basename/)
  })

  it('register_agent says xats is the service context, not a team name', async () => {
    const tools = await listTools()
    const registerAgent = tools.find(t => t.name === 'register_agent')!.description!
    expect(registerAgent).toMatch(/register to xats/i)
    expect(registerAgent).toMatch(/register to cross-agent-teams/i)
    expect(registerAgent).toMatch(/not to the `team` field/i)
    expect(registerAgent).toMatch(/do not set `team` to `xats`/i)
    expect(registerAgent).toMatch(/bare word "register"/i)
    expect(registerAgent).toMatch(/already about cross-agent-teams registration/i)
  })

  it('bind_runtime_identity description documents pid-first verification', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'bind_runtime_identity')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/agent/)
    expect(d).toMatch(/ui_pid/)
    expect(d).toMatch(/pid .* tty .* pane|pid → tty → pane/i)
    expect(d).toMatch(/detect_tmux_pane/)
  })

  it('bind_channel description marks it as a low-level rebind tool', async () => {
    const tools = await listTools()
    const d = tools.find(t => t.name === 'bind_channel')!.description!
    expect(d).toMatch(/low-level rebind tool/i)
    expect(d).toMatch(/register_agent/)
    expect(d).toMatch(/agent_type: "claude-code"|client.*claude-code/i)
  })

  it('unregister_self description makes the self-only teardown semantics discoverable', async () => {
    const tools = await listTools()
    const d = tools.find(t => t.name === 'unregister_self')!.description!
    expect(d).toMatch(/current agent registration|current agent/i)
    expect(d).toMatch(/does not delete other agents|self/i)
    expect(d).not.toMatch(/tasks_in_progress/)
    expect(d).toMatch(/unregistered state/i)
  })

  it('send_message description documents delivery NOT filtered by online/idle', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'send_message')
    const d = tool!.description!
    expect(d).toMatch(/offline|idle|not filtered/i)
    // Word-bounded so it still rejects a stale "5 min" idle-window claim
    // without firing on the unrelated "15 minutes" unread-alert deadline.
    expect(d).not.toMatch(/\b5 min/i)
  })

  it('send_message_by_id is registered with id-based addressing', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'send_message_by_id')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/agent_id|UUID/i)
    expect(d).toMatch(/offline|not filtered/i)
  })

  it('broadcast description documents all-member fan-out', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'broadcast')
    const d = tool!.description!
    expect(d).toMatch(/every team member|except the sender/i)
    expect(d).toMatch(/not filtered|offline|idle/i)
    expect(d).not.toMatch(/5 min/i)
  })

  it('send_message description mentions broadcast/broadcast_to_role and cross-team constraint', async () => {
    const tools = await listTools()
    const d = tools.find(t => t.name === 'send_message')!.description!
    expect(d).toMatch(/broadcast_to_role/)
    expect(d).toMatch(/broadcast\b/)
    expect(d).toMatch(/to_team/)
    expect(d).toMatch(/明确指定|explicit|explicitly/i)
    expect(d).toMatch(/短.*提醒|wake-up hint|SHORT/i)
    expect(d).toMatch(/get_inbox/)
  })

  it('broadcast description states same-team scope and points at broadcast_to_role', async () => {
    const tools = await listTools()
    const d = tools.find(t => t.name === 'broadcast')!.description!
    expect(d).toMatch(/same[- ]?team|同.*team|team[- ]wide/i)
    expect(d).toMatch(/broadcast_to_role/)
    expect(d).toMatch(/auto_poke/)
    expect(d).toMatch(/get_inbox/)
  })

  it('broadcast_to_role description states same-team constraint and references send_message for cross-team', async () => {
    const tools = await listTools()
    const d = tools.find(t => t.name === 'broadcast_to_role')!.description!
    expect(d).toMatch(/same[- ]?team|同.*team/i)
    expect(d).toMatch(/send_message/)
    expect(d).toMatch(/to_team/)
    expect(d).toMatch(/auto_poke/)
    expect(d).toMatch(/get_inbox/)
  })
})
