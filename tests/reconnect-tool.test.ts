import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

// reconnect's single-match path drives the claude-code register path, which runs
// the ui_pid preflight + auto runtime binding. Stub those daemon modules so the
// test does not depend on a live process / tmux.
vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: vi.fn(async () => ({ error: 'not_found', candidates: [] })),
}))
vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: vi.fn(async () => ({
    ok: true,
    tmux_pane_id: '%1',
    verification_mode: 'verified_pid_tty_pane',
    tty: 'ttys001',
    ui_pid: 25079,
  })),
}))
vi.mock('../src/mcp/register-codex-self.js', () => ({
  RegisterCodexSelfService: class {
    constructor(private readonly registerSvc: {
      register: (input: Record<string, unknown>) => Record<string, unknown>
    }) {}

    async register(
      input: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      const threadId = input.thread_id as string
      if (threadId === '99999999-9999-4999-8999-999999999999') {
        return {
          error: 'codex_resume_failed',
          detail: { thread_id: threadId, cause: 'no rollout found' },
        }
      }
      const wsUrl = (input.ws_url as string | undefined)?.trim()
        || 'ws://127.0.0.1:8799'
      const result = this.registerSvc.register({
        connection_id: input.connection_id,
        agent_type: 'codex',
        model: input.model,
        device: input.device,
        name: input.name,
        role: input.role,
        team: input.team,
        delivery: {
          kind: 'codex-appserver',
          thread_id: threadId,
          ws_url: wsUrl,
        },
      })
      return 'error' in result
        ? result
        : { ...result, thread_id: threadId, ws_url: wsUrl }
    }
  },
}))

// Stub the opencode self-register service so tests do not hit a real HTTP
// server. resolveSessionId mirrors the real validation contract:
//  - base_url containing "unreachable"     -> opencode_unreachable
//  - auth_token_ref === 'MISSING_TOKEN'    -> missing_auth_token
//  - preferredSessionId === 'ses_notfound' -> session_not_found
//  - otherwise echoes the preferred id, or 'ses_resolved' when auto-resolving.
// register() simulates a register-phase failure for 'ses_register_fail'.
vi.mock('../src/mcp/register-opencode-self.js', () => ({
  RegisterOpencodeSelfService: class {
    constructor(private readonly registerSvc: {
      register: (input: Record<string, unknown>) => Record<string, unknown>
    }) {}

    async resolveSessionId(
      baseUrlRaw: string,
      authTokenRef?: string,
      preferredSessionId?: string
    ): Promise<Record<string, unknown>> {
      if (/unreachable/i.test(baseUrlRaw)) {
        return {
          error: 'opencode_unreachable',
          detail: { base_url: baseUrlRaw, cause: 'connection refused' },
        }
      }
      if (authTokenRef === 'MISSING_TOKEN') {
        return { error: 'missing_auth_token', detail: { ref: 'MISSING_TOKEN' } }
      }
      if (preferredSessionId === 'ses_notfound') {
        return {
          error: 'session_not_found',
          detail: { base_url: baseUrlRaw, session_id: 'ses_notfound' },
        }
      }
      return { session_id: preferredSessionId ?? 'ses_resolved' }
    }

    async register(
      input: Record<string, unknown>
    ): Promise<Record<string, unknown>> {
      const sessionId = input.session_id as string
      if (sessionId === 'ses_register_fail') {
        return {
          error: 'opencode_unreachable',
          detail: { base_url: input.base_url, cause: 'health check failed' },
        }
      }
      const result = this.registerSvc.register({
        connection_id: input.connection_id,
        agent_type: 'opencode',
        model: input.model,
        device: input.device,
        name: input.name,
        role: input.role,
        team: input.team,
        delivery: {
          kind: 'opencode-server',
          session_id: sessionId,
          base_url: input.base_url,
          ...(input.auth_token_ref === undefined
            ? {}
            : { auth_token_ref: input.auth_token_ref }),
        },
      })
      return 'error' in result
        ? result
        : { ...result, session_id: sessionId, base_url: input.base_url }
    }
  },
}))

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-reconnect-tool-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

