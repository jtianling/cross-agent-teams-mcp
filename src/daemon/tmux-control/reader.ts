import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const FRAME = /^%(begin|end|error) (\d+ \d+ [01])$/
const LIMIT = 1024 * 1024
const TIMEOUT_MS = 5000
type ControlChild = Pick<ChildProcessWithoutNullStreams,
  'stdin' | 'stdout' | 'stderr' | 'kill'> & NodeJS.EventEmitter
type Reply = { resolve: (lines: string[]) => void; reject: (e: Error) => void }

export class ControlReader {
  private buffer = ''
  private frame?: string
  private lines: string[] = []
  private size = 0
  private pending?: Reply
  private failure?: Error
  private stderr = ''
  private ready = false

  constructor(private child: ControlChild,
    private onClose: (error: Error) => void,
    private sessionsChanged?: () => void) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.receive(chunk))
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-1024) })
    child.once('error', error => this.close(error))
    child.stdin.on('error', error => this.close(error))
    child.once('close', (code, sig) => this.close(new Error(
      `tmux control closed (${code ?? sig}): ${this.stderr.trim()}`)))
  }

  markReady() { this.ready = true }

  close(error = new Error('tmux control stopped')) {
    if (this.failure) return
    this.failure = error
    this.pending?.reject(error)
    this.pending = undefined
    this.child.stdin.destroy()
    this.child.kill()
    this.onClose(error)
  }

  command(command: string): Promise<string[]> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending) return Promise.reject(new Error('Concurrent tmux control command'))
    const timer = setTimeout(() => this.close(new Error('tmux control timeout')), TIMEOUT_MS)
    return new Promise<string[]>((resolve, reject) => {
      this.pending = { resolve, reject }
      this.child.stdin.write(command + '\n')
    }).finally(() => clearTimeout(timer))
  }

  private receive(chunk: string) {
    this.buffer += chunk
    let newline
    while (!this.failure && (newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.line(line)
    }
    if (this.buffer.length > LIMIT) this.close(new Error('Oversized tmux control line'))
  }

  private line(line: string) {
    const mark = FRAME.exec(line)
    if (this.frame === undefined) {
      if (mark?.[1] === 'begin') {
        this.frame = mark[2]
        this.lines = []
        this.size = 0
      } else if (this.ready && line === '%sessions-changed') {
        this.sessionsChanged?.()
      } else if (mark || /^%(?:begin|end|error|exit)(?: |$)/.test(line)) {
        this.close(new Error('Unexpected tmux control notification: ' + line.slice(0, 120)))
      } else if (!line.startsWith('%')) {
        // tmux can write hook diagnostics between numbered frames.
        console.error('tmux control diagnostic:', line.slice(0, 1024))
      }
      return
    }
    if (!mark) {
      this.size += line.length + 1
      if (this.size > LIMIT) this.close(new Error('Oversized tmux control response'))
      else this.lines.push(line)
      return
    }
    if (mark[1] === 'begin' || mark[2] !== this.frame) {
      this.close(new Error('Mismatched tmux control frames'))
      return
    }
    const command = this.frame.endsWith(' 1')
    this.frame = undefined
    if (!command) {
      if (mark[1] === 'error') {
        const detail = this.lines.join('\n')
        console.error('tmux startup or hook command failed:', detail)
      }
      return
    }
    const pending = this.pending
    this.pending = undefined
    if (!pending) this.close(new Error('Unsolicited tmux control reply'))
    else if (mark[1] === 'error') pending.reject(new Error(this.lines.join('\n')))
    else pending.resolve(this.lines)
  }
}
