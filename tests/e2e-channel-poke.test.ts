import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { runRegistrationSequence } from '../plugins/cross-agent-teams-channel/src/daemon-client.js'
import { createProxyServer, relayChannelWake } from '../plugins/cross-agent-teams-channel/src/proxy.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-e2e-chan-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

function createOldSchemaDb(dbPath: string): void {
  const db = openDb(dbPath)
  db.exec(`CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    team TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0,
    tmux_pane_id TEXT,
    channel_session_id TEXT
  )`)
  db.exec(`CREATE UNIQUE INDEX agents_identity_idx ON agents(team, name)`)
  db.close()
}

describe('e2e channel poke (self-binding)', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    vi.restoreAllMocks()
  })

  it('daemon bootstraps cleanly from old agents schema and migrates without data loss', async () => {
    const dir = tmp(); cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    createOldSchemaDb(dbPath)
    const seedDb = openDb(dbPath)
    seedDb.prepare(`INSERT INTO agents (agent_id, team, role, name, registered_at, last_seen_at, channel_session_id)
      VALUES ('legacy-agent', 'default', 'backend', 'legacy', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'csid-legacy')`).run()
    seedDb.close()

    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const health = await fetch(`http://${host}:${port}/health`)
    expect(health.ok).toBe(true)

    const db = openDb(dbPath)
    const row = db.prepare(
      `SELECT channel_session_id, delivery_kind, delivery_payload
       FROM agents
       WHERE agent_id='legacy-agent'`
    ).get() as {
      channel_session_id: string | null
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.channel_session_id).toBe('csid-legacy')
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      channel_session_id: 'csid-legacy',
    })
    db.close()
    await app.close()
  }, 20000)

  it('Claude-side bind_channel({csid}) + send_message auto-poke triggers channel notification with no tmux', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    // Bob (owner) registers on the daemon — this is the Claude host identity.
    const bobT = new StreamableHTTPClientTransport(new URL(url))
    const bobC = new Client({ name: 'bob', version: '0.0.0' })
    await bobC.connect(bobT)
    const bobResp = await bobC.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', model: 'opus', role: 'backend', name: 'bob' }
    })
    const bob = await parseTool(bobResp)
    expect(bob.agent_id).toBeDefined()

    // Proxy host-facing McpServer wired to a fake Claude host client, so we can
    // observe the notifications/claude/channel relay.
    const proxyServer = createProxyServer()
    const [hostT, proxyServerT] = InMemoryTransport.createLinkedPair()
    await proxyServer.connect(proxyServerT)
    const hostClient = new Client({ name: 'fake-host', version: '0.0.0' })
    const hostNotifs: Array<{ method: string; params: unknown }> = []
    hostClient.fallbackNotificationHandler = async (n) => {
      hostNotifs.push({ method: n.method, params: n.params })
    }
    await hostClient.connect(hostT)

    // Proxy runs its daemon-side registration sequence (register_agent →
    // subscribe_channel_wake) — no bind_channel, no team/name.
    const csid = 'csid-bob-e2e'
    const seq = await runRegistrationSequence({
      daemonUrl: url,
      channel_session_id: csid,
      backoffInitialMs: 10,
      backoffMaxMs: 50,
      notificationHandler: (params) => {
        relayChannelWake(proxyServer, params as { content: string; meta: Record<string, string> })
      }
    })
    expect(seq.order).toEqual(['register_agent', 'subscribe_channel_wake'])

    // Bob (Claude host) calls bind_channel({csid}) — self-binding.
    const bindResp = await bobC.callTool({
      name: 'bind_channel',
      arguments: { channel_session_id: csid }
    })
    const bindObj = await parseTool(bindResp)
    expect(bindObj).toEqual({ ok: true })

    // Alice (peer) registers and messages Bob; auto-poke uses the channel.
    const aliceT = new StreamableHTTPClientTransport(new URL(url))
    const aliceC = new Client({ name: 'alice', version: '0.0.0' })
    await aliceC.connect(aliceT)
    const aliceResp = await aliceC.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', model: 'opus', role: 'backend', name: 'alice' }
    })
    const alice = await parseTool(aliceResp)
    const sendResp = await aliceC.callTool({
      name: 'send_message_by_id',
      arguments: { to_agent_id: bob.agent_id as string, body: 'check inbox' }
    })
    const sendObj = await parseTool(sendResp)
    expect(sendObj).toMatchObject({ poked: true, retry_scheduled: false })

    // Allow notification to propagate.
    const deadline = Date.now() + 2000
    while (hostNotifs.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20))
    }
    expect(hostNotifs.length).toBeGreaterThanOrEqual(1)
    expect(hostNotifs[0].method).toBe('notifications/claude/channel')
    // The channel wake carries the hint, and the hint identifies both the
    // sender and the agent it was addressed to (bob registered as bob@default).
    expect(hostNotifs[0].params).toMatchObject({
      content: `新邮件 from alice@${alice.team as string} (${alice.agent_id as string}) → bob@${bob.team as string}, 请调 get_inbox 查看`,
    })

    const content = (hostNotifs[0].params as { content: string }).content
    expect(content).toContain('get_inbox')
    expect(content).toContain(`→ bob@${bob.team as string}`)
    expect(content).not.toContain('check inbox')

    await seq.close()
    await aliceC.close()
    await bobC.close()
    await hostClient.close()
    await proxyServer.close()
    await app.close()
  }, 20000)
})