async function setup(opts: { localDevice?: string } = {}) {
  const dir = tmp()
  const dbPath = join(dir, 'data.db')
  const db = openDb(dbPath)
  const localDevice = opts.localDevice ?? 'local'
  applySchema(db, { localDevice })
  const server = new McpServer({ name: 'test-server', version: '0.0.0' })
  const holder: { current: string | undefined } = { current: undefined }
  const sessionId = 'session-reconnect'
  registerBusinessTools(
    server,
    db,
    () => holder.current ?? sessionId,
    undefined,
    (agentId) => { holder.current = agentId },
    () => sessionId,
    undefined,
    undefined,
    undefined,
    undefined,
    { localDevice },
  )
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'claude-code', version: '0.0.0' })
  await client.connect(ct)
  return {
    dir,
    db,
    server,
    client,
    transport: ct,
    holder,
    repo: new AgentsRepo(db),
  }
}

function seedAgent(
  db: ReturnType<typeof openDb>,
  args: {
    agent_id: string
    device?: string
    team?: string
    name: string
    runtime_ui_pid: number | null
    last_seen_at: string
    registered_at?: string
    last_processed_event_id?: number
  }
): void {
  db.prepare(
    `INSERT INTO agents (
       agent_id, agent_type, device, team, role, name, registered_at, last_seen_at,
       runtime_ui_pid, last_processed_event_id
     ) VALUES (?, 'claude-code', ?, ?, 'worker', ?, ?, ?, ?, ?)`
  ).run(
    args.agent_id,
    args.device ?? 'local',
    args.team ?? 'default',
    args.name,
    args.registered_at ?? args.last_seen_at,
    args.last_seen_at,
    args.runtime_ui_pid,
    args.last_processed_event_id ?? 0,
  )
}

function seedCodexAgent(
  db: ReturnType<typeof openDb>,
  args: {
    agent_id: string
    thread_id: string
    device?: string
    team?: string
    name: string
    last_seen_at: string
    registered_at?: string
    last_processed_event_id?: number
  }
): void {
  db.prepare(
    `INSERT INTO agents (
       agent_id, agent_type, device, team, role, name, registered_at, last_seen_at,
       delivery_kind, delivery_payload, last_processed_event_id
     ) VALUES (?, 'codex', ?, ?, 'worker', ?, ?, ?, 'codex-appserver', ?, ?)`
  ).run(
    args.agent_id,
    args.device ?? 'local',
    args.team ?? 'default',
    args.name,
    args.registered_at ?? args.last_seen_at,
    args.last_seen_at,
    JSON.stringify({
      thread_id: args.thread_id,
      ws_url: 'ws://127.0.0.1:8799',
    }),
    args.last_processed_event_id ?? 0,
  )
}

function seedOpencodeAgent(
  db: ReturnType<typeof openDb>,
  args: {
    agent_id: string
    session_id: string
    base_url?: string
    device?: string
    team?: string
    name: string
    last_seen_at: string
    registered_at?: string
    last_processed_event_id?: number
    auth_token_ref?: string
  }
): void {
  db.prepare(
    `INSERT INTO agents (
       agent_id, agent_type, device, team, role, name, registered_at, last_seen_at,
       delivery_kind, delivery_payload, last_processed_event_id
     ) VALUES (?, 'opencode', ?, ?, 'worker', ?, ?, ?, 'opencode-server', ?, ?)`
  ).run(
    args.agent_id,
    args.device ?? 'local',
    args.team ?? 'default',
    args.name,
    args.registered_at ?? args.last_seen_at,
    args.last_seen_at,
    JSON.stringify({
      session_id: args.session_id,
      base_url: args.base_url ?? 'http://127.0.0.1:18888',
      ...(args.auth_token_ref === undefined ? {} : { auth_token_ref: args.auth_token_ref }),
    }),
    args.last_processed_event_id ?? 0,
  )
}

