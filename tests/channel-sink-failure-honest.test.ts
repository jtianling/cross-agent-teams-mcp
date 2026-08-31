import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { GetInboxService } from '../src/mcp/get-inbox.js'
import { createAutoPokeImpl } from '../src/mcp/tools.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { sendChannelWake } from '../src/daemon/channel-wake-send.js'
import { dispatchPoke, type TargetRow, type TmuxPokeResult } from '../src/mcp/transport-dispatch.js'
import { insertAgent } from './helpers/insert-agent.js'

function claudeTarget(over: Partial<TargetRow> = {}): TargetRow {
  return {
    agent_id: 'B',
    agent_type: 'claude-code',
    device: 'local',
    delivery: { kind: 'claude-channel', channel_session_id: 'csid-1' },
    tmux_pane_id: null,
    runtime_ui_pid: null,
    ...over,
  }
}

function tmuxRecorder() {
  const calls: Array<{ pane_id: string; content: string }> = []
  return {
    calls,
    fn: async (args: { pane_id: string; content: string }): Promise<TmuxPokeResult> => {
      calls.push({ pane_id: args.pane_id, content: args.content })
      return { ok: true, pane_tail_before: 'before', pane_tail_after: 'after' }
    },
  }
}

describe('ChannelWakeFanout reports sink failure instead of swallowing it', () => {
  it('returns true when the sink accepts', () => {
    const fanout = new ChannelWakeFanout()
    fanout.attach('csid-1', () => {}, 'sess-A')
    expect(fanout.send('csid-1', { a: 1 })).toBe(true)
  })

  it('returns false when the sink throws, and keeps the sink attached', () => {
    const fanout = new ChannelWakeFanout()
    fanout.attach('csid-1', () => { throw new Error('socket gone') }, 'sess-A')

    expect(fanout.send('csid-1', { a: 1 })).toBe(false)
    // A write error is not proof the subscriber vanished; detaching here would
    // race the proxy's own lifecycle.
    expect(fanout.has('csid-1')).toBe(true)
  })

  it('returns false when nothing is attached', () => {
    expect(new ChannelWakeFanout().send('csid-missing', { a: 1 })).toBe(false)
  })

  it('surfaces sink_failed through sendChannelWake', () => {
    const fanout = new ChannelWakeFanout()
    fanout.attach('csid-1', () => { throw new Error('socket gone') }, 'sess-A')

    const res = sendChannelWake(fanout, 'csid-1', { content: 'hi', meta: {} })

    expect(res).toEqual({ ok: false, reason: 'sink_failed' })
  })

  it('still reports no_subscriber when nothing is attached', () => {
    const res = sendChannelWake(new ChannelWakeFanout(), 'csid-1', { content: 'hi', meta: {} })
    expect(res).toEqual({ ok: false, reason: 'no_subscriber' })
  })
})

describe('a failed channel write does not read as delivered', () => {
  it('falls back to tmux when the target has a pane', async () => {
    const fanout = new ChannelWakeFanout()
    fanout.attach('csid-1', () => { throw new Error('socket gone') }, 'sess-A')
    const tmux = tmuxRecorder()

    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      claudeTarget({ tmux_pane_id: '%7' }),
      { content: 'wake', meta: {} }
    )

    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke', pane_id: '%7' })
    expect(tmux.calls).toHaveLength(1)
  })

  it('reports channel_sink_failed when there is no pane to fall back to', async () => {
    const fanout = new ChannelWakeFanout()
    fanout.attach('csid-1', () => { throw new Error('socket gone') }, 'sess-A')
    const tmux = tmuxRecorder()

    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      claudeTarget(),
      { content: 'wake', meta: {} }
    )

    // Distinct from no_transport_available: a subscriber IS attached, and
    // collapsing the two would recreate the false signal one layer up.
    expect(res).toMatchObject({ error: 'channel_sink_failed' })
    expect(tmux.calls).toHaveLength(0)
  })

  it('still reports no_transport_available when nothing is subscribed and no pane exists', async () => {
    const tmux = tmuxRecorder()

    const res = await dispatchPoke(
      { channelWakeFanout: new ChannelWakeFanout(), tmuxPoke: tmux.fn },
      claudeTarget(),
      { content: 'wake', meta: {} }
    )

    expect(res).toMatchObject({ error: 'no_transport_available' })
  })

  it('makes send_message report the failure instead of poked:true', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atm-sink-'))
    try {
      const db = openDb(join(dir, 'data.db'))
      applySchema(db)
      const fanout = new ChannelWakeFanout()
      fanout.attach('csid-1', () => { throw new Error('socket gone') }, 'sess-B')

      insertAgent(db, { agent_id: 'A', name: 'A' })
      insertAgent(db, {
        agent_id: 'B',
        name: 'B',
        agent_type: 'claude-code',
        delivery: { kind: 'claude-channel', channel_session_id: 'csid-1' },
      })

      const send = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db), {
        poke: createAutoPokeImpl(db, new AgentsRepo(db), fanout, 'local'),
      })
      const sent = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi', await_ack_s: 0 })
      if ('error' in sent) throw new Error('expected success')

      // Before this change the swallowed sink error produced poked:true here.
      expect(sent.poked).toBe(false)
      expect(sent.poke_skip_reasons).toEqual([{ agent_id: 'B', reason: 'channel_sink_failed' }])
      // The mailbox row is written regardless — the wake-up is only a hint.
      const inbox = new GetInboxService(db, new AgentsRepo(db)).get({ caller: 'B' })
      expect(inbox.messages.map(m => m.body)).toContain('hi')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports success when the sink accepts', async () => {
    const fanout = new ChannelWakeFanout()
    const seen: unknown[] = []
    fanout.attach('csid-1', p => seen.push(p), 'sess-A')
    const tmux = tmuxRecorder()

    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      claudeTarget({ tmux_pane_id: '%7' }),
      { content: 'wake', meta: {} }
    )

    expect(res).toMatchObject({ ok: true, transport_used: 'claude-channel' })
    expect(seen).toHaveLength(1)
    expect(tmux.calls).toHaveLength(0)
  })
})
