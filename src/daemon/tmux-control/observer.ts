import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdtemp, stat } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { probeExecutable } from '../probe-executable.js'
import { ControlReader } from './reader.js'

const exec = promisify(execFile)
const format = '#{pid} #{start_time} #{socket_path}'
const list = "list-panes -a -F '#{pid} #{start_time} #{pane_id} #{pane_tty} #{pane_dead}'"

async function socketKey(path: string) {
  const s = await stat(path, { bigint: true })
  if (!s.isSocket() || s.uid !== BigInt(process.getuid!())) {
    throw new Error('Expected a tmux socket owned by this user')
  }
  return `${s.dev}:${s.ino}`
}

async function lifetime() {
  const dir = await mkdtemp('/tmp/xats-observer-')
  const path = join(dir, 'owner.sock')
  let peer: Socket | undefined
  let listening = true
  const retireListener = () => {
    if (!listening) return
    listening = false
    server.close()
    try { rmSync(dir, { recursive: true, force: true }) }
    catch (error) { console.error('tmux observer directory cleanup failed:', error) }
  }
  const server = createServer(socket => {
    if (peer) { socket.destroy(); return }
    peer = socket
    socket.on('error', () => socket.destroy())
    socket.resume()
    retireListener()
  })
  const close = () => {
    retireListener()
    peer?.destroy()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    return { path, close }
  } catch (error) {
    close()
    throw error
  }
}

async function openObserver(onDisconnect: () => void, sessionsChanged: () => void) {
  const tmux = probeExecutable('tmux')
  const { stdout } = await exec(tmux, ['-N', 'display-message', '-p', format],
    { timeout: 3000 })
  const match = /^(\d+ \d+) (\/[^\n]+)\n$/.exec(stdout)
  if (!match) throw new Error('Invalid tmux server identity')
  const [, generation, socket] = match
  const key = await socketKey(socket)
  const owner = await lifetime()
  const name = 'xats-observer-' + randomUUID()
  const target = '=' + name + ':'
  const args = ['-S', socket, '-N', '-C', 'new-session', '-E', '-s', name,
    '-f', 'ignore-size,no-output', '/usr/bin/nc', '-d', '-U', owner.path,
    ';', 'set-option', '-p', '-t', target, 'remain-on-exit', 'off',
    ';', 'set-option', '-t', target, 'detach-on-destroy', 'on',
    ';', 'set-option', '-F', '-t', target, '@xats_binding_observer', '#{session_id}']
  const child = spawn(tmux, args, { stdio: 'pipe' })
  const reader = new ControlReader(child, () => {
    owner.close()
    onDisconnect()
  }, sessionsChanged)
  const checkSessions = async () => {
    const rows = await reader.command("list-sessions -F '#{==:#{@xats_binding_observer},#{session_id}}'")
    if (!rows.includes('0')) reader.close(new Error('No business tmux sessions remain'))
  }
  try {
    const proof = '#{session_name} #{pid} #{start_time} #{remain-on-exit} '
      + '#{detach-on-destroy} #{==:#{@xats_binding_observer},#{session_id}}'
    const reply = await reader.command(`display-message -p '${proof}'`)
    if (reply.length !== 1 || reply[0] !== `${name} ${generation} off on 1`) {
      throw new Error('tmux observer identity changed during startup')
    }
    reader.markReady()
    await checkSessions()
    return {
      checkSessions,
      close: () => reader.close(),
      panes: async () => {
        if (await socketKey(socket) !== key) throw new Error('tmux socket changed')
        const lines = await reader.command(list)
        if (await socketKey(socket) !== key) throw new Error('tmux socket changed')
        return lines.map(line => {
          if (!line.startsWith(generation + ' ')) throw new Error('tmux server changed')
          const row = /^(%\d+) (\S*) ([01])$/.exec(line.slice(generation.length + 1))
          if (!row) throw new Error('Invalid tmux pane row')
          return { pane_id: row[1], tty: row[3] === '1' ? '' : row[2].replace(/^\/dev\//, '') }
        })
      },
    }
  } catch (error) {
    reader.close()
    throw error
  }
}

export class BindingObserver {
  private current?: Awaited<ReturnType<typeof openObserver>>
  private tail = Promise.resolve()
  private stopped = false
  private nextAttempt = 0
  private failures = 0

  private checkingSessions = false

  private sessionsChanged() {
    if (this.checkingSessions || this.stopped) return
    this.checkingSessions = true
    this.tail = this.tail.then(async () => {
      this.checkingSessions = false
      try { await this.current?.checkSessions() }
      catch (error) {
        console.error('tmux session inventory failed:', error)
        this.current?.close()
      }
    })
  }

  panes() {
    const result = this.tail.then(async () => {
      if (this.stopped) throw new Error('tmux observer stopped')
      if (Date.now() < this.nextAttempt) throw new Error('tmux observer reconnect deferred')
      try {
        this.current ??= await openObserver(
          () => { this.current = undefined }, () => this.sessionsChanged()
        )
        if (this.stopped) throw new Error('tmux observer stopped')
        const rows = await this.current.panes()
        this.failures = 0
        return rows
      } catch (error) {
        this.current?.close()
        this.current = undefined
        if (!this.stopped) {
          const detail = error instanceof Error ? error.message : String(error)
          console.error(`Codex binding tmux probe failed: ${detail}`)
        }
        this.nextAttempt = Date.now() + Math.min(30000, 1000 * 2 ** this.failures++)
        throw error
      }
    })
    this.tail = result.then(() => {}, () => {})
    return result
  }

  async close() {
    this.stopped = true
    this.current?.close()
    await this.tail
  }
}
