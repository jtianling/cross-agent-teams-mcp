import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dispatchKimiServerPoke,
  dispatchKimiServerPokeGated,
  type KimiServerDispatchResult,
} from '../src/mcp/kimi-server-dispatch.js'
import { createKimiSessionPrecheck } from '../src/mcp/kimi-session-state.js'
import { dispatchPoke } from '../src/mcp/transport-dispatch.js'

const SESSION_ID = 'session_abc'
const BASE_URL = 'http://127.0.0.1:58627'
const DELIVERY = {
  kind: 'kimi-server' as const,
  session_id: SESSION_ID,
  base_url: BASE_URL,
}

const tmpDirs: string[] = []
afterEach(() => {
  tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true }))
  tmpDirs.length = 0
})

function makeTokenFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atm-kimi-token-'))
  tmpDirs.push(dir)
  const path = join(dir, 'server.token')
  writeFileSync(path, content)
  return path
}

function missingTokenFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atm-kimi-token-'))
  tmpDirs.push(dir)
  return join(dir, 'server.token')
}

type FetchCall = {
  url: string
  init: {
    method: string
    headers: Record<string, string>
    body: string
  }
}

function makeFetch(args: {
  status?: number
  body?: string
  reject?: (url: string) => Error
}): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const status = args.status ?? 200
  const fetchMock = (async (url: string, init?: RequestInit) => {
    if (args.reject) throw args.reject(url)
    calls.push({
      url,
      init: {
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: (init?.body ?? '') as string,
      },
    })
    const body = args.body ?? ''
    // undici rejects non-empty body for 204/205/304 — pass null in that case
    const initArgs: ResponseInit = { status }
    return new Response(body.length > 0 ? body : null, initArgs)
  }) as unknown as typeof fetch
  return { fetch: fetchMock, calls }
}

