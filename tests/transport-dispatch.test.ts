import { describe, it, expect } from 'vitest'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { dispatchPoke } from '../src/mcp/transport-dispatch.js'

type TmuxStub = {
  calls: Array<{ pane_id: string; content: string }>
  result: { ok: true; pane_tail_before: string; pane_tail_after: string } |
          { error: string; detail?: unknown }
}

function stubTmux(result: TmuxStub['result']): TmuxStub & { fn: (args: { pane_id: string; content: string }) => Promise<typeof result> } {
  const self: TmuxStub = { calls: [], result }
  return {
    ...self,
    fn: async (args) => { self.calls.push(args); return result }
  }
}

describe('dispatchPoke', () => {
  it('prefers channel when csid set + sink attached', async () => {
    const fanout = new ChannelWakeFanout()
    const emitted: unknown[] = []
    fanout.attach('csid-bob', (p) => emitted.push(p), 'sess-P')
    const tmux = stubTmux({ ok: true, pane_tail_before: 'b', pane_tail_after: 'a' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'claude-code',
        delivery: { kind: 'claude-channel', channel_session_id: 'csid-bob' },
        tmux_pane_id: '%99',
      },
      { content: 'hi', meta: { source: 'x' } }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'claude-channel', channel_session_id: 'csid-bob' })
    expect(emitted).toHaveLength(1)
    expect(tmux.calls).toHaveLength(0)
  })

  it('falls back to tmux when csid set but no sink attached', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: 'bb', pane_tail_after: 'aa' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'claude-code',
        delivery: { kind: 'claude-channel', channel_session_id: 'csid-bob' },
        tmux_pane_id: '%99',
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke', pane_id: '%99' })
    expect(tmux.calls).toEqual([{ pane_id: '%99', content: 'hi' }])
  })

  it('uses tmux directly when csid is null', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: 'x', pane_tail_after: 'y' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: null, delivery: { kind: 'none' }, tmux_pane_id: '%42' },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke' })
  })

  it('returns no_transport_available when neither csid/sink nor tmux available', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: null, delivery: { kind: 'none' }, tmux_pane_id: null },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'no_transport_available',
      detail: { channel_subscribed: false, tmux_pane_set: false }
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('returns no_transport_available when csid has no sink and tmux_pane absent', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'claude-code',
        delivery: { kind: 'claude-channel', channel_session_id: 'csid-x' },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'no_transport_available',
      detail: { channel_subscribed: false, tmux_pane_set: false }
    })
  })

  it('propagates tmux error envelope with transport_used', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ error: 'pane_dead', detail: 'no pane' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      { agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: null, delivery: { kind: 'none' }, tmux_pane_id: '%42' },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ error: 'pane_dead', transport_used: 'tmux-poke' })
  })

  it('routes codex-appserver to the dedicated dispatcher', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const codexCalls: Array<{ thread_id: string; ws_url: string; content: string }> = []
    const res = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        codexAppserverDispatch: async ({ delivery, content }) => {
          codexCalls.push({
            thread_id: delivery.thread_id,
            ws_url: delivery.ws_url,
            content,
          })
          return {
            ok: true,
            transport_used: 'codex-appserver',
            thread_id: delivery.thread_id,
          }
        },
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'codex',
        delivery: {
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'wss://example.test/ws',
        },
        tmux_pane_id: '%42',
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      ok: true,
      transport_used: 'codex-appserver',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })
    expect(codexCalls).toEqual([
      {
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'wss://example.test/ws',
        content: 'hi',
      },
    ])
    expect(tmux.calls).toHaveLength(0)
  })

  it('falls back to tmux when codex dispatcher fails', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        codexAppserverDispatch: async () => ({
          error: 'codex_connect_failed',
          detail: 'ECONNREFUSED',
          transport_used: 'codex-appserver',
        }),
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'codex',
        delivery: {
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'wss://example.test/ws',
        },
        tmux_pane_id: '%42',
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      ok: true,
      transport_used: 'tmux-poke',
      pane_id: '%42',
      pane_tail_before: '',
      pane_tail_after: '',
    })
  })

  it('codex dispatcher failure with NO pane returns the appserver error and never touches tmux (cleared CAS-drift residue)', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        codexAppserverDispatch: async () => ({
          error: 'codex_connect_failed',
          detail: 'ECONNREFUSED',
          transport_used: 'codex-appserver',
        }),
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'codex',
        delivery: {
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'wss://example.test/ws',
        },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({
      error: 'codex_connect_failed',
      transport_used: 'codex-appserver',
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('does not fall back to tmux after Codex accepted input but wake confirmation timed out', async () => {
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      {
        tmuxPoke: tmux.fn,
        codexAppserverDispatch: async () => ({
          error: 'codex_wake_unconfirmed',
          detail: 'get_inbox not observed',
          transport_used: 'codex-appserver',
        }),
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'codex',
        delivery: {
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'wss://example.test/ws',
        },
        tmux_pane_id: '%42',
      },
      { content: 'hi', meta: {} }
    )

    expect(res).toMatchObject({
      error: 'codex_wake_unconfirmed',
      transport_used: 'codex-appserver',
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('routes opencode-server to the opencode dispatcher', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const opencodeCalls: Array<{ session_id: string; base_url: string; content: string }> = []
    const res = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeServerDispatch: async ({ delivery, content }) => {
          opencodeCalls.push({
            session_id: delivery.session_id,
            base_url: delivery.base_url,
            content,
          })
          return {
            ok: true,
            transport_used: 'opencode-server',
            session_id: delivery.session_id,
          }
        },
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'opencode',
        delivery: {
          kind: 'opencode-server',
          session_id: 'ses_abc',
          base_url: 'http://127.0.0.1:18888',
        },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      ok: true,
      transport_used: 'opencode-server',
      session_id: 'ses_abc',
    })
    expect(opencodeCalls).toEqual([
      {
        session_id: 'ses_abc',
        base_url: 'http://127.0.0.1:18888',
        content: 'hi',
      },
    ])
    expect(tmux.calls).toHaveLength(0)
  })

  it('does NOT fall back to tmux when opencode-server dispatcher fails (even with tmux_pane_id set)', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      {
        channelWakeFanout: fanout,
        tmuxPoke: tmux.fn,
        opencodeServerDispatch: async () => ({
          error: 'opencode_connect_failed',
          detail: 'ECONNREFUSED',
          transport_used: 'opencode-server',
        }),
      },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'opencode',
        delivery: {
          kind: 'opencode-server',
          session_id: 'ses_abc',
          base_url: 'http://127.0.0.1:18888',
        },
        tmux_pane_id: '%42',
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'opencode_connect_failed',
      detail: 'ECONNREFUSED',
      transport_used: 'opencode-server',
    })
    expect(tmux.calls).toHaveLength(0)
  })

  it('opencode agent without opencode-server delivery falls back to tmux when pane set', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: 'b', pane_tail_after: 'a' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'opencode',
        delivery: { kind: 'none' },
        tmux_pane_id: '%77',
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'tmux-poke', pane_id: '%77' })
  })

  it('opencode agent without opencode-server delivery and no pane returns no_transport_available', async () => {
    const fanout = new ChannelWakeFanout()
    const tmux = stubTmux({ ok: true, pane_tail_before: '', pane_tail_after: '' })
    const res = await dispatchPoke(
      { channelWakeFanout: fanout, tmuxPoke: tmux.fn },
      {
        agent_id: 'target', device: 'local', runtime_ui_pid: null, agent_type: 'opencode',
        delivery: { kind: 'none' },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'no_transport_available',
      detail: { opencode_bound: false, tmux_pane_set: false },
    })
    expect(tmux.calls).toHaveLength(0)
  })
})
