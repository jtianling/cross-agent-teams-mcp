import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeKimiSessionState,
  isWireLogRecent,
  createKimiSessionPrecheck,
  canonicalKimiBaseUrl,
  parseStrictEnvelopeData,
  TUI_RECENT_WRITE_WINDOW_MS,
} from '../src/mcp/kimi-session-state.js'

const SESSION_ID = 'session_abc'
const BASE_URL = 'http://127.0.0.1:58627'
const HEADERS = { Authorization: 'Bearer t' }

const tmpDirs: string[] = []
afterEach(() => {
  tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true }))
  tmpDirs.length = 0
})

function makeFetch(args: {
  status?: number
  body?: string
  reject?: () => Error
}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchMock = (async (url: string) => {
    if (args.reject) throw args.reject()
    calls.push(url)
    const body = args.body ?? ''
    return new Response(body.length > 0 ? body : null, { status: args.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetch: fetchMock, calls }
}

function envelope(data: unknown): string {
  return JSON.stringify({ code: 0, msg: 'ok', data })
}

function makeSessionsRoot(args: {
  sessionId?: string
  ageMs?: number
  create?: boolean
}): string {
  const root = mkdtempSync(join(tmpdir(), 'atm-kimi-sessions-'))
  tmpDirs.push(root)
  if (args.create === false) return root
  const dir = join(root, 'wd_deadbeef', args.sessionId ?? SESSION_ID, 'agents', 'main')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'wire.jsonl')
  writeFileSync(file, '{}\n')
  if (args.ageMs !== undefined) {
    const when = (Date.now() - args.ageMs) / 1000
    utimesSync(file, when, when)
  }
  return root
}

describe('probeKimiSessionState', () => {
  it('returns main_turn_active and pending_interaction from a 2xx envelope', async () => {
    const { fetch: fetchMock, calls } = makeFetch({
      status: 200,
      body: envelope({ busy: true, main_turn_active: true, pending_interaction: 'none' }),
    })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({ main_turn_active: true, pending_interaction: 'none' })
    expect(calls).toEqual([`${BASE_URL}/api/v1/sessions/${SESSION_ID}`])
  })

  it('fails open (no signal) when the fetch rejects', async () => {
    const { fetch: fetchMock } = makeFetch({ reject: () => new Error('ECONNREFUSED') })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) on a non-2xx response', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: envelope({ main_turn_active: true }),
    })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) on a 200 error envelope with a non-zero code', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 200,
      body: JSON.stringify({
        code: 40401,
        msg: 'session does not exist',
        data: { main_turn_active: true },
      }),
    })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) when the body omits the fields', async () => {
    const { fetch: fetchMock } = makeFetch({ status: 200, body: envelope({ busy: true }) })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) when the body is empty or not JSON', async () => {
    for (const body of ['', 'not json']) {
      const { fetch: fetchMock } = makeFetch({ status: 200, body })
      const signal = await probeKimiSessionState({
        base_url: BASE_URL,
        session_id: SESSION_ID,
        headers: HEADERS,
        fetch: fetchMock,
      })
      expect(signal).toEqual({})
    }
  })

  it('sends the bearer headers with the probe GET', async () => {
    const seen: Array<Record<string, string>> = []
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>)
      return new Response(envelope({ main_turn_active: false }), { status: 200 })
    }) as unknown as typeof fetch
    await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(seen[0]['Authorization']).toBe('Bearer t')
  })
})

describe('isWireLogRecent', () => {
  it('is recent when the wire log was modified inside the window', () => {
    const sessionsRoot = makeSessionsRoot({ ageMs: 2_000 })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(true)
  })

  it('is not recent when the wire log was modified outside the window', () => {
    const sessionsRoot = makeSessionsRoot({ ageMs: 10 * 60_000 })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(false)
  })

  it('fails open (not recent) when the wire log is missing', () => {
    const sessionsRoot = makeSessionsRoot({ create: false })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(false)
  })

  it('fails open (not recent) when the sessions root does not exist', () => {
    expect(
      isWireLogRecent({ session_id: SESSION_ID, sessionsRoot: '/nonexistent/xats/kimi' })
    ).toBe(false)
  })

  it('ignores wire logs belonging to a different session', () => {
    const sessionsRoot = makeSessionsRoot({ sessionId: 'session_other', ageMs: 1_000 })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(false)
  })

  it('uses a 10 second window by default', () => {
    expect(TUI_RECENT_WRITE_WINDOW_MS).toBe(10_000)
  })
})

