import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { CodexBindingRepo } from '../src/mcp/codex-binding-repo.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { PaneLookupService } from '../src/pane-lookup/service.js'
import { paneLookupSchema, type PaneLookupInput } from '../src/pane-lookup/schema.js'
import {
  parsePaneFields, parseProcessSnapshot, PaneProbeError,
  type PaneProbes, type PaneSnapshot,
  type ProcessSnapshot,
} from '../src/pane-lookup/probes.js'

const SERVER_START = 1793000000
const BOUND_TIME = new Date((SERVER_START + 10) * 1000).toISOString()
const input: PaneLookupInput = { protocol_version: 1, tmux: {
  socket_path: '/private/test/tmux.sock', server_pid: 100,
  server_started_at: SERVER_START, pane_id: '%1',
} }
const pane: PaneSnapshot = { ...input.tmux, pane_pid: 101, tty: 'pts/1' }
const processRow: ProcessSnapshot = { pid: 102, pgid: 102, tpgid: 102,
  tty: 'pts/1', started_at: (SERVER_START + 2) * 1000,
  stat: 'S+', command: '/usr/bin/opencode' }

describe('exact read-only pane identity lookup', () => {
  let db: Database.Database
  let repo: AgentsRepo
  let service: PaneLookupService
  let probes: PaneProbes
  let channels: ChannelWakeFanout

  beforeEach(() => {
    db = openDb(':memory:')
    applySchema(db)
    repo = new AgentsRepo(db)
    channels = new ChannelWakeFanout()
    probes = {
      socket: vi.fn(async () => ({ path: input.tmux.socket_path,
        device: 1, inode: 2, uid: 501 })),
      panes: vi.fn(async () => [{ ...pane }]),
      process: vi.fn(async () => ({ ...processRow })),
    }
    service = new PaneLookupService(db, 'local', channels, probes)
  })
  afterEach(() => db.close())

  function seed(name = 'worker',
    kind: 'opencode' | 'claude-code' | 'codex' = 'opencode') {
    const row = repo.register({ name, team: 'test', agent_type: kind })
    db.prepare(`UPDATE agents SET tmux_pane_id = ?, runtime_ui_pid = ?,
      runtime_tty = ?, runtime_verification_mode = ?, runtime_bound_at = ?
      WHERE agent_id = ?`).run('%1', 102, 'pts/1', 'verified_pid_tty_pane',
      BOUND_TIME, row.agent_id)
    return row.agent_id
  }

  it('verifies a native carrier without modifying any registry row', async () => {
    const id = seed()
    const before = db.prepare('SELECT * FROM agents').all()
    const result = await service.lookup(input)
    expect(result).toMatchObject({ ok: true, tmux: input.tmux,
      identity: { status: 'verified', agent: { agent_id: id, name: 'worker',
        team: 'test', device: 'local', agent_type: 'opencode' } },
      runtime: { status: 'not_ready', reason: 'no_delivery_transport' } })
    expect(Date.parse(result.checked_at)).not.toBeNaN()
    expect(db.prepare('SELECT * FROM agents').all()).toEqual(before)
    expect(Object.keys(result.identity.agent!).sort()).toEqual([
      'agent_id', 'agent_type', 'device', 'name', 'team',
    ])
  })

  it('returns unbound for an unregistered live pane', async () => {
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'unbound', agent: null }, runtime: { status: 'unknown' },
    })
  })

  it('does not treat the same pane number on another server as its owner', async () => {
    seed()
    vi.mocked(probes.panes).mockResolvedValue([{ ...pane, tty: 'pts/other' }])
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'unverifiable', agent: null },
    })
  })

  it('rejects stale server generations even if pane and tty match', async () => {
    seed()
    vi.mocked(probes.panes).mockResolvedValue([{ ...pane,
      server_started_at: SERVER_START + 1 }])
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'stale', reason: 'tmux_server_changed', agent: null },
    })
  })

  it('does not accept a reused pid born after registration', async () => {
    seed()
    vi.mocked(probes.process).mockResolvedValue({ ...processRow,
      started_at: Date.parse(BOUND_TIME) + 1000 })
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'unverifiable', agent: null },
    })
  })

  it('fails closed on multiple currently verified identities', async () => {
    seed('first')
    seed('second')
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'ambiguous', agent: null },
    })
  })

  it('rejects registry changes during the last process probe', async () => {
    const id = seed()
    vi.mocked(probes.process).mockResolvedValueOnce(processRow)
      .mockImplementationOnce(async () => {
        db.prepare(`UPDATE agents SET register_generation = register_generation + 1
          WHERE agent_id = ?`)
          .run(id)
        return processRow
      })
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'stale', reason: 'binding_changed', agent: null },
    })
  })

  it('does not guess custom or HTTP-only runtime ownership', async () => {
    const id = seed()
    db.prepare("UPDATE agents SET agent_type = 'custom' WHERE agent_id = ?").run(id)
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'unverifiable', agent: null },
    })
  })

  it('checks Codex launch evidence against the live carrier', async () => {
    const id = seed('codex', 'codex')
    const thread = randomUUID()
    const launch = randomUUID()
    db.prepare(`UPDATE agents SET delivery_kind = 'codex-appserver',
      delivery_payload = ? WHERE agent_id = ?`).run(JSON.stringify({
      thread_id: thread, ws_url: 'ws://localhost:8799',
    }), id)
    const bindings = new CodexBindingRepo(db)
    bindings.begin('%1', launch, new Date().toISOString())
    bindings.complete({ paneId: '%1', launchId: launch,
      agentId: id, runtimePid: 102, registerGeneration: 1 })
    vi.mocked(probes.process).mockResolvedValue({ ...processRow,
      command: `/bin/codex --remote ws://localhost:8799 -c xats.agent_id="${launch}"` })
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'verified' },
      runtime: { status: 'unknown', reason: 'delivery_not_probed' },
    })
    vi.mocked(probes.process).mockResolvedValue({ ...processRow,
      command: '/bin/sh -c codex --remote ws://localhost:8799 '
        + `-c xats.agent_id="${launch}"` })
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'unverifiable', agent: null },
    })
    vi.mocked(probes.process).mockResolvedValue({ ...processRow,
      command: '/bin/codex --remote ws://localhost:8799' })
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'unverifiable', agent: null },
    })
  })

  it('rechecks the carrier after the second pane query', async () => {
    seed()
    vi.mocked(probes.panes).mockResolvedValueOnce([pane])
      .mockImplementationOnce(async () => {
        vi.mocked(probes.process).mockResolvedValue(undefined)
        return [pane]
      })
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'stale', reason: 'carrier_changed', agent: null },
    })
  })

  it('requires the current channel owner for Claude readiness', async () => {
    const id = seed('claude', 'claude-code')
    vi.mocked(probes.process).mockResolvedValue({
      ...processRow, command: '/bin/claude',
    })
    db.prepare(`UPDATE agents SET delivery_kind = 'claude-channel',
      delivery_payload = ? WHERE agent_id = ?`)
      .run(JSON.stringify({ channel_session_id: 'channel' }), id)
    const proxy = repo.register({ name: 'proxy', role: '__channel_proxy__',
      claude_ui_pid: 102,
      delivery: { kind: 'claude-channel', channel_session_id: 'channel' } })
    channels.attach('channel', () => {}, 'mcp-session', proxy.agent_id)
    expect(await service.lookup(input)).toMatchObject({
      identity: { status: 'verified' }, runtime: { status: 'ready' },
    })
    channels.detach('channel')
    expect(await service.lookup(input))
      .toMatchObject({ runtime: { status: 'not_ready' } })
  })

  it('propagates probe failure instead of reporting an unbound identity', async () => {
    vi.mocked(probes.panes).mockRejectedValue(new PaneProbeError('tmux_query_failed'))
    await expect(service.lookup(input)).rejects.toThrow('tmux_query_failed')
  })

  it('validates absolute socket paths and strict request fields', () => {
    expect(paneLookupSchema.safeParse({ ...input, tmux: {
      ...input.tmux, socket_path: 'relative.sock',
    } }).success).toBe(false)
    expect(paneLookupSchema.safeParse({ ...input, token: 'not-accepted' }).success)
      .toBe(false)
  })

  it('parses process start times as UTC and rejects malformed output', () => {
    const line = '102 102 102 pts/1 Mon Oct 26 12:00:00 2026 S+ /bin/opencode'
    expect(parseProcessSnapshot(line)).toMatchObject({
      pid: 102, tty: 'pts/1', started_at: Date.parse('2026-10-26T12:00:00Z'),
    })
    expect(parseProcessSnapshot('unexpected process output')).toBeUndefined()
  })

  it('parses printable tmux separators without splitting a pipe in the socket path', () => {
    expect(parsePaneFields('/tmp/a|b/socket|100|1793000000|%1|101|/dev/pts/1'))
      .toEqual(['/tmp/a|b/socket', 100, 1793000000, '%1', 101, '/dev/pts/1'])
    expect(parsePaneFields('/tmp/socket|100|1793000000|%1|101|/dev/pts/1'))
      .toEqual(['/tmp/socket', 100, 1793000000, '%1', 101, '/dev/pts/1'])
    const escaped = '/tmp/socket\\037100\\0371793000000\\037%1\\037101\\037/dev/pts/1'
    expect(() => parsePaneFields(escaped)).toThrow('tmux_response_invalid')
    expect(() => parsePaneFields('/tmp/socket|bad-pid|1793000000|%1|101|/dev/pts/1'))
      .toThrow('tmux_response_invalid')
  })
})
