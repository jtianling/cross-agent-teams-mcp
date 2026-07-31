import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { RegisterCodexSelfService } from '../src/mcp/register-codex-self.js'
import type { WebSocketLike } from '../src/mcp/codex-appserver-rpc.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-register-codex-self-'))

type EventName = 'open' | 'message' | 'error' | 'close'
type JsonRpcMessage = { id?: number; method?: string; params?: unknown }

class MockWebSocket implements WebSocketLike {
  readonly listeners: Record<EventName, Set<(event: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }
  closeCalls = 0

  constructor(private readonly onSend: (message: JsonRpcMessage, ws: MockWebSocket) => void) {}

  addEventListener(type: EventName, listener: (event: unknown) => void): void {
    this.listeners[type].add(listener)
  }

  removeEventListener(type: EventName, listener: (event: unknown) => void): void {
    this.listeners[type].delete(listener)
  }

  send(data: string): void {
    this.onSend(JSON.parse(data) as JsonRpcMessage, this)
  }

  close(): void {
    this.closeCalls += 1
  }

  emit(type: EventName, event: unknown): void {
    for (const listener of this.listeners[type]) {
      listener(event)
    }
  }

  reply(id: number, payload: { result?: unknown; error?: unknown }): void {
    this.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id, ...payload }),
    })
  }
}

function createHarness(args: {
  onCreate?: (ws: MockWebSocket, url: string) => void
  onSend: (message: JsonRpcMessage, ws: MockWebSocket, url: string) => void
}) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = []
  return {
    calls,
    factory: ({ url, headers }: { url: string; headers?: Record<string, string> }) => {
      const ws = new MockWebSocket((message, socket) => {
        args.onSend(message, socket, url)
      })
      calls.push({ url, headers })
      args.onCreate?.(ws, url)
      return ws
    },
  }
}

function replyToCodexProbe(
  message: JsonRpcMessage,
  ws: MockWebSocket,
  resume: 'accept' | 'reject'
): void {
  if (message.method === 'initialize' && message.id) {
    ws.reply(message.id, { result: { ok: true } })
  }
  if (message.method === 'thread/resume' && message.id) {
    if (resume === 'accept') {
      ws.reply(message.id, { result: { ok: true } })
    } else {
      ws.reply(message.id, {
        error: { code: -32600, message: 'no rollout found' },
      })
    }
  }
}

