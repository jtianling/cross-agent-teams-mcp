import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
  return {
    ...actual,
    isTmuxAvailable: vi.fn(async () => true),
    capturePaneTail: vi.fn(async () => 'tail'),
    loadBuffer: vi.fn(async () => {}),
    pasteBuffer: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    deleteBuffer: vi.fn(async () => {}),
  }
})

import * as tmuxCli from '../src/daemon/tmux-cli.js'
import { tmuxPokeImpl } from '../src/mcp/poke.js'
import {
  isCodexComposerReady,
  PROMPT_NOT_READY,
} from '../src/mcp/codex-prompt-readiness.js'

// The observed 2026-08-31 incident: codex's startup update menu blocks on a
// keypress, so the pane is MORE motionless than a live prompt and the quiet
// guard passes on it.
const UPDATE_MENU_TAIL = [
  'Update available! 0.150.0 -> 0.151.0',
  '  1. Update now (runs npm install -g @openai/codex)',
  '  2. Skip this version',
  'Press enter to continue',
].join('\n')

const IDLE_COMPOSER_TAIL = [
  '  Worked for 12s',
  '',
  '› Ask Codex to do anything',
  '  ? for shortcuts',
].join('\n')

describe('codex composer readiness predicate', () => {
  it('accepts an idle composer', () => {
    expect(isCodexComposerReady(IDLE_COMPOSER_TAIL)).toBe(true)
  })

  it('accepts a prompt line that the TUI indented', () => {
    expect(isCodexComposerReady('   › hello')).toBe(true)
  })

  it('accepts a composer that already holds a draft', () => {
    // The prompt prefix renders whether or not the composer is empty; emptiness
    // could only be read off the placeholder, which codex randomises.
    expect(isCodexComposerReady('› half a sentence')).toBe(true)
  })

  it('refuses a blocking startup menu', () => {
    expect(isCodexComposerReady(UPDATE_MENU_TAIL)).toBe(false)
  })

  it('refuses bash mode, whose prompt prefix is not the composer one', () => {
    expect(isCodexComposerReady('! ls -la')).toBe(false)
  })

  it('refuses the glyph appearing mid-line in scrolled content', () => {
    expect(isCodexComposerReady('the docs say › means the prompt')).toBe(false)
  })

  it('refuses an empty or whitespace-only tail', () => {
    expect(isCodexComposerReady('')).toBe(false)
    expect(isCodexComposerReady('   \n\t\n')).toBe(false)
  })
})

describe('tmuxPokeImpl readiness option', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.POKE_QUIET_MS = '10'
  })

  it('a caller supplying no predicate runs the unchanged sequence', async () => {
    // The pane tail is not a codex composer; a caller that asked for no
    // readiness evidence must still be delivered exactly as before.
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
    })
    expect(result).toEqual({
      ok: true,
      pane_tail_before: 'tail',
      pane_tail_after: 'tail',
    })
    expect(vi.mocked(tmuxCli.loadBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tmuxCli.sendEnter)).toHaveBeenCalledTimes(1)
  })

  it('a refusing predicate writes nothing at all', async () => {
    vi.mocked(tmuxCli.capturePaneTail).mockResolvedValue(UPDATE_MENU_TAIL)
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
      requireReady: isCodexComposerReady,
    })
    expect(result).toEqual({ error: PROMPT_NOT_READY })
    expect(result).not.toEqual({ error: 'guard_failed' })
    // Not even the buffer is loaded, so there is nothing to leak or delete.
    expect(vi.mocked(tmuxCli.loadBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.deleteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
  })

  it('the predicate is evaluated on the capture the primitive already takes', async () => {
    vi.mocked(tmuxCli.capturePaneTail).mockResolvedValue(IDLE_COMPOSER_TAIL)
    const requireReady = vi.fn(() => true)
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
      requireReady,
    })
    expect(result).toMatchObject({ ok: true })
    expect(requireReady).toHaveBeenCalledWith(IDLE_COMPOSER_TAIL)
    // One pre-write capture and one after the Enter: no extra tmux call.
    expect(vi.mocked(tmuxCli.capturePaneTail)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(tmuxCli.pasteBuffer)).toHaveBeenCalledTimes(1)
  })

  it('an unreadable pre-write capture never reaches the predicate or a write', async () => {
    vi.mocked(tmuxCli.capturePaneTail).mockRejectedValueOnce(new Error('timed out'))
    const requireReady = vi.fn(() => true)
    const result = await tmuxPokeImpl({
      pane_id: '%9',
      content: 'hello',
      skipGuard: true,
      requireReady,
    })
    expect(result).toMatchObject({ error: 'tmux_cmd_failed' })
    expect(requireReady).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.pasteBuffer)).not.toHaveBeenCalled()
    expect(vi.mocked(tmuxCli.sendEnter)).not.toHaveBeenCalled()
  })
})