describe('dispatchKimiServerPoke', () => {
  it('returns ok with transport_used kimi-server on HTTP 200 and posts the prompt body', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello from daemon' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: SESSION_ID,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sessions/${SESSION_ID}/prompts`)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      content: [{ type: 'text', text: 'hello from daemon' }],
    })
  })

  it('attaches Authorization: Bearer header when auth_token_ref resolves from env', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    await dispatchKimiServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'KIMI_SERVER_TOKEN' },
        content: 'hello',
      },
      {
        fetch: fetchMock,
        env: { KIMI_SERVER_TOKEN: 'secret-token' },
      }
    )
    expect(calls[0].init.headers['Authorization']).toBe('Bearer secret-token')
  })

  it('reads the bearer token from the token file when auth_token_ref is absent', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('file-token\n')
    await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(calls[0].init.headers['Authorization']).toBe('Bearer file-token')
  })

  it('returns missing_auth_token (no network call) when auth_token_ref is unset in env', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const result = await dispatchKimiServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'KIMI_SERVER_TOKEN' },
        content: 'hello',
      },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'KIMI_SERVER_TOKEN' },
    })
    expect(calls).toHaveLength(0)
  })

  it('returns missing_auth_token (no network call) when auth_token_ref resolves to an empty value', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const result = await dispatchKimiServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'KIMI_SERVER_TOKEN' },
        content: 'hello',
      },
      { fetch: fetchMock, env: { KIMI_SERVER_TOKEN: '   ' } }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'KIMI_SERVER_TOKEN' },
    })
    expect(calls).toHaveLength(0)
  })

  it('returns missing_auth_token (no network call) when the token file is absent', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = missingTokenFilePath()
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { token_file: tokenFilePath },
    })
    expect(calls).toHaveLength(0)
  })

  it('returns missing_auth_token (no network call) when the token file is empty', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('  \n')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { token_file: tokenFilePath },
    })
    expect(calls).toHaveLength(0)
  })

  it('maps fetch rejection to kimi_connect_failed', async () => {
    const { fetch: fetchMock, calls } = makeFetch({
      reject: () => new Error('ECONNREFUSED'),
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_connect_failed',
      detail: 'ECONNREFUSED',
      transport_used: 'kimi-server',
    })
    expect(calls).toHaveLength(0)
  })

  it('maps 404 response to kimi_inject_failed with status and body', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 404,
      body: '{"error":"session not found"}',
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: { ...DELIVERY, session_id: 'session_ghost' }, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_inject_failed',
      detail: {
        status: 404,
        body: '{"error":"session not found"}',
      },
      transport_used: 'kimi-server',
    })
  })

  it('maps 200 with a non-zero code error envelope (real kimi server behavior for unknown session) to kimi_inject_failed', async () => {
    const body = JSON.stringify({
      code: 40401,
      msg: 'session session_ghost does not exist',
      data: null,
    })
    const { fetch: fetchMock } = makeFetch({ status: 200, body })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: { ...DELIVERY, session_id: 'session_ghost' }, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_inject_failed',
      detail: { status: 200, body },
      transport_used: 'kimi-server',
    })
  })

  it('returns ok for a 200 success envelope with code 0', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 200,
      body: '{"code":0,"msg":"ok","data":{"prompt_id":"p1"}}',
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: SESSION_ID,
    })
  })

  it('maps 500 response to kimi_inject_failed', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: 'internal error',
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_inject_failed',
      detail: { status: 500, body: 'internal error' },
      transport_used: 'kimi-server',
    })
  })

  it('truncates body to 4KB in inject_failed detail', async () => {
    const bigBody = 'x'.repeat(10_000)
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: bigBody,
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    ) as Extract<KimiServerDispatchResult, { error: unknown }> & { detail: { body: string } }
    expect(result.error).toBe('kimi_inject_failed')
    const body = result.detail.body as string
    expect(body.length).toBe(4096)
    expect(bigBody.startsWith(body)).toBe(true)
  })

  it('accepts any 2xx status (not just 200)', async () => {
    const { fetch: fetchMock } = makeFetch({ status: 202, body: '{"accepted":true}' })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: SESSION_ID,
    })
  })

  it('strips trailing slashes from base_url before building the URL', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('file-token')
    await dispatchKimiServerPoke(
      { delivery: { ...DELIVERY, base_url: 'http://127.0.0.1:58627//' }, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sessions/${SESSION_ID}/prompts`)
  })
})

// ---- precondition gate -----------------------------------------------------

type GateCall = { method: string; url: string }

function makeSessionsRoot(args: { ageMs?: number; sessionId?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'atm-kimi-sessions-'))
  tmpDirs.push(root)
  if (args.ageMs === undefined) return root
  const dir = join(root, 'wd_deadbeef', args.sessionId ?? SESSION_ID, 'agents', 'main')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'wire.jsonl')
  writeFileSync(file, '{}\n')
  const when = (Date.now() - args.ageMs) / 1000
  utimesSync(file, when, when)
  return root
}

function makeGateFetch(args: {
  session?: { status?: number; body?: string }
  sessionReject?: boolean
  prompt?: { status?: number; body?: string }
}): { fetch: typeof fetch; calls: GateCall[] } {
  const calls: GateCall[] = []
  const fetchMock = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      if (args.sessionReject) throw new Error('ECONNREFUSED')
      calls.push({ method, url })
      const body = args.session?.body ?? ''
      return new Response(body.length > 0 ? body : null, {
        status: args.session?.status ?? 200,
      })
    }
    calls.push({ method, url })
    const body = args.prompt?.body ?? ''
    return new Response(body.length > 0 ? body : null, {
      status: args.prompt?.status ?? 200,
    })
  }) as unknown as typeof fetch
  return { fetch: fetchMock, calls }
}

function sessionEnvelope(data: unknown): string {
  return JSON.stringify({ code: 0, msg: 'ok', data })
}

async function runGated(args: {
  session?: { status?: number; body?: string }
  sessionReject?: boolean
  prompt?: { status?: number; body?: string }
  sessionsRoot: string
}): Promise<{ result: KimiServerDispatchResult; calls: GateCall[] }> {
  const { fetch: fetchMock, calls } = makeGateFetch(args)
  const result = await dispatchKimiServerPoke(
    { delivery: DELIVERY, content: 'hello' },
    {
      fetch: fetchMock,
      env: {},
      tokenFilePath: makeTokenFile('file-token'),
      precheck: createKimiSessionPrecheck({ sessionsRoot: args.sessionsRoot }),
    }
  )
  return { result, calls }
}

function postCalls(calls: GateCall[]): GateCall[] {
  return calls.filter(c => c.method === 'POST')
}

describe('dispatchKimiServerPoke precondition gate', () => {
  it('defers with reason main_turn_active and issues NO POST', async () => {
    const { result, calls } = await runGated({
      session: { body: sessionEnvelope({ main_turn_active: true, pending_interaction: 'none' }) },
      sessionsRoot: makeSessionsRoot(),
    })
    expect(result).toEqual({
      error: 'kimi_session_busy',
      detail: { reason: 'main_turn_active' },
      transport_used: 'kimi-server',
    })
    expect(postCalls(calls)).toHaveLength(0)
  })

  it('injects when busy is true but the main turn is idle', async () => {
    const { result, calls } = await runGated({
      session: {
        body: sessionEnvelope({
          busy: true,
          main_turn_active: false,
          pending_interaction: 'none',
        }),
      },
      sessionsRoot: makeSessionsRoot(),
    })
    expect(result).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: SESSION_ID,
    })
    expect(postCalls(calls)).toHaveLength(1)
  })

  it('returns kimi_pending_interaction and issues NO POST', async () => {
    const { result, calls } = await runGated({
      session: {
        body: sessionEnvelope({ main_turn_active: true, pending_interaction: 'approval' }),
      },
      sessionsRoot: makeSessionsRoot(),
    })
    expect(result).toEqual({
      error: 'kimi_pending_interaction',
      detail: { pending_interaction: 'approval' },
      transport_used: 'kimi-server',
    })
    expect(postCalls(calls)).toHaveLength(0)
  })

  it('returns kimi_session_archived and issues NO POST', async () => {
    const { result, calls } = await runGated({
      session: {
        body: sessionEnvelope({
          archived: true,
          main_turn_active: false,
          pending_interaction: 'none',
        }),
      },
      sessionsRoot: makeSessionsRoot(),
    })
    expect(result).toEqual({
      error: 'kimi_session_archived',
      transport_used: 'kimi-server',
    })
    expect(postCalls(calls)).toHaveLength(0)
  })

  it('defers with reason tui_recent_write on a recent wire-log write', async () => {
    const { result, calls } = await runGated({
      session: {
        body: sessionEnvelope({ main_turn_active: false, pending_interaction: 'none' }),
      },
      sessionsRoot: makeSessionsRoot({ ageMs: 2_000 }),
    })
    expect(result).toEqual({
      error: 'kimi_session_busy',
      detail: { reason: 'tui_recent_write' },
      transport_used: 'kimi-server',
    })
    expect(postCalls(calls)).toHaveLength(0)
  })

  it('injects when the wire log is stale', async () => {
    const { result, calls } = await runGated({
      session: {
        body: sessionEnvelope({ main_turn_active: false, pending_interaction: 'none' }),
      },
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(postCalls(calls)).toHaveLength(1)
  })

  it('fails open and injects when the probe GET rejects and no wire log exists', async () => {
    const { result, calls } = await runGated({
      sessionReject: true,
      sessionsRoot: makeSessionsRoot(),
    })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(postCalls(calls)).toHaveLength(1)
  })

  it('fails open and injects when the probe GET returns a non-2xx', async () => {
    const { result, calls } = await runGated({
      session: { status: 500, body: 'boom' },
      sessionsRoot: makeSessionsRoot(),
    })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(postCalls(calls)).toHaveLength(1)
  })

  it('fails open and injects when the probe GET returns an error envelope', async () => {
    const { result, calls } = await runGated({
      session: {
        body: JSON.stringify({ code: 40401, msg: 'session does not exist', data: null }),
      },
      sessionsRoot: makeSessionsRoot(),
    })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(postCalls(calls)).toHaveLength(1)
  })

  it('probes the session URL before posting the prompt', async () => {
    const { calls } = await runGated({
      session: {
        body: sessionEnvelope({ main_turn_active: false, pending_interaction: 'none' }),
      },
      sessionsRoot: makeSessionsRoot(),
    })
    expect(calls.map(c => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE_URL}/api/v1/sessions/${SESSION_ID}`,
      `POST ${BASE_URL}/api/v1/sessions/${SESSION_ID}/prompts`,
    ])
  })

  it('dispatchKimiServerPokeGated wires the precheck in by default', async () => {
    const { fetch: fetchMock, calls } = makeGateFetch({
      session: { body: sessionEnvelope({ main_turn_active: true, pending_interaction: 'none' }) },
    })
    const result = await dispatchKimiServerPokeGated(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath: makeTokenFile('file-token') }
    )
    expect(result).toEqual({
      error: 'kimi_session_busy',
      detail: { reason: 'main_turn_active' },
      transport_used: 'kimi-server',
    })
    expect(postCalls(calls)).toHaveLength(0)
  })
})

