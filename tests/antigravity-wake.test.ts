import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fanoutAutoPoke } from '../src/mcp/auto-poke-fanout.js'
import { dispatchPoke, type TargetRow } from '../src/mcp/transport-dispatch.js'

const launch_id = randomUUID()
const target: TargetRow = {
  agent_id: 'recipient', agent_type: 'antigravity', device: 'local',
  delivery: { kind: 'antigravity-pty', launch_id }, tmux_pane_id: '%9',
  runtime_ui_pid: null,
}
const mailboxTarget = { name: 'reader', team: 'test' }
const input = { mailboxTarget, content: 'sender-controlled text', meta: {} }

describe('native Antigravity wake routing', () => {
  it.each([
    ['delivered', { ok: true, transport_used: 'antigravity-pty' }],
    ['busy', { error: 'agy_busy' }],
    ['unavailable', { error: 'agy_unavailable' }],
  ] as const)('reports launcher status %s', async (status, expected) => {
    const deps = { agyLauncher: vi.fn(async () => ({ status })), tmuxPoke: vi.fn() }
    expect(await dispatchPoke(deps, target, input)).toMatchObject(expected)
    expect(deps.agyLauncher.mock.calls).toEqual([
      ['wake', { launch_id, ...mailboxTarget }],
    ])
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })

  it('keeps mailbox-only agents away from stale panes', async () => {
    const deps = { poke: vi.fn(), tmuxAvailable: vi.fn() }
    const result = await fanoutAutoPoke({
      team: 'test', fromAgentId: 'sender', deps, body: 'mail',
      recipients: [{ ...target, delivery: { kind: 'none' } }],
    })
    expect(result.skipReasons).toEqual([{ agent_id: 'recipient', reason: 'inbox_only' }])
    expect(deps.poke).not.toHaveBeenCalled()
    expect(deps.tmuxAvailable).not.toHaveBeenCalled()
  })

  it('never turns a non-mail prompt into an inbox notification', async () => {
    const deps = { agyLauncher: vi.fn(), tmuxPoke: vi.fn() }
    const result = await dispatchPoke(deps, target, { content: 'alert', meta: {} })
    expect(result).toEqual({ error: 'agy_unavailable' })
    expect(deps.agyLauncher).not.toHaveBeenCalled()
    expect(deps.tmuxPoke).not.toHaveBeenCalled()
  })
})
