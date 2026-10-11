import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import type { DeliverySpec } from '../src/lib/delivery-spec.js'
import { dispatchPoke } from '../src/mcp/transport-dispatch.js'

const WS = 'ws://127.0.0.1:9000'

interface Ctx {
  db: ReturnType<typeof openDb>
  repo: AgentsRepo
}

type Row = Record<string, unknown>

function rowOf(ctx: Ctx, agent_id: string): Row {
  return ctx.db.prepare('SELECT * FROM agents WHERE agent_id=?')
    .get(agent_id) as Row
}

function codex(thread_id: string, ws_url = WS): DeliverySpec {
  return { kind: 'codex-appserver', thread_id, ws_url }
}

function claude(channel_session_id: string): DeliverySpec {
  return { kind: 'claude-channel', channel_session_id }
}

function holders(ctx: Ctx): Array<{ n: number }> {
  return ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM agents
     WHERE role != '__channel_proxy__'
       AND delivery_kind IN ('codex-appserver', 'claude-channel')
     GROUP BY device, delivery_kind,
       COALESCE(json_extract(delivery_payload, '$.thread_id'),
                json_extract(delivery_payload, '$.channel_session_id'))`
  ).all() as Array<{ n: number }>
}

describe('session delivery coordinates are exclusive per device', () => {
  const dirs: string[] = []
  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
  })

  function fresh(): Ctx {
    const dir = mkdtempSync(join(tmpdir(), 'atm-coord-excl-'))
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, repo: new AgentsRepo(db) }
  }

  it('register on a held codex thread releases the old identity', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'codex-66df8c06',
      tmux_pane_id: '%3', identity_key: 'k-old', delivery: codex('T1'),
    })
    const before = rowOf(ctx, old.agent_id)

    const next = ctx.repo.register({
      device: 'jt', team: 't', name: 'vercel-operator',
      delivery: codex('T1', 'ws://127.0.0.1:9100'),
    })

    expect(ctx.repo.findById(next.agent_id)?.delivery).toEqual(
      codex('T1', 'ws://127.0.0.1:9100')
    )
    const after = rowOf(ctx, old.agent_id)
    expect(after.delivery_kind).toBe('none')
    expect(after.delivery_payload).toBeNull()
    expect(after.prev_codex_thread_id).toBe('T1')
    const changed = ['delivery_kind', 'delivery_payload', 'prev_codex_thread_id']
    for (const key of Object.keys(before)) {
      if (changed.includes(key)) continue
      expect([key, after[key]]).toEqual([key, before[key]])
    }
    expect(ctx.repo.findByCodexThreadId('T1', 'jt').map(r => r.agent_id))
      .toEqual([next.agent_id])
  })

  it('setDelivery on a held codex thread releases the old identity', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old', delivery: codex('T1'),
    })
    const next = ctx.repo.register({ device: 'jt', team: 't', name: 'new' })

    ctx.repo.setDelivery(next.agent_id, codex('T1'))

    expect(rowOf(ctx, next.agent_id).delivery_kind).toBe('codex-appserver')
    expect(rowOf(ctx, old.agent_id).delivery_kind).toBe('none')
  })

  it('a wake for the released identity no longer reaches the thread', async () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old', agent_type: 'codex',
      delivery: codex('T1'),
    })
    const next = ctx.repo.register({
      device: 'jt', team: 't', name: 'new', agent_type: 'codex',
      delivery: codex('T1'),
    })
    const woken: string[] = []
    const wake = async (agent_id: string): Promise<unknown> => {
      const row = ctx.repo.findById(agent_id)!
      return dispatchPoke(
        {
          tmuxPoke: async () => { throw new Error('unexpected tmux poke') },
          codexAppserverDispatch: async ({ delivery }) => {
            woken.push(`${agent_id}:${delivery.thread_id}`)
            return { ok: true, transport_used: 'codex-appserver' } as never
          },
        },
        {
          agent_id, device: row.device, runtime_ui_pid: null,
          agent_type: 'codex', delivery: row.delivery,
          tmux_pane_id: row.tmux_pane_id,
        },
        { content: 'wake', meta: {} }
      )
    }

    const oldResult = await wake(old.agent_id)
    await wake(next.agent_id)

    expect(oldResult).not.toMatchObject({ ok: true })
    expect(woken).toEqual([`${next.agent_id}:T1`])
  })

  it('a released codex row stays same-thread seat evidence', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old', runtime_ui_pid: 4242,
      delivery: codex('T1'),
    })
    const next = ctx.repo.register({
      device: 'jt', team: 't', name: 'new', delivery: codex('T1'),
    })

    const evidence = ctx.repo.findRuntimeByThread('T1', 'jt', next.agent_id)
    expect(evidence.map(r => r.agent_id)).toEqual([old.agent_id])
    expect(ctx.repo.findRuntimeByThread('T2', 'jt')).toEqual([])
  })

  it('a row forgets its lost thread once it holds a delivery again', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old', delivery: codex('T1'),
    })
    ctx.repo.register({
      device: 'jt', team: 't', name: 'new', delivery: codex('T1'),
    })
    expect(rowOf(ctx, old.agent_id).prev_codex_thread_id).toBe('T1')

    ctx.repo.register({
      device: 'jt', team: 't', name: 'old', delivery: codex('T2'),
    })
    expect(rowOf(ctx, old.agent_id).prev_codex_thread_id).toBeNull()

    ctx.repo.register({
      device: 'jt', team: 't', name: 'new', delivery: codex('T2'),
    })
    expect(rowOf(ctx, old.agent_id).prev_codex_thread_id).toBe('T2')
    ctx.repo.setDelivery(old.agent_id, claude('C9'))
    expect(rowOf(ctx, old.agent_id).prev_codex_thread_id).toBeNull()
  })

  it('a released claude row records no lost thread', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old', delivery: claude('C1'),
    })
    ctx.repo.register({
      device: 'jt', team: 't', name: 'new', delivery: claude('C1'),
    })
    expect(rowOf(ctx, old.agent_id).delivery_kind).toBe('none')
    expect(rowOf(ctx, old.agent_id).prev_codex_thread_id).toBeNull()
  })

  it('claude takeover also releases the shared runtime_ui_pid', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old',
      runtime_ui_pid: 5847, delivery: claude('C1'),
    })
    const next = ctx.repo.register({
      device: 'jt', team: 't', name: 'new', runtime_ui_pid: 5847,
    })

    ctx.repo.setDelivery(next.agent_id, claude('C1'))

    expect(ctx.repo.findById(next.agent_id)?.delivery).toEqual(claude('C1'))
    expect(rowOf(ctx, next.agent_id).runtime_ui_pid).toBe(5847)
    const released = rowOf(ctx, old.agent_id)
    expect(released.delivery_kind).toBe('none')
    expect(released.runtime_ui_pid).toBeNull()
  })

  it('a later proxy registration cannot hand the session back', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old',
      runtime_ui_pid: 5847, delivery: claude('C1'),
    })
    const next = ctx.repo.register({
      device: 'jt', team: 't', name: 'new',
      runtime_ui_pid: 5847, delivery: claude('C1'),
    })

    ctx.repo.register({
      device: 'jt', team: 't', name: 'proxy-5847', role: '__channel_proxy__',
      claude_ui_pid: 5847, delivery: claude('C2'),
    })

    expect(ctx.repo.findById(next.agent_id)?.delivery).toEqual(claude('C2'))
    expect(rowOf(ctx, old.agent_id).delivery_kind).toBe('none')
  })

  it('a proxy registration leaves one session on one identity', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old', runtime_ui_pid: 5847,
    })
    ctx.db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?')
      .run(new Date(Date.now() - 60_000).toISOString(), old.agent_id)
    const next = ctx.repo.register({
      device: 'jt', team: 't', name: 'new', runtime_ui_pid: 5847,
    })

    ctx.repo.register({
      device: 'jt', team: 't', name: 'channel-proxy-1',
      role: '__channel_proxy__', claude_ui_pid: 5847, delivery: claude('C1'),
    })

    expect(rowOf(ctx, next.agent_id).delivery_kind).toBe('claude-channel')
    expect(rowOf(ctx, old.agent_id).delivery_kind).toBe('none')
    expect(rowOf(ctx, old.agent_id).runtime_ui_pid).toBeNull()
    expect(holders(ctx).every(g => g.n === 1)).toBe(true)

    ctx.repo.register({
      device: 'jt', team: 't', name: 'channel-proxy-1',
      role: '__channel_proxy__', claude_ui_pid: 5847, delivery: claude('C2'),
    })
    expect(rowOf(ctx, old.agent_id).delivery_kind).toBe('none')
    expect(holders(ctx).every(g => g.n === 1)).toBe(true)
  })

  it('a released claude row keeps a different runtime_ui_pid', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old',
      runtime_ui_pid: 111, delivery: claude('C1'),
    })
    ctx.repo.register({
      device: 'jt', team: 't', name: 'new',
      runtime_ui_pid: 222, delivery: claude('C1'),
    })

    const released = rowOf(ctx, old.agent_id)
    expect(released.delivery_kind).toBe('none')
    expect(released.runtime_ui_pid).toBe(111)
  })

  it('a codex takeover never clears runtime_ui_pid', () => {
    const ctx = fresh()
    const old = ctx.repo.register({
      device: 'jt', team: 't', name: 'old',
      runtime_ui_pid: 5847, delivery: codex('T1'),
    })
    ctx.repo.register({
      device: 'jt', team: 't', name: 'new',
      runtime_ui_pid: 5847, delivery: codex('T1'),
    })

    expect(rowOf(ctx, old.agent_id).runtime_ui_pid).toBe(5847)
  })

  it('a proxy row keeps sharing the session its host is re-bound to', () => {
    const ctx = fresh()
    const proxy = ctx.repo.register({
      device: 'jt', team: 't', name: 'proxy-1', role: '__channel_proxy__',
      delivery: claude('C1'),
    })
    const alice = ctx.repo.register({
      device: 'jt', team: 't', name: 'alice', delivery: claude('C1'),
    })

    ctx.repo.setDelivery(alice.agent_id, claude('C1'))

    expect(ctx.repo.findById(proxy.agent_id)?.delivery).toEqual(claude('C1'))
    expect(ctx.repo.findById(alice.agent_id)?.delivery).toEqual(claude('C1'))
  })

  it('writing a proxy row releases no host', () => {
    const ctx = fresh()
    const alice = ctx.repo.register({
      device: 'jt', team: 't', name: 'alice', delivery: claude('C1'),
    })

    const proxy = ctx.repo.register({
      device: 'jt', team: 't', name: 'proxy-1', role: '__channel_proxy__',
      delivery: claude('C1'),
    })
    ctx.repo.setDelivery(proxy.agent_id, claude('C1'))

    expect(ctx.repo.findById(alice.agent_id)?.delivery).toEqual(claude('C1'))
  })

  it('the same coordinate on another device is untouched', () => {
    const ctx = fresh()
    const c = ctx.repo.register({
      device: 'gx', team: 't', name: 'c', delivery: codex('T1'),
    })

    ctx.repo.register({
      device: 'jt', team: 't', name: 'b', delivery: codex('T1'),
    })

    expect(ctx.repo.findById(c.agent_id)?.delivery).toEqual(codex('T1'))
  })

  it('re-registering on its own coordinate modifies no other row', () => {
    const ctx = fresh()
    const other = ctx.repo.register({
      device: 'jt', team: 't', name: 'other', delivery: codex('T2'),
    })
    const first = ctx.repo.register({
      device: 'jt', team: 't', name: 'b', delivery: codex('T1'),
    })
    const before = rowOf(ctx, other.agent_id)

    const second = ctx.repo.register({
      device: 'jt', team: 't', name: 'b', delivery: codex('T1'),
    })

    expect(second.agent_id).toBe(first.agent_id)
    expect(ctx.repo.findById(first.agent_id)?.delivery).toEqual(codex('T1'))
    expect(rowOf(ctx, other.agent_id)).toEqual(before)
  })

  it('a registration that writes no delivery releases nobody', () => {
    const ctx = fresh()
    const holder = ctx.repo.register({
      device: 'jt', team: 't', name: 'holder', delivery: codex('T1'),
    })
    const b = ctx.repo.register({
      device: 'jt', team: 't', name: 'b', delivery: codex('T9'),
    })
    ctx.db.prepare(
      `UPDATE agents SET delivery_payload=? WHERE agent_id=?`
    ).run(JSON.stringify({ thread_id: 'T1', ws_url: WS }), b.agent_id)

    ctx.repo.register({ device: 'jt', team: 't', name: 'b' })

    expect(ctx.repo.findById(holder.agent_id)?.delivery).toEqual(codex('T1'))
  })

  it('other delivery kinds are never released', () => {
    const ctx = fresh()
    const kimi = ctx.repo.register({
      device: 'jt', team: 't', name: 'kimi',
      delivery: {
        kind: 'kimi-server', session_id: 'T1', base_url: 'http://127.0.0.1:1',
      },
    })
    const before = rowOf(ctx, kimi.agent_id)

    ctx.repo.register({
      device: 'jt', team: 't', name: 'b', delivery: codex('T1'),
    })
    ctx.repo.register({
      device: 'jt', team: 't', name: 'c', delivery: claude('T1'),
    })

    expect(rowOf(ctx, kimi.agent_id)).toEqual(before)
  })

  it('adds prev_codex_thread_id to a database created before it', () => {
    const ctx = fresh()
    ctx.db.exec('ALTER TABLE agents DROP COLUMN prev_codex_thread_id')
    const columns = (): string[] =>
      (ctx.db.pragma('table_info(agents)') as Array<{ name: string }>)
        .map(c => c.name)
    expect(columns()).not.toContain('prev_codex_thread_id')

    applySchema(ctx.db)
    applySchema(ctx.db)

    expect(columns().filter(c => c === 'prev_codex_thread_id')).toHaveLength(1)
  })

  it('at most one non-proxy row per device holds a coordinate', () => {
    const ctx = fresh()
    const names = ['a', 'b', 'c']
    for (const name of names) {
      ctx.repo.register({
        device: 'jt', team: 't', name, delivery: codex('T1'),
      })
    }
    for (const name of names) {
      const id = ctx.repo.findByIdentity({ device: 'jt', team: 't', name })!
      ctx.repo.setDelivery(id.agent_id, claude('C1'))
    }
    ctx.repo.register({
      device: 'jt', team: 't', name: 'a', delivery: codex('T1'),
    })

    expect(holders(ctx).every(g => g.n === 1)).toBe(true)
    expect(holders(ctx)).toHaveLength(2)
  })
})
