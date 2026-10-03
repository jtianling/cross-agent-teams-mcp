import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertAgent } from './helpers/insert-agent.js'

vi.mock('../src/mcp/poke.js', () => ({
  poke: vi.fn(async (_deps: unknown, _input: { target_agent_id: string; prompt: string }) => ({
    ok: true as const,
    transport_used: 'tmux-poke' as const,
    pane_id: '%mock',
    pane_tail_before: '',
    pane_tail_after: ''
  }))
}))

import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { BroadcastService } from '../src/mcp/broadcast.js'
import { __setCapturePaneTail, __resetCapturePaneTail } from '../src/mcp/poke-guard.js'
import { clearAllRetries, scheduleRetry, __peekRetryMap } from '../src/mcp/poke-retry.js'
import { createAutoPokeImpl, buildAutoPokeHint } from '../src/mcp/tools.js'
import { poke as pokeMock } from '../src/mcp/poke.js'

interface Setup {
  db: ReturnType<typeof openDb>
  agents: AgentsRepo
  events: EventsOutbox
  sendSvc: SendMessageService
  broadcastSvc: BroadcastService
  cleanup: () => void
}

function setup(opts?: { paneState?: Record<string, 'idle' | 'active'> }): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'atm-autopoke-hint-'))
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)

  const panes = opts?.paneState ?? {}
  __setCapturePaneTail(async (paneId: string) => {
    const state = Object.entries(panes).find(([pid]) => pid === paneId)?.[1] ?? 'idle'
    if (state === 'idle') return `idle-${paneId}`
    return `active-${paneId}-${Math.random()}`
  })

  const autoPokeImpl = createAutoPokeImpl(db, agents)
  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl })
  const broadcastSvc = new BroadcastService(db, agents, { poke: autoPokeImpl })
  return {
    db,
    agents,
    events,
    sendSvc,
    broadcastSvc,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

// The mailbox spec's prompt format, restated here independently of the
// implementation so a drift in buildAutoPokeHint fails rather than follows:
//   新邮件 from {sender_identifier} → {target_name}@{target_team}, 请调 get_inbox 查看
function expectedHint(
  sender: string,
  target?: { name: string; team: string }
): string {
  const to = target === undefined ? '' : ` → ${target.name}@${target.team}`
  return `新邮件 from ${sender}${to}, 请调 get_inbox 查看`
}

describe('auto-poke hint format', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => {
    process.env.POKE_QUIET_MS = '50'
    vi.mocked(pokeMock).mockClear()
  })
  afterEach(() => {
    clearAllRetries()
    if (vi.isFakeTimers()) vi.useRealTimers()
    cleanups.forEach(c => c()); cleanups.length = 0
    __resetCapturePaneTail()
    delete process.env.POKE_QUIET_MS
  })

  it('send_message default auto_poke: pokeFn receives hint, not body', async () => {
    const { db, sendSvc, cleanup } = setup({ paneState: { '%B': 'idle' } })
    cleanups.push(cleanup)
    const aId = 'aaaaaaaa-1111-2222-3333-444444444444'
    const bId = 'bbbbbbbb-5555-6666-7777-888888888888'
    insertAgent(db, { agent_id: aId, model: 'm', role: 'caller', name: 'lead-opus', tmux_pane_id: '%A'  })
    insertAgent(db, { agent_id: bId, model: 'm', role: 'worker', name: 'worker-kimi', tmux_pane_id: '%B'  })

    const r = await sendSvc.send({ from: aId, to_agent_id: bId, body: 'please investigate bug #42' })
    if ('error' in r) throw new Error('expected success')
    expect(r.poked).toBe(true)

    const pMock = vi.mocked(pokeMock)
    expect(pMock).toHaveBeenCalledTimes(1)
    const call = pMock.mock.calls[0]
    const input = call[1] as { target_agent_id: string; prompt: string }
    // sender is name + full agent_id; target is the recipient's own name@team
    expect(input.prompt).toBe(
      expectedHint(`lead-opus@default (${aId})`, { name: 'worker-kimi', team: 'default' })
    )
    expect(input.prompt).not.toContain('bug #42')
    expect(input.prompt).not.toContain('please investigate')
  })

  it('broadcast default auto_poke: every recipient pokeFn receives hint, not body', async () => {
    const { db, broadcastSvc, cleanup } = setup({
      paneState: { '%B': 'idle', '%C': 'idle' }
    })
    cleanups.push(cleanup)
    const aId = 'aaaaaaaa-1111-2222-3333-444444444444'
    const bId = 'bbbbbbbb-5555-6666-7777-888888888888'
    const cId = 'cccccccc-9999-0000-1111-222222222222'
    insertAgent(db, { agent_id: aId, model: 'm', role: 'lead', name: 'lead-opus', tmux_pane_id: '%A'  })
    insertAgent(db, { agent_id: bId, model: 'm', role: 'worker', name: 'worker-kimi', tmux_pane_id: '%B'  })
    insertAgent(db, { agent_id: cId, model: 'm', role: 'worker', name: 'worker-gpt', tmux_pane_id: '%C'  })

    const body = 'sensitive config: API_KEY=sk-xyz'
    const r = await broadcastSvc.broadcast({ from: aId, body })
    if ('error' in r) throw new Error('expected success')

    const pMock = vi.mocked(pokeMock)
    // broadcast delivers to every other agent in team (B, C)
    expect(pMock).toHaveBeenCalledTimes(2)
    // Each recipient is named individually: a fan-out that reused one target
    // row (or the sender's) for every hint is exactly the failure this segment
    // exists to make visible, so assert the other recipient never appears.
    const byTarget = new Map(pMock.mock.calls.map((call) => {
      const input = call[1] as { target_agent_id: string; prompt: string }
      return [input.target_agent_id, input.prompt]
    }))
    expect(byTarget.get(bId)).toBe(
      expectedHint(`lead-opus@default (${aId})`, { name: 'worker-kimi', team: 'default' })
    )
    expect(byTarget.get(bId)).not.toContain('worker-gpt')
    expect(byTarget.get(cId)).toBe(
      expectedHint(`lead-opus@default (${aId})`, { name: 'worker-gpt', team: 'default' })
    )
    expect(byTarget.get(cId)).not.toContain('worker-kimi')
    for (const prompt of byTarget.values()) {
      expect(prompt).not.toContain('API_KEY')
      expect(prompt).not.toContain('sk-xyz')
      expect(prompt).not.toContain('sensitive')
    }
  })

  it('retry tick: pokeFn receives hint, not body', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'atm-autopoke-retry-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const agents = new AgentsRepo(db)
    const aId = 'aaaaaaaa-1111-2222-3333-444444444444'
    const bId = 'bbbbbbbb-5555-6666-7777-888888888888'
    insertAgent(db, { agent_id: aId, model: 'm', role: 'caller', name: 'lead-opus', tmux_pane_id: '%A'  })
    insertAgent(db, { agent_id: bId, model: 'm', role: 'worker', name: 'worker-kimi', tmux_pane_id: '%B'  })

    const autoPokeImpl = createAutoPokeImpl(db, agents)

    // The retry infrastructure wraps pokeFn as `(args) => { await pokeFn(args) }` — same shape auto-poke-fanout uses.
    // sentAt in the far future so lookupAgent.last_seen_at (now) is strictly < sentAt
    // — otherwise the retry tick would cancel thinking the agent came online after send.
    const sentAt = '2099-01-01T00:00:00.000Z'
    scheduleRetry({
      agentId: bId,
      messageId: 'm-retry-1',
      fromAgentId: aId,
      body: 'secret body that must NEVER reach the pane',
      team: 'default',
      sentAt,
      paneId: '%B',
      paneGuardFn: async () => 'pass',
      pokeFn: async (pokeArgs) => { await autoPokeImpl(pokeArgs) },
      lookupAgentFn: (agentId) => {
        const row = db.prepare('SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?').get(agentId) as { agent_id: string; tmux_pane_id: string | null; last_seen_at: string } | undefined
        return row
      }
    })
    expect(__peekRetryMap().size).toBe(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(__peekRetryMap().size).toBe(0)

    const pMock = vi.mocked(pokeMock)
    expect(pMock).toHaveBeenCalledTimes(1)
    const input = pMock.mock.calls[0][1] as { target_agent_id: string; prompt: string }
    // A retry tick resolves the target afresh; it must not fall back to the
    // captured body nor drop the target segment.
    expect(input.prompt).toBe(
      expectedHint(`lead-opus@default (${aId})`, { name: 'worker-kimi', team: 'default' })
    )
    expect(input.prompt).not.toContain('secret body')

    vi.useRealTimers()
  })

  it('empty name fallback uses agent_id[:8]', async () => {
    const { db, sendSvc, cleanup } = setup({ paneState: { '%B': 'idle' } })
    cleanups.push(cleanup)
    const aId = 'abc12345-dead-beef-0000-111122223333'
    const bId = 'bbbbbbbb-5555-6666-7777-888888888888'
    // Empty name bypasses the zod min(1) gate by writing directly; the hint
    // builder must still fall back to agent_id[:8] for safety.
    insertAgent(db, { agent_id: aId, model: 'm', role: 'caller', tmux_pane_id: '%A', name: '' })
    insertAgent(db, { agent_id: bId, model: 'm', role: 'worker', name: 'worker-kimi', tmux_pane_id: '%B'  })

    const r = await sendSvc.send({ from: aId, to_agent_id: bId, body: 'payload body' })
    if ('error' in r) throw new Error('expected success')

    const pMock = vi.mocked(pokeMock)
    expect(pMock).toHaveBeenCalledTimes(1)
    const input = pMock.mock.calls[0][1] as { target_agent_id: string; prompt: string }
    // The sender fallback is independent of the target segment: a nameless
    // sender still names its recipient.
    expect(input.prompt).toBe(
      expectedHint('abc12345', { name: 'worker-kimi', team: 'default' })
    )
    expect(input.prompt).not.toContain(aId)
    expect(input.prompt).not.toContain('payload body')
  })

  it('buildAutoPokeHint: sender is "name@team (agent_id)" when the name is non-empty', () => {
    const hint = buildAutoPokeHint(
      { name: 'lead-opus', team: 'core' },
      'aaaaaaaa-1111-2222-3333-444444444444',
      { name: 'worker-kimi', team: 'core' }
    )
    expect(hint).toBe('新邮件 from lead-opus@core (aaaaaaaa-1111-2222-3333-444444444444) → worker-kimi@core, 请调 get_inbox 查看')
    expect(hint.length).toBeLessThanOrEqual(200)
    expect(hint).toContain('get_inbox')
  })

  it('buildAutoPokeHint: sender falls back to agent_id[:8] when the row is missing or nameless', () => {
    expect(buildAutoPokeHint(undefined, 'abc12345-dead-beef-0000-111122223333', { name: 'b', team: 't' }))
      .toBe('新邮件 from abc12345 → b@t, 请调 get_inbox 查看')
    expect(buildAutoPokeHint({ name: null }, 'zzzzzzzz-dead-beef-0000-111122223333', { name: 'b', team: 't' }))
      .toBe('新邮件 from zzzzzzzz → b@t, 请调 get_inbox 查看')
    expect(buildAutoPokeHint({ name: '' }, 'yyyyyyyy-dead-beef-0000-111122223333', { name: 'b', team: 't' }))
      .toBe('新邮件 from yyyyyyyy → b@t, 请调 get_inbox 查看')
  })

  it('buildAutoPokeHint: sender and target each carry their own team', () => {
    const from = 'aaaaaaaa-1111-2222-3333-444444444444'
    // Agent names repeat across teams (tester in several teams), so both ends
    // name their team; a cross-team hint must not borrow the other side's.
    expect(buildAutoPokeHint({ name: 'lead-opus', team: 'svc' }, from, { name: 'b', team: 'svc' }))
      .toBe(`新邮件 from lead-opus@svc (${from}) → b@svc, 请调 get_inbox 查看`)
    expect(buildAutoPokeHint({ name: 'tester', team: 'alpha' }, from, { name: 'bob', team: 'beta' }))
      .toBe(`新邮件 from tester@alpha (${from}) → bob@beta, 请调 get_inbox 查看`)
  })

  it('buildAutoPokeHint: a sender row without a team renders the bare name', () => {
    const from = 'aaaaaaaa-1111-2222-3333-444444444444'
    expect(buildAutoPokeHint({ name: 'lead-opus', team: '' }, from, { name: 'b', team: 't' }))
      .toBe(`新邮件 from lead-opus (${from}) → b@t, 请调 get_inbox 查看`)
  })

  it('buildAutoPokeHint: an unresolvable target drops the separator too, with no placeholder', () => {
    const from = 'abc12345-dead-beef-0000-111122223333'
    const bare = '新邮件 from abc12345, 请调 get_inbox 查看'
    for (const target of [undefined, { name: null, team: 'svc' }, { name: 'b', team: '' }, { name: '', team: 'svc' }]) {
      const hint = buildAutoPokeHint(undefined, from, target)
      expect(hint).toBe(bare)
      expect(hint).not.toContain('→')
      expect(hint).not.toContain('@')
      expect(hint).not.toContain('undefined')
      expect(hint).not.toContain('null')
    }
  })

  it('buildAutoPokeHint: keeps the target segment while it fits in 200 characters', () => {
    const hint = buildAutoPokeHint(
      { name: 'n'.repeat(40) },
      'aaaaaaaa-1111-2222-3333-444444444444',
      { name: 't'.repeat(30), team: 'm'.repeat(30) }
    )
    expect(hint).toContain(' → ')
    expect(hint.length).toBeLessThanOrEqual(200)
  })

  it('buildAutoPokeHint: drops the target segment rather than exceed 200 characters', () => {
    const hint = buildAutoPokeHint(
      { name: 'n'.repeat(64) },
      'aaaaaaaa-1111-2222-3333-444444444444',
      { name: 't'.repeat(64), team: 'm'.repeat(64) }
    )
    expect(hint.length).toBeLessThanOrEqual(200)
    expect(hint).not.toContain(' → ')
  })

  it('buildAutoPokeHint: falls back to agent_id[:8] when the sender name alone busts the cap', () => {
    // `name` has no schema length limit, so dropping only the target segment
    // does not bound the hint — the sender's display name has to go too.
    const from = 'aaaaaaaa-1111-2222-3333-444444444444'
    const hint = buildAutoPokeHint(
      { name: 'n'.repeat(500) },
      from,
      { name: 'b', team: 't' }
    )
    expect(hint.length).toBeLessThanOrEqual(200)
    expect(hint).toBe(`新邮件 from ${from.slice(0, 8)}, 请调 get_inbox 查看`)
    expect(hint).not.toContain('nnnn')
  })

  it('buildAutoPokeHint: omitting the target argument renders the bare sender-only form', () => {
    expect(buildAutoPokeHint({ name: 'lead-opus' }, 'aaaaaaaa-1111-2222-3333-444444444444'))
      .toBe('新邮件 from lead-opus (aaaaaaaa-1111-2222-3333-444444444444), 请调 get_inbox 查看')
    expect(buildAutoPokeHint(undefined, 'abc12345-dead-beef-0000-111122223333'))
      .toBe('新邮件 from abc12345, 请调 get_inbox 查看')
  })
})