describe('dispatchKimiServerPoke SESSION_BUSY rejection', () => {
  it('maps a SESSION_BUSY error envelope to kimi_session_busy, not kimi_inject_failed', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 200,
      body: JSON.stringify({ code: 42901, msg: 'SESSION_BUSY: a turn is running', data: null }),
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_session_busy',
      detail: { reason: 'session_busy_response' },
      transport_used: 'kimi-server',
    })
  })

  it('maps a SESSION_BUSY rejection at a non-2xx status to kimi_session_busy', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 409,
      body: JSON.stringify({ error: 'SESSION_BUSY' }),
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_session_busy',
      detail: { reason: 'session_busy_response' },
      transport_used: 'kimi-server',
    })
  })
})

describe('dispatchPoke kimi-server routing', () => {
  it('routes kimi-server delivery to the kimi dispatcher', async () => {
    const tmuxCalls: unknown[] = []
    const kimiCalls: Array<{ session_id: string; base_url: string; content: string }> = []
    const res = await dispatchPoke(
      {
        tmuxPoke: async args => {
          tmuxCalls.push(args)
          return { ok: true, pane_tail_before: '', pane_tail_after: '' }
        },
        kimiServerDispatch: async ({ delivery, content }) => {
          kimiCalls.push({
            session_id: delivery.session_id,
            base_url: delivery.base_url,
            content,
          })
          return {
            ok: true,
            transport_used: 'kimi-server',
            session_id: delivery.session_id,
          }
        },
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'kimi-code',
        delivery: {
          kind: 'kimi-server',
          session_id: 'session_abc',
          base_url: 'http://127.0.0.1:58627',
        },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: 'session_abc',
    })
    expect(kimiCalls).toEqual([
      {
        session_id: 'session_abc',
        base_url: 'http://127.0.0.1:58627',
        content: 'hi',
      },
    ])
    expect(tmuxCalls).toHaveLength(0)
  })

  it('does NOT fall back to tmux when kimi-server dispatcher fails (even with tmux_pane_id set)', async () => {
    const tmuxCalls: unknown[] = []
    const res = await dispatchPoke(
      {
        tmuxPoke: async args => {
          tmuxCalls.push(args)
          return { ok: true, pane_tail_before: '', pane_tail_after: '' }
        },
        kimiServerDispatch: async () => ({
          error: 'kimi_connect_failed',
          detail: 'ECONNREFUSED',
          transport_used: 'kimi-server',
        }),
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'kimi-code',
        delivery: {
          kind: 'kimi-server',
          session_id: 'session_abc',
          base_url: 'http://127.0.0.1:58627',
        },
        tmux_pane_id: '%42',
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'kimi_connect_failed',
      detail: 'ECONNREFUSED',
      transport_used: 'kimi-server',
    })
    expect(tmuxCalls).toHaveLength(0)
  })

  it('routes kimi-server delivery to the kimi dispatcher even when agent_type is null', async () => {
    const kimiCalls: unknown[] = []
    const res = await dispatchPoke(
      {
        tmuxPoke: async () => ({ ok: true, pane_tail_before: '', pane_tail_after: '' }),
        kimiServerDispatch: async ({ delivery }) => {
          kimiCalls.push(delivery)
          return {
            ok: true,
            transport_used: 'kimi-server',
            session_id: delivery.session_id,
          }
        },
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: null,
        delivery: {
          kind: 'kimi-server',
          session_id: 'session_abc',
          base_url: 'http://127.0.0.1:58627',
        },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(kimiCalls).toHaveLength(1)
  })
})

describe('gate deferral logging', () => {
  const deferralCases = [
    {
      name: 'main_turn_active',
      precheck: async () => ({ decision: 'defer' as const, reason: 'main_turn_active' as const }),
      expected: { outcome: 'kimi_session_busy', reason: 'main_turn_active' }
    },
    {
      name: 'tui_recent_write',
      precheck: async () => ({ decision: 'defer' as const, reason: 'tui_recent_write' as const }),
      expected: { outcome: 'kimi_session_busy', reason: 'tui_recent_write' }
    },
    {
      name: 'pending_interaction',
      precheck: async () => ({ decision: 'pending_interaction' as const, pending_interaction: 'approval' }),
      expected: { outcome: 'kimi_pending_interaction', pending_interaction: 'approval' }
    }
  ]

  for (const c of deferralCases) {
    it(`records the ${c.name} sub-reason so it is diagnosable without widening the public result`, async () => {
      const records: Record<string, unknown>[] = []
      const res = await dispatchKimiServerPoke(
        // Bearer via an explicit ref: with neither ref nor tokenFilePath the
        // auth step falls back to ~/.kimi-code/server.token and returns
        // missing_auth_token before the gate ever runs.
        { delivery: { ...DELIVERY, auth_token_ref: 'KIMI_SERVER_TOKEN' }, content: 'hi' },
        {
          env: { CROSS_AGENT_TEAMS_MCP_TOKEN: 'tok', KIMI_SERVER_TOKEN: 'secret-token' },
          fetch: (async () => { throw new Error('must not be called') }) as unknown as typeof fetch,
          precheck: c.precheck,
          logGate: (r) => { records.push(r) }
        }
      )
      expect('error' in res).toBe(true)
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        event: 'kimi_poke_deferred',
        session_id: DELIVERY.session_id,
        ...c.expected
      })
    })
  }

  it('logs nothing when the poke is injected', async () => {
    const records: Record<string, unknown>[] = []
    await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hi' },
      {
        env: { CROSS_AGENT_TEAMS_MCP_TOKEN: 'tok' },
        fetch: (async () => new Response('{"code":0}', { status: 200 })) as unknown as typeof fetch,
        precheck: async () => ({ decision: 'proceed' as const }),
        logGate: (r) => { records.push(r) }
      }
    )
    expect(records).toEqual([])
  })
})