describe('RegisterCodexSelfService', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function setup(
    harness: ReturnType<typeof createHarness>,
    env: NodeJS.ProcessEnv = {}
  ) {
    const dir = tmp()
    cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const registerSvc = new RegisterAgentService(db)
    const svc = new RegisterCodexSelfService(registerSvc, {
      webSocketFactory: harness.factory,
      env,
    })
    return { db, svc }
  }

  it('registers the caller-supplied thread_id without auto-binding a pane', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: { data: ['11111111-1111-4111-8111-111111111111'] },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { db, svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      team: 'default',
      role: 'worker',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toEqual({
      agent_id: expect.any(String),
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
      prior_snapshot: null,
      register_generation: 1,
    })
    const row = db.prepare(
      'SELECT delivery_kind, delivery_payload, tmux_pane_id FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead') as {
      delivery_kind: string
      delivery_payload: string | null
      tmux_pane_id: string | null
    }
    expect(row.delivery_kind).toBe('codex-appserver')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
    })
    expect(row.tmux_pane_id).toBeNull()
  })

  it('still accepts explicit tmux_pane_id for direct service callers', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: { data: ['11111111-1111-4111-8111-111111111111'] },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { db, svc } = setup(harness)

    await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
      tmux_pane_id: '%42',
    })

    const row = db.prepare(
      'SELECT tmux_pane_id FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead') as {
      tmux_pane_id: string | null
    }
    expect(row.tmux_pane_id).toBe('%42')
  })

  it('keeps codex registration successful when no pane binding is requested', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: { data: ['11111111-1111-4111-8111-111111111111'] },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { db, svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toEqual({
      agent_id: expect.any(String),
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
      prior_snapshot: null,
      register_generation: 1,
    })
    const row = db.prepare(
      'SELECT tmux_pane_id FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead') as {
      tmux_pane_id: string | null
    }
    expect(row.tmux_pane_id).toBeNull()
  })

  it('preserves the existing pane on re-register when no new pane is found', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: { data: ['11111111-1111-4111-8111-111111111111'] },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { db, svc } = setup(harness)

    db.prepare(
      `INSERT INTO agents (
         agent_id, device, team, role, name, model, registered_at, last_seen_at,
         last_processed_event_id, tmux_pane_id, delivery_kind, delivery_payload
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'agent-1',
      'local',
      'default',
      'default',
      'lead',
      'codex',
      '2026-04-21T00:00:00.000Z',
      '2026-04-21T00:00:00.000Z',
      0,
      '%42',
      'none',
      null,
    )

    await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    const row = db.prepare(
      'SELECT tmux_pane_id, delivery_kind FROM agents WHERE device=? AND team=? AND name=?'
    ).get('local', 'default', 'lead') as {
      tmux_pane_id: string | null
      delivery_kind: string
    }
    expect(row.tmux_pane_id).toBe('%42')
    expect(row.delivery_kind).toBe('codex-appserver')
  })

  it('returns no_loaded_threads when app-server reports none', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (typeof message.id === 'number') {
          if (message.method === 'thread/loaded/list') {
            ws.reply(message.id, { result: { data: [] } })
          } else {
            ws.reply(message.id, { result: { ok: true } })
          }
        }
      },
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
    })

    expect(result).toEqual({
      error: 'no_loaded_threads',
      detail: { ws_url: 'ws://127.0.0.1:8799' },
    })
  })

  it('returns thread_id_required when resumable threads exist but thread_id is omitted', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: {
              data: [
                '11111111-1111-4111-8111-111111111111',
                '22222222-2222-4222-8222-222222222222',
              ],
            },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
    })

    expect(result).toEqual({
      error: 'thread_id_required',
      detail: {
        ws_url: 'ws://127.0.0.1:8799',
        thread_ids: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
      },
    })
  })

  it('returns thread_id_required for a single resumable thread without mutating agent state', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: { data: ['11111111-1111-4111-8111-111111111111'] },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { db, svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      team: 'default',
    })

    expect(result).toEqual({
      error: 'thread_id_required',
      detail: {
        ws_url: 'ws://127.0.0.1:8799',
        thread_ids: ['11111111-1111-4111-8111-111111111111'],
      },
    })
    const row = db.prepare(
      'SELECT agent_id FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead')
    expect(row).toBeUndefined()
  })

  it('returns missing_auth_token when auth_token_ref is set but env is missing', async () => {
    const harness = createHarness({
      onSend: () => undefined,
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
      auth_token_ref: 'CODEX_REMOTE_TOKEN',
    })

    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'CODEX_REMOTE_TOKEN' },
    })
  })

  it('returns unsupported_client when app-server is unreachable', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('error', { message: 'ECONNREFUSED' })),
      onSend: () => undefined,
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toEqual({
      error: 'unsupported_client',
      detail: {
        expected: 'codex',
        reason: 'codex_appserver_unreachable',
        ws_url: 'ws://127.0.0.1:8799',
        cause: 'ECONNREFUSED',
      },
    })
  })

  it('returns unsupported_client when websocket endpoint does not speak codex protocol', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, {
            error: { code: -32601, message: 'method not found' },
          })
        }
      },
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toEqual({
      error: 'unsupported_client',
      detail: {
        expected: 'codex',
        reason: 'codex_protocol_unavailable',
        ws_url: 'ws://127.0.0.1:8799',
        cause: { code: -32601, message: 'method not found' },
      },
    })
  })

  it('returns codex_resume_failed with thread_id detail for explicit thread bindings', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, {
            error: { code: -32600, message: 'no rollout found' },
          })
        }
      },
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toEqual({
      error: 'codex_resume_failed',
      detail: {
        thread_id: '11111111-1111-4111-8111-111111111111',
        cause: { code: -32600, message: 'no rollout found' },
      },
    })
  })

  it('matches a unique endpoint and de-duplicates configured URLs', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws, url) => {
        replyToCodexProbe(
          message,
          ws,
          url === 'ws://127.0.0.1:8800' ? 'accept' : 'reject'
        )
      },
    })
    const { db, svc } = setup(harness, {
      CROSS_AGENT_TEAMS_CODEX_WS_URLS: JSON.stringify([
        'ws://127.0.0.1:8799',
        'ws://127.0.0.1:8799/',
        'ws://127.0.0.1:8800',
      ]),
    })

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toEqual({
      agent_id: expect.any(String),
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8800',
      prior_snapshot: null,
      register_generation: 1,
    })
    expect(harness.calls.map(call => call.url)).toEqual([
      'ws://127.0.0.1:8799',
      'ws://127.0.0.1:8800',
    ])
    const row = db.prepare(
      'SELECT delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead') as { delivery_payload: string }
    expect(JSON.parse(row.delivery_payload).ws_url).toBe('ws://127.0.0.1:8800')
  })

  it('prefers an explicit URL over both endpoint environment settings', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => replyToCodexProbe(message, ws, 'accept'),
    })
    const { svc } = setup(harness, {
      CROSS_AGENT_TEAMS_CODEX_WS_URL: 'ws://127.0.0.1:8899',
      CROSS_AGENT_TEAMS_CODEX_WS_URLS: '["ws://127.0.0.1:8799"]',
    })

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8811',
    })

    expect(result).toMatchObject({ ws_url: 'ws://127.0.0.1:8811' })
    expect(harness.calls.map(call => call.url)).toEqual([
      'ws://127.0.0.1:8811',
    ])
  })

  it('prefers the legacy single URL over the multi-endpoint setting', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => replyToCodexProbe(message, ws, 'accept'),
    })
    const { svc } = setup(harness, {
      CROSS_AGENT_TEAMS_CODEX_WS_URL: 'ws://127.0.0.1:8899',
      CROSS_AGENT_TEAMS_CODEX_WS_URLS: '["ws://127.0.0.1:8799"]',
    })

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toMatchObject({ ws_url: 'ws://127.0.0.1:8899' })
    expect(harness.calls.map(call => call.url)).toEqual([
      'ws://127.0.0.1:8899',
    ])
  })

  it.each([
    ['invalid JSON', 'not-json'],
    ['a non-WebSocket URL', '["http://127.0.0.1:8799"]'],
  ])('rejects %s in the multi-endpoint setting without mutation', async (
    _name,
    value
  ) => {
    const harness = createHarness({ onSend: () => undefined })
    const { db, svc } = setup(harness, {
      CROSS_AGENT_TEAMS_CODEX_WS_URLS: value,
    })

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toMatchObject({
      error: 'codex_endpoint_config_invalid',
      detail: { env: 'CROSS_AGENT_TEAMS_CODEX_WS_URLS' },
    })
    expect(harness.calls).toEqual([])
    const row = db.prepare(
      'SELECT agent_id FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead')
    expect(row).toBeUndefined()
  })

  it('returns aggregated resume attempts when no endpoint accepts', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => replyToCodexProbe(message, ws, 'reject'),
    })
    const { db, svc } = setup(harness, {
      CROSS_AGENT_TEAMS_CODEX_WS_URLS: JSON.stringify([
        'ws://127.0.0.1:8799',
        'ws://127.0.0.1:8800',
      ]),
    })

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toMatchObject({
      error: 'codex_resume_failed',
      detail: {
        thread_id: '11111111-1111-4111-8111-111111111111',
        attempts: [
          { ws_url: 'ws://127.0.0.1:8799', error: 'codex_resume_failed' },
          { ws_url: 'ws://127.0.0.1:8800', error: 'codex_resume_failed' },
        ],
      },
    })
    const row = db.prepare(
      'SELECT agent_id FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead')
    expect(row).toBeUndefined()
  })

  it('rejects an ambiguous endpoint match without mutating agent state', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => replyToCodexProbe(message, ws, 'accept'),
    })
    const { db, svc } = setup(harness, {
      CROSS_AGENT_TEAMS_CODEX_WS_URLS: JSON.stringify([
        'ws://127.0.0.1:8799',
        'ws://127.0.0.1:8800',
      ]),
    })

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(result).toEqual({
      error: 'codex_endpoint_ambiguous',
      detail: {
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_urls: ['ws://127.0.0.1:8799', 'ws://127.0.0.1:8800'],
      },
    })
    const row = db.prepare(
      'SELECT agent_id FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead')
    expect(row).toBeUndefined()
  })
})