describe('createKimiSessionPrecheck', () => {
  function precheckWith(args: {
    body?: string
    status?: number
    reject?: () => Error
    sessionsRoot: string
  }) {
    const { fetch: fetchMock, calls } = makeFetch(args)
    const precheck = createKimiSessionPrecheck({ sessionsRoot: args.sessionsRoot })
    return {
      calls,
      run: () =>
        precheck({
          base_url: BASE_URL,
          session_id: SESSION_ID,
          headers: HEADERS,
          fetch: fetchMock,
        }),
    }
  }

  it('defers on main_turn_active', async () => {
    const { run } = precheckWith({
      body: envelope({ main_turn_active: true, pending_interaction: 'none' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({ decision: 'defer', reason: 'main_turn_active' })
  })

  // kimi treats `archived` as list visibility, not admission control: a prompt
  // posted to an abandoned session is accepted and queued unseen. This gate is
  // the only thing that turns that silent misroute into a reported skip.
  it('refuses an archived session ahead of every other signal', async () => {
    const { run } = precheckWith({
      body: envelope({
        archived: true,
        main_turn_active: true,
        pending_interaction: 'approval',
      }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({ decision: 'archived' })
  })

  it('proceeds when archived is explicitly false', async () => {
    const { run } = precheckWith({
      body: envelope({
        archived: false,
        main_turn_active: false,
        pending_interaction: 'none',
      }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({ decision: 'proceed' })
  })

  // Fail-open is the whole gate's contract: an unreadable probe must not become
  // a delivery outage.
  it('proceeds when the probe cannot answer whether the session is archived', async () => {
    const { run } = precheckWith({
      status: 500,
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({ decision: 'proceed' })
  })

  it('reports pending_interaction ahead of main_turn_active', async () => {
    const { run } = precheckWith({
      body: envelope({ main_turn_active: true, pending_interaction: 'approval' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({
      decision: 'pending_interaction',
      pending_interaction: 'approval',
    })
  })

  it('proceeds when only busy is true', async () => {
    const { run } = precheckWith({
      body: envelope({ busy: true, main_turn_active: false, pending_interaction: 'none' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({ decision: 'proceed' })
  })

  it('defers on a recent wire-log write', async () => {
    const { run } = precheckWith({
      body: envelope({ main_turn_active: false, pending_interaction: 'none' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 2_000 }),
    })
    expect(await run()).toEqual({ decision: 'defer', reason: 'tui_recent_write' })
  })

  it('proceeds when both probe inputs are unavailable', async () => {
    const { run } = precheckWith({
      reject: () => new Error('ECONNREFUSED'),
      sessionsRoot: makeSessionsRoot({ create: false }),
    })
    expect(await run()).toEqual({ decision: 'proceed' })
  })
})

describe('canonicalKimiBaseUrl', () => {
  it('lowercases scheme/host and drops the default port and trailing slashes', () => {
    expect(canonicalKimiBaseUrl('HTTP://LOCALHOST:80/')).toBe('http://localhost')
    expect(canonicalKimiBaseUrl('http://localhost')).toBe('http://localhost')
    expect(canonicalKimiBaseUrl('HTTPS://Example.COM:443/')).toBe('https://example.com')
  })

  it('keeps non-default ports and preserves query strings, stripping hashes', () => {
    expect(canonicalKimiBaseUrl('HTTP://127.0.0.1:58627/')).toBe('http://127.0.0.1:58627')
    expect(canonicalKimiBaseUrl('http://h:1234/x/?a=1#frag')).toBe('http://h:1234/x/?a=1')
    // Slash-trimming must never eat query content (queries are schema-rejected
    // on the public paths, but the canonicalizer stays safe for direct calls).
    expect(canonicalKimiBaseUrl('http://h/x?a=1/')).toBe('http://h/x?a=1/')
  })

  it('strips a dangling "?" (empty search kept in href by WHATWG URL)', () => {
    expect(canonicalKimiBaseUrl('http://127.0.0.1:58627/?')).toBe('http://127.0.0.1:58627')
    expect(canonicalKimiBaseUrl('http://127.0.0.1:58627/?#')).toBe('http://127.0.0.1:58627')
  })

  it('falls back to trailing-slash trimming on unparseable input', () => {
    expect(canonicalKimiBaseUrl('not a url//')).toBe('not a url')
  })
})

describe('parseStrictEnvelopeData', () => {
  it('accepts only a code-0 envelope with object data', () => {
    expect(
      parseStrictEnvelopeData(JSON.stringify({ code: 0, msg: 'ok', data: { id: 'session_x' } }))
    ).toEqual({ id: 'session_x' })
  })

  it('rejects root fallbacks and malformed envelopes', () => {
    expect(parseStrictEnvelopeData(JSON.stringify({ id: 'session_x' }))).toBeUndefined()
    expect(parseStrictEnvelopeData(JSON.stringify({ code: 0, data: null }))).toBeUndefined()
    expect(parseStrictEnvelopeData(JSON.stringify({ code: 0, data: [] }))).toBeUndefined()
    expect(parseStrictEnvelopeData(JSON.stringify({ code: 1, data: { id: 'session_x' } }))).toBeUndefined()
    expect(parseStrictEnvelopeData(JSON.stringify({ data: { id: 'session_x' } }))).toBeUndefined()
    expect(parseStrictEnvelopeData('')).toBeUndefined()
    expect(parseStrictEnvelopeData('[]')).toBeUndefined()
    expect(parseStrictEnvelopeData('not json')).toBeUndefined()
  })
})