describe('near-window proceed observability (kimi_poke_proceeded)', () => {
  async function runObserved(args: {
    ageMs?: number
    env?: NodeJS.ProcessEnv
  }): Promise<{
    result: KimiServerDispatchResult
    records: Record<string, unknown>[]
  }> {
    const sessionsRoot = makeSessionsRoot(
      args.ageMs === undefined ? {} : { ageMs: args.ageMs }
    )
    const { fetch: fetchMock } = makeGateFetch({
      session: {
        body: sessionEnvelope({
          main_turn_active: false,
          pending_interaction: 'none',
        }),
      },
    })
    const records: Record<string, unknown>[] = []
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      {
        fetch: fetchMock,
        env: args.env ?? {},
        tokenFilePath: makeTokenFile('file-token'),
        precheck: createKimiSessionPrecheck({
          sessionsRoot,
          env: args.env ?? {},
        }),
        logGate: (r) => { records.push(r) },
      }
    )
    return { result, records }
  }

  it('proceeds at wire age 14s and emits one kimi_poke_proceeded with wire_age_ms', async () => {
    const { result, records } = await runObserved({ ageMs: 14_000 })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'kimi_poke_proceeded',
      session_id: SESSION_ID,
    })
    const age = records[0].wire_age_ms as number
    expect(age).toBeGreaterThanOrEqual(13_000)
    expect(age).toBeLessThan(20_000)
  })

  it('emits no record when the session has no wire log', async () => {
    const { result, records } = await runObserved({})
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(records).toEqual([])
  })

  it('emits no record when the wire age is at or above the ceiling', async () => {
    const { result, records } = await runObserved({ ageMs: 30 * 60_000 })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(records).toEqual([])
  })

  it('honors the KIMI_WIRE_AGE_OBSERVE_MS override without changing the decision', async () => {
    const { result, records } = await runObserved({
      ageMs: 60_000,
      env: { KIMI_WIRE_AGE_OBSERVE_MS: '30000' },
    })
    // 60s is over the lowered 30s ceiling: still proceeds, logs nothing.
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(records).toEqual([])
  })

  it('a 60s wire age (over the gate window, under the ceiling) still proceeds and is recorded', async () => {
    const { result, records } = await runObserved({ ageMs: 60_000 })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ event: 'kimi_poke_proceeded' })
  })
})

