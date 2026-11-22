import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { ControlReader } from '../src/daemon/tmux-control/reader.js'

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(),
  })
  const close = vi.fn()
  const reader = new ControlReader(child, close)
  const emit = (...lines: string[]) => child.stdout.write(lines.join('\n') + '\n')
  return { emit, reader, close, child }
}

describe('tmux binding control stream', () => {
  it('pairs split command replies across unsolicited initialization frames', async () => {
    const { reader, emit, child } = fixture()
    const result = reader.command('list-panes')
    emit('%begin 1 0 0', 'ignored', '%end 1 0 0', '%session-changed $0 observer')
    child.stdout.write('%beg')
    emit('in 1 2 1', '%12 /dev/ttys001 0', '%end 1 2 1')
    expect(await result).toEqual(['%12 /dev/ttys001 0'])
    reader.close()
  })

  it('keeps a verified control client after a background hook error', async () => {
    const { reader, emit, close } = fixture()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = reader.command('list-panes')
      emit("can't find session: hook-target")
      emit('%begin 2 1 0', 'hook refused', '%error 2 1 0')
      emit('%begin 2 2 1', 'rows', '%end 2 2 1')
      expect(await result).toEqual(['rows'])
      expect(close).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('tmux startup or hook command failed:', 'hook refused')
    } finally { log.mockRestore(); reader.close() }
  })

  it('drops a truncated or cross-paired frame and refuses new reads', async () => {
    const { reader, emit, close } = fixture()
    const result = reader.command('list-panes')
    emit('%begin 1 2 1', 'partial', '%end 1 3 1')
    await expect(result).rejects.toThrow('Mismatched')
    await expect(reader.command('list-panes')).rejects.toThrow('Mismatched')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('propagates an ordinary command refusal without mistaking it for data', async () => {
    const { reader, emit } = fixture()
    const result = reader.command('list-panes')
    emit('%begin 1 2 1', 'no such session', '%error 1 2 1')
    await expect(result).rejects.toThrow('no such session')
    const next = reader.command('list-panes')
    emit('%begin 1 3 1', '%end 1 3 1')
    expect(await next).toEqual([])
    reader.close()
  })
})