describe('reconnect tool', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('single match reuses agent_id, refreshes last_seen_at, keeps registered_at + cursor', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const REGISTERED_AT = '2024-01-01T00:00:00.000Z'
    const LAST_SEEN = '2024-01-02T00:00:00.000Z'
    seedAgent(db, {
      agent_id: 'X',
      name: 'xats-creator',
      runtime_ui_pid: 25079,
      last_seen_at: LAST_SEEN,
      registered_at: REGISTERED_AT,
      last_processed_event_id: 42,
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    expect(obj.agent_id).toBe('X')
    expect(obj.name).toBe('xats-creator')
    expect(obj.team).toBe('default')
    expect(obj.last_seen_at).toBe(LAST_SEEN)
    expect('channel_session_id' in obj).toBe(true)

    const row = db.prepare(
      `SELECT agent_id, registered_at, last_seen_at, last_processed_event_id
       FROM agents WHERE team='default' AND name='xats-creator'`
    ).get() as {
      agent_id: string
      registered_at: string
      last_seen_at: string
      last_processed_event_id: number
    }
    expect(row.agent_id).toBe('X')
    expect(row.registered_at).toBe(REGISTERED_AT)
    expect(row.last_processed_event_id).toBe(42)
    expect(row.last_seen_at).not.toBe(LAST_SEEN)

    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM agents WHERE name='xats-creator'`
    ).get() as { c: number }
    expect(count.c).toBe(1)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('resolves a row stored under the configured local device label', async () => {
    const { dir, db, server, client, transport } = await setup({ localDevice: 'jt' })
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'J',
      device: 'jt',
      name: 'xats-creator',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    expect(obj.agent_id).toBe('J')
    expect(obj.name).toBe('xats-creator')
    expect(obj.team).toBe('default')

    const row = db.prepare(
      `SELECT device FROM agents WHERE agent_id='J'`
    ).get() as { device: string }
    expect(row.device).toBe('jt')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('zero match returns need_register without creating or mutating any row', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'Y',
      name: 'other',
      runtime_ui_pid: 11111,
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const before = db.prepare(`SELECT last_seen_at FROM agents WHERE agent_id='Y'`).get() as { last_seen_at: string }
    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 99999 } })
    const obj = await parseTool(resp)

    expect(obj.need_register).toBe(true)
    expect(obj.reason).toContain('Ask the user for the missing name/team')
    expect(obj.reason).toContain('Do not invent a name or team')
    expect(obj.reason).not.toContain('register a new identity')
    expect(typeof obj.reason).toBe('string')
    expect(obj.ok).toBeUndefined()

    const count = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number }
    expect(count.c).toBe(1)
    const after = db.prepare(`SELECT last_seen_at FROM agents WHERE agent_id='Y'`).get() as { last_seen_at: string }
    expect(after.last_seen_at).toBe(before.last_seen_at)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('multiple matches return ambiguous candidates ordered by last_seen_at DESC, no mutation', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'A',
      name: 'xats-tester',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-01-01T00:00:00.000Z',
    })
    seedAgent(db, {
      agent_id: 'B',
      name: 'xats-creator',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-06-01T00:00:00.000Z',
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.ambiguous).toBe(true)
    const candidates = obj.candidates as Array<{ name: string; last_seen_at: string }>
    expect(candidates.map(c => c.name)).toEqual(['xats-creator', 'xats-tester'])
    expect(candidates[0].last_seen_at).toBe('2024-06-01T00:00:00.000Z')

    // No mutation: both seeded last_seen_at values unchanged.
    const rows = db.prepare(`SELECT agent_id, last_seen_at FROM agents ORDER BY agent_id`).all() as Array<{
      agent_id: string
      last_seen_at: string
    }>
    expect(rows).toEqual([
      { agent_id: 'A', last_seen_at: '2024-01-01T00:00:00.000Z' },
      { agent_id: 'B', last_seen_at: '2024-06-01T00:00:00.000Z' },
    ])

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('does not match a remote-device row for the same ui_pid (returns need_register)', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'R',
      device: 'gx',
      name: 'remote-alice',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.need_register).toBe(true)
    expect(obj.reason).toContain('Ask the user for the missing name/team')
    expect(obj.reason).toContain('Do not invent a name or team')
    expect(obj.reason).not.toContain('register a new identity')
    expect(obj.ok).toBeUndefined()

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('reconnects a stale Codex CLI/App identity by CODEX_THREAD_ID', async () => {
    const { dir, db, server, client, transport, holder } = await setup()
    cleanups.push(dir)
    const threadId = '11111111-1111-4111-8111-111111111111'
    const registeredAt = '2024-01-01T00:00:00.000Z'
    const lastSeen = '2024-01-02T00:00:00.000Z'
    seedCodexAgent(db, {
      agent_id: 'C',
      thread_id: threadId,
      name: 'xats-codex',
      last_seen_at: lastSeen,
      registered_at: registeredAt,
      last_processed_event_id: 42,
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { thread_id: threadId },
    })
    const obj = await parseTool(resp)

    expect(obj).toMatchObject({
      ok: true,
      agent_id: 'C',
      name: 'xats-codex',
      team: 'default',
      thread_id: threadId,
      ws_url: 'ws://127.0.0.1:8799',
      last_seen_at: lastSeen,
    })
    expect(holder.current).toBe('C')
    const row = db.prepare(
      `SELECT agent_id, registered_at, last_seen_at, last_processed_event_id
       FROM agents WHERE agent_id='C'`
    ).get() as {
      agent_id: string
      registered_at: string
      last_seen_at: string
      last_processed_event_id: number
    }
    expect(row.agent_id).toBe('C')
    expect(row.registered_at).toBe(registeredAt)
    expect(row.last_processed_event_id).toBe(42)
    expect(row.last_seen_at).not.toBe(lastSeen)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns need_register when no local codex row matches thread_id', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const threadId = '22222222-2222-4222-8222-222222222222'
    seedCodexAgent(db, {
      agent_id: 'C',
      thread_id: '11111111-1111-4111-8111-111111111111',
      name: 'xats-codex',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { thread_id: threadId },
    })
    const obj = await parseTool(resp)

    expect(obj.need_register).toBe(true)
    expect(obj.reason).toContain('Ask the user for the missing name/team')
    expect(obj.reason).toContain('Do not invent a name or team')
    expect(obj.reason).not.toContain('register a new identity')
    expect(obj.reason).toContain(threadId)
    const row = db.prepare(
      `SELECT agent_id, registered_at, last_seen_at, last_processed_event_id
       FROM agents WHERE agent_id='C'`
    ).get()
    expect(row).toEqual({
      agent_id: 'C',
      registered_at: '2024-01-02T00:00:00.000Z',
      last_seen_at: '2024-01-02T00:00:00.000Z',
      last_processed_event_id: 0,
    })

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it(
    'returns ambiguous codex candidates ordered by last_seen_at without mutation',
    async () => {
      const { dir, db, server, client, transport } = await setup()
      cleanups.push(dir)
      const threadId = '33333333-3333-4333-8333-333333333333'
      seedCodexAgent(db, {
        agent_id: 'C1',
        thread_id: threadId,
        name: 'older-codex',
        last_seen_at: '2024-01-01T00:00:00.000Z',
      })
      seedCodexAgent(db, {
        agent_id: 'C2',
        thread_id: threadId,
        name: 'newer-codex',
        last_seen_at: '2024-06-01T00:00:00.000Z',
      })

      const resp = await client.callTool({
        name: 'reconnect',
        arguments: { thread_id: threadId },
      })
      const obj = await parseTool(resp)

      expect(obj.ambiguous).toBe(true)
      const candidates = obj.candidates as Array<{
        name: string
        last_seen_at: string
      }>
      expect(candidates.map(candidate => candidate.name)).toEqual([
        'newer-codex',
        'older-codex',
      ])
      const rows = db.prepare(
        `SELECT agent_id, last_seen_at FROM agents ORDER BY agent_id`
      ).all()
      expect(rows).toEqual([
        { agent_id: 'C1', last_seen_at: '2024-01-01T00:00:00.000Z' },
        { agent_id: 'C2', last_seen_at: '2024-06-01T00:00:00.000Z' },
      ])

      await transport.close()
      await client.close()
      db.close()
      await server.close()
    }
  )

  it('does not reclaim a codex identity when thread/resume fails', async () => {
    const { dir, db, server, client, transport, holder } = await setup()
    cleanups.push(dir)
    const threadId = '99999999-9999-4999-8999-999999999999'
    seedCodexAgent(db, {
      agent_id: 'C',
      thread_id: threadId,
      name: 'xats-codex',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { thread_id: threadId },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'codex_resume_failed',
      detail: { thread_id: threadId, cause: 'no rollout found' },
    })
    const row = db.prepare(
      `SELECT agent_id, registered_at, last_seen_at, last_processed_event_id
       FROM agents WHERE agent_id='C'`
    ).get()
    expect(row).toEqual({
      agent_id: 'C',
      registered_at: '2024-01-02T00:00:00.000Z',
      last_seen_at: '2024-01-02T00:00:00.000Z',
      last_processed_event_id: 0,
    })
    expect(holder.current).toBeUndefined()

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  const OC_BASE_URL = 'http://127.0.0.1:18888'

  it('reconnects a single local opencode identity by (base_url, session_id)', async () => {
    const { dir, db, server, client, transport, holder } = await setup()
    cleanups.push(dir)
    const registeredAt = '2024-01-01T00:00:00.000Z'
    const lastSeen = '2024-01-02T00:00:00.000Z'
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_oc1',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: lastSeen,
      registered_at: registeredAt,
      last_processed_event_id: 42,
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_oc1' },
    })
    const obj = await parseTool(resp)

    expect(obj).toMatchObject({
      ok: true,
      agent_id: 'O',
      name: 'xats-opencode',
      team: 'default',
      session_id: 'ses_oc1',
      base_url: OC_BASE_URL,
      last_seen_at: lastSeen,
    })
    expect(holder.current).toBe('O')
    const row = db.prepare(
      `SELECT agent_id, registered_at, last_seen_at, last_processed_event_id
       FROM agents WHERE agent_id='O'`
    ).get() as {
      agent_id: string
      registered_at: string
      last_seen_at: string
      last_processed_event_id: number
    }
    expect(row.registered_at).toBe(registeredAt)
    expect(row.last_processed_event_id).toBe(42)
    expect(row.last_seen_at).not.toBe(lastSeen)

    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM agents WHERE name='xats-opencode'`
    ).get() as { c: number }
    expect(count.c).toBe(1)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('auto-resolves session_id from base_url when session_id is omitted', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    // Mock resolveSessionId returns 'ses_resolved' for reachable base_urls.
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_resolved',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL },
    })
    const obj = await parseTool(resp)

    expect(obj).toMatchObject({
      ok: true,
      agent_id: 'O',
      name: 'xats-opencode',
      session_id: 'ses_resolved',
      base_url: OC_BASE_URL,
    })

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns need_register when no local opencode row matches (base_url, session_id)', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_other',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_nomatch' },
    })
    const obj = await parseTool(resp)

    expect(obj.need_register).toBe(true)
    expect(obj.reason).toContain('Ask the user for the missing name/team')
    expect(obj.reason).toContain('Do not invent a name or team')
    expect(obj.reason).not.toContain('register a new identity')
    expect(obj.reason).toContain('ses_nomatch')
    const row = db.prepare(
      `SELECT last_seen_at FROM agents WHERE agent_id='O'`
    ).get() as { last_seen_at: string }
    expect(row.last_seen_at).toBe('2024-01-02T00:00:00.000Z')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns ambiguous opencode candidates ordered by last_seen_at without mutation', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'O1',
      session_id: 'ses_dup',
      base_url: OC_BASE_URL,
      name: 'older-oc',
      last_seen_at: '2024-01-01T00:00:00.000Z',
    })
    seedOpencodeAgent(db, {
      agent_id: 'O2',
      session_id: 'ses_dup',
      base_url: OC_BASE_URL,
      name: 'newer-oc',
      last_seen_at: '2024-06-01T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_dup' },
    })
    const obj = await parseTool(resp)

    expect(obj.ambiguous).toBe(true)
    const candidates = obj.candidates as Array<{ name: string; last_seen_at: string }>
    expect(candidates.map(c => c.name)).toEqual(['newer-oc', 'older-oc'])
    const rows = db.prepare(
      `SELECT agent_id, last_seen_at FROM agents ORDER BY agent_id`
    ).all()
    expect(rows).toEqual([
      { agent_id: 'O1', last_seen_at: '2024-01-01T00:00:00.000Z' },
      { agent_id: 'O2', last_seen_at: '2024-06-01T00:00:00.000Z' },
    ])

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('does not match a remote-device opencode row (returns need_register)', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'R',
      session_id: 'ses_rem',
      base_url: OC_BASE_URL,
      device: 'gx',
      name: 'remote-oc',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_rem' },
    })
    const obj = await parseTool(resp)

    expect(obj.need_register).toBe(true)
    expect(obj.reason).toContain('Ask the user for the missing name/team')
    expect(obj.reason).toContain('Do not invent a name or team')
    expect(obj.reason).not.toContain('register a new identity')
    expect(obj.ok).toBeUndefined()

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns opencode_unreachable without mutation when session resolve fails', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const unreachableUrl = 'http://unreachable-host:9999'

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: unreachableUrl },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'opencode_unreachable',
      detail: { base_url: unreachableUrl, cause: 'connection refused' },
    })
    const count = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number }
    expect(count.c).toBe(0)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('does not reclaim an opencode identity when register-phase health check fails', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    // Sentinel session_id makes the stubbed register() return opencode_unreachable.
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_register_fail',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_register_fail' },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'opencode_unreachable',
      detail: { base_url: OC_BASE_URL, cause: 'health check failed' },
    })
    const row = db.prepare(
      `SELECT last_seen_at FROM agents WHERE agent_id='O'`
    ).get() as { last_seen_at: string }
    expect(row.last_seen_at).toBe('2024-01-02T00:00:00.000Z')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns session_not_found when explicit session_id is stale, without mutation', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    // A DB row exists for the stale id, but the live server list no longer has it.
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_notfound',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_notfound' },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'session_not_found',
      detail: { base_url: OC_BASE_URL, session_id: 'ses_notfound' },
    })
    const row = db.prepare(
      `SELECT last_seen_at FROM agents WHERE agent_id='O'`
    ).get() as { last_seen_at: string }
    expect(row.last_seen_at).toBe('2024-01-02T00:00:00.000Z')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns missing_auth_token when auth_token_ref points at an unset env var', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_oc1',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_oc1', auth_token_ref: 'MISSING_TOKEN' },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'MISSING_TOKEN' },
    })
    const row = db.prepare(
      `SELECT last_seen_at FROM agents WHERE agent_id='O'`
    ).get() as { last_seen_at: string }
    expect(row.last_seen_at).toBe('2024-01-02T00:00:00.000Z')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('preserves the existing auth_token_ref when reconnect omits it', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_keep',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: '2024-01-02T00:00:00.000Z',
      auth_token_ref: 'OLD_TOKEN',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_keep' },
    })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    const row = db.prepare(
      `SELECT delivery_payload FROM agents WHERE agent_id='O'`
    ).get() as { delivery_payload: string }
    expect(JSON.parse(row.delivery_payload).auth_token_ref).toBe('OLD_TOKEN')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('overwrites the auth_token_ref when reconnect supplies a new one', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'O',
      session_id: 'ses_keep',
      base_url: OC_BASE_URL,
      name: 'xats-opencode',
      last_seen_at: '2024-01-02T00:00:00.000Z',
      auth_token_ref: 'OLD_TOKEN',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_keep', auth_token_ref: 'NEW_TOKEN' },
    })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    const row = db.prepare(
      `SELECT delivery_payload FROM agents WHERE agent_id='O'`
    ).get() as { delivery_payload: string }
    expect(JSON.parse(row.delivery_payload).auth_token_ref).toBe('NEW_TOKEN')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns auth_ambiguous when candidates carry multiple distinct stored refs', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'A', session_id: 'ses_multi', base_url: OC_BASE_URL,
      name: 'oc-a', last_seen_at: '2024-01-01T00:00:00.000Z', auth_token_ref: 'REF_A',
    })
    seedOpencodeAgent(db, {
      agent_id: 'B', session_id: 'ses_multi', base_url: OC_BASE_URL,
      name: 'oc-b', last_seen_at: '2024-06-01T00:00:00.000Z', auth_token_ref: 'REF_B',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_multi' },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'auth_ambiguous',
      detail: { refs: ['REF_A', 'REF_B'] },
    })
    // Zero write: both rows unchanged.
    const rows = db.prepare(
      `SELECT agent_id, last_seen_at FROM agents ORDER BY agent_id`
    ).all() as Array<{ agent_id: string; last_seen_at: string }>
    expect(rows).toEqual([
      { agent_id: 'A', last_seen_at: '2024-01-01T00:00:00.000Z' },
      { agent_id: 'B', last_seen_at: '2024-06-01T00:00:00.000Z' },
    ])

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('returns auth_ambiguous when candidates mix ref and no-ref rows', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'A', session_id: 'ses_mix', base_url: OC_BASE_URL,
      name: 'oc-a', last_seen_at: '2024-01-01T00:00:00.000Z', auth_token_ref: 'REF_A',
    })
    seedOpencodeAgent(db, {
      agent_id: 'B', session_id: 'ses_mix', base_url: OC_BASE_URL,
      name: 'oc-b', last_seen_at: '2024-06-01T00:00:00.000Z',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_mix' },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      error: 'auth_ambiguous',
      detail: { refs: ['REF_A'] },
    })
    const rows = db.prepare(
      `SELECT agent_id, last_seen_at FROM agents ORDER BY agent_id`
    ).all() as Array<{ agent_id: string; last_seen_at: string }>
    expect(rows).toEqual([
      { agent_id: 'A', last_seen_at: '2024-01-01T00:00:00.000Z' },
      { agent_id: 'B', last_seen_at: '2024-06-01T00:00:00.000Z' },
    ])

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('uses a single shared ref across multiple candidates to reach ambiguous (not unreachable)', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedOpencodeAgent(db, {
      agent_id: 'A', session_id: 'ses_shared', base_url: OC_BASE_URL,
      name: 'oc-a', last_seen_at: '2024-01-01T00:00:00.000Z', auth_token_ref: 'SHARED_REF',
    })
    seedOpencodeAgent(db, {
      agent_id: 'B', session_id: 'ses_shared', base_url: OC_BASE_URL,
      name: 'oc-b', last_seen_at: '2024-06-01T00:00:00.000Z', auth_token_ref: 'SHARED_REF',
    })

    const resp = await client.callTool({
      name: 'reconnect',
      arguments: { base_url: OC_BASE_URL, session_id: 'ses_shared' },
    })
    const obj = await parseTool(resp)

    // Shared ref lets the server pre-validation proceed; the precise resolver
    // then surfaces the multiple identity rows as ambiguous (no mutation).
    expect(obj.ambiguous).toBe(true)
    const candidates = obj.candidates as Array<{ name: string }>
    expect(candidates.map(c => c.name)).toEqual(['oc-b', 'oc-a'])

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })
})