describe('gate log sink failure isolation', () => {
  async function runWithThrowingSink(args: {
    ageMs?: number
    session: { body: string }
  }): Promise<{ result: KimiServerDispatchResult; calls: GateCall[] }> {
    const sessionsRoot = makeSessionsRoot(
      args.ageMs === undefined ? {} : { ageMs: args.ageMs }
    )
    const { fetch: fetchMock, calls } = makeGateFetch({ session: args.session })
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      {
        fetch: fetchMock,
        env: {},
        tokenFilePath: makeTokenFile('file-token'),
        precheck: createKimiSessionPrecheck({ sessionsRoot, env: {} }),
        logGate: () => { throw new Error('sink failed') },
      }
    )
    return { result, calls }
  }

  it('a throwing sink neither blocks the POST nor changes a proceed result', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, calls } = await runWithThrowingSink({
      ageMs: 14_000,
      session: {
        body: sessionEnvelope({
          main_turn_active: false,
          pending_interaction: 'none',
        }),
      },
    })
    expect(result).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(postCalls(calls)).toHaveLength(1)
    expect(
      errSpy.mock.calls.some(args =>
        String(args[0]).includes('kimi gate log sink failed')
      )
    ).toBe(true)
    errSpy.mockRestore()
  })

  it('a throwing sink does not disturb a deferral result either', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, calls } = await runWithThrowingSink({
      session: {
        body: sessionEnvelope({
          main_turn_active: true,
          pending_interaction: 'none',
        }),
      },
    })
    expect(result).toMatchObject({ error: 'kimi_session_busy' })
    expect(postCalls(calls)).toHaveLength(0)
    errSpy.mockRestore()
  })
})
