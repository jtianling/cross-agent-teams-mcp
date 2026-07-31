import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
  return {
    ...actual,
    isTmuxAvailable: vi.fn(async () => true),
    capturePaneTail: vi.fn(async () => 'idle-tail'),
    loadBuffer: vi.fn(async () => {}),
    pasteBuffer: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    deleteBuffer: vi.fn(async () => {}),
  }
})

import * as tmuxCli from '../src/daemon/tmux-cli.js'
import { tmuxPokeImpl } from '../src/mcp/poke.js'

describe('tmuxPokeImpl re-confirms ownership right before the paste', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.POKE_QUIET_MS = '10'
  })

  it('an ownership flip after load_buffer blocks the paste', async () => {
    // First call passes the pre-write check; the ownership then moves while
    // capture/load await, and the final synchronous check must catch it.
    const answers = [true, false]
    const confirmOwnership = vi.fn(() => answers.shift() ?? false)
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
      confirmOwnership,
    })
    expect(result).toEqual({ error: 'pane_reassigned' })
    expect(confirmOwnership).toHaveBeenCalledTimes(2)
    expect(vi.mocked(tmuxCli.loadBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    // The loaded-but-never-pasted buffer must not leak: the abort deletes it.
    expect(vi.mocked(tmuxCli.deleteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.deleteBuffer).mock.calls[0][0]).toMatch(/^poke-/)
  })

  it('an ownership flip during the paste settle blocks the Enter', async () => {
    // Pre-write and pre-paste checks pass; ownership is then lost inside the
    // 400ms settle window. The paste already landed but the Enter must not be
    // sent — pasted-but-unexecuted text is acceptable, executing it is not.
    const answers = [true, true, false]
    const confirmOwnership = vi.fn(() => answers.shift() ?? false)
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
      confirmOwnership,
    })
    expect(result).toEqual({ error: 'ownership_lost' })
    expect(confirmOwnership).toHaveBeenCalledTimes(3)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    // paste-buffer -d already consumed the buffer; nothing left to delete.
    expect(vi.mocked(tmuxCli.deleteBuffer)).not.toHaveBeenCalled()
  })

  it('a paste-buffer failure deletes the loaded buffer best-effort', async () => {
    vi.mocked(tmuxCli.pasteBuffer).mockRejectedValueOnce(new Error('boom'))
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
      confirmOwnership: () => true,
    })
    expect(result).toMatchObject({ error: 'tmux_cmd_failed' })
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.deleteBuffer)).toHaveBeenCalledTimes(1)
  })

  it('a delete-buffer failure on the abort path does not mask the abort', async () => {
    vi.mocked(tmuxCli.deleteBuffer).mockRejectedValueOnce(new Error('no buffer'))
    const answers = [true, false]
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'secret-body',
      skipGuard: true,
      confirmOwnership: () => answers.shift() ?? false,
    })
    // Primary abort untouched, but the leaked buffer is surfaced by name —
    // never by content.
    expect(result).toMatchObject({
      error: 'pane_reassigned',
      detail: { buffer_cleanup_failed: expect.stringMatching(/^poke-/) },
    })
    expect(JSON.stringify(result)).not.toContain('secret-body')
  })

  it('a delete-buffer failure on a stage error keeps the primary error', async () => {
    vi.mocked(tmuxCli.pasteBuffer).mockRejectedValueOnce(new Error('boom'))
    vi.mocked(tmuxCli.deleteBuffer).mockRejectedValueOnce(new Error('no buffer'))
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'secret-body',
      skipGuard: true,
      confirmOwnership: () => true,
    })
    expect(result).toMatchObject({
      error: 'tmux_cmd_failed',
      detail: {
        buffer_cleanup_failed: expect.stringMatching(/^poke-/),
        cause: { stage: 'paste_buffer', stderr: 'boom' },
      },
    })
    expect(JSON.stringify(result)).not.toContain('secret-body')
  })

  it('stable ownership pastes normally', async () => {
    const confirmOwnership = vi.fn(() => true)
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
      confirmOwnership,
    })
    expect(result).toMatchObject({ ok: true })
    expect(confirmOwnership).toHaveBeenCalledTimes(3)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
  })
})
