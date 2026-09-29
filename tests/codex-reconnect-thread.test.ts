import { describe, expect, it } from 'vitest'
import { verifyCodexReconnectThread } from '../src/mcp/codex-reconnect-thread.js'
import type { WebSocketLike } from '../src/mcp/codex-appserver-rpc.js'

const THREAD = '22222222-2222-4222-8222-222222222222'
const delivery = { kind: 'codex-appserver' as const,
  thread_id: THREAD, ws_url: 'ws://127.0.0.1:8799' }
const primary = { id: THREAD, parentThreadId: null, forkedFromId: null,
  source: 'vscode' }

function socket(thread: unknown, rpcError = false) {
  const listeners = new Map<string, Set<(event: unknown) => void>>()
  const methods: string[] = []
  let closed = false
  const emit = (type: string, value: unknown) => {
    for (const listener of listeners.get(type) ?? []) listener(value)
  }
  const ws: WebSocketLike = {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener) },
    close() { closed = true },
    send(data) {
      const request = JSON.parse(data)
      methods.push(request.method)
      if (request.id === undefined) return
      const payload = request.method === 'initialize'
        ? { result: {} }
        : rpcError ? { error: { code: -1, message: 'Not found' } }
          : { result: { thread } }
      queueMicrotask(() => emit('message', { data: JSON.stringify({
        jsonrpc: '2.0', id: request.id, ...payload,
      }) }))
    },
  }
  return { methods, closed: () => closed, factory: () => {
    queueMicrotask(() => emit('open', {}))
    return ws
  } }
}

describe('Codex primary thread verification', () => {
  it('checks metadata without resuming threads or reading turns', async () => {
    const probe = socket(primary)
    expect(await verifyCodexReconnectThread(delivery, THREAD, {
      webSocketFactory: probe.factory,
    })).toEqual({ ok: true })
    expect(probe.methods).toEqual(['initialize', 'initialized', 'thread/read'])
    expect(probe.closed()).toBe(true)
  })

  it.each([
    { ...primary, parentThreadId: THREAD },
    { ...primary, forkedFromId: THREAD },
    { ...primary, source: { subAgent: {} } },
    { ...primary, source: 'exec' },
  ])('rejects non-primary thread metadata: %j', async thread => {
    const probe = socket(thread)
    expect(await verifyCodexReconnectThread(delivery, THREAD, {
      webSocketFactory: probe.factory,
    })).toEqual({ ok: false, error: 'codex_thread_not_primary' })
    expect(probe.closed()).toBe(true)
  })

  it.each([
    {}, { id: THREAD }, { ...primary, id: 'wrong' },
    { ...primary, parentThreadId: undefined },
    { ...primary, forkedFromId: undefined },
  ])('fails closed for missing or malformed ancestry: %j', async thread => {
    const probe = socket(thread)
    expect(await verifyCodexReconnectThread(delivery, THREAD, {
      webSocketFactory: probe.factory,
    })).toEqual({ ok: false, error: 'codex_thread_read_failed' })
  })

  it('returns an error on an unknown thread and closes the socket', async () => {
    const probe = socket(primary, true)
    expect(await verifyCodexReconnectThread(delivery, THREAD, {
      webSocketFactory: probe.factory,
    })).toEqual({ ok: false, error: 'codex_thread_read_failed' })
    expect(probe.closed()).toBe(true)
  })

  it('handles transport failure explicitly', async () => {
    expect(await verifyCodexReconnectThread(delivery, THREAD, {
      webSocketFactory: () => { throw new Error('Offline') },
    })).toEqual({ ok: false, error: 'codex_thread_read_failed' })
  })
})
