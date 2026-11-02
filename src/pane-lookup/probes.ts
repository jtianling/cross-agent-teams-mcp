import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import { normalizeTty } from '../daemon/pid-tty.js'
import { tmuxCoordinatesSchema } from './schema.js'

const exec = promisify(execFile)
const PROBE_TIMEOUT_MS = 3000
const PROBE_MAX_BYTES = 1024 * 1024
const FIELD_SEPARATOR = '|'
const PANE_FORMAT = [
  '#{socket_path}', '#{pid}', '#{start_time}', '#{pane_id}',
  '#{pane_pid}', '#{pane_tty}',
].join(FIELD_SEPARATOR)

export class PaneProbeError extends Error {
  constructor(readonly reason: string, cause?: unknown) {
    super(reason, { cause })
  }
}

export interface SocketSnapshot {
  path: string
  device: number
  inode: number
  uid: number
}
export interface PaneSnapshot {
  socket_path: string
  server_pid: number
  server_started_at: number
  pane_id: string
  pane_pid: number
  tty: string
}
export interface ProcessSnapshot {
  pid: number
  pgid: number
  tpgid: number
  tty: string
  started_at: number
  stat: string
  command: string
}
export interface PaneProbes {
  socket(path: string): Promise<SocketSnapshot>
  panes(socket: SocketSnapshot): Promise<PaneSnapshot[]>
  process(pid: number): Promise<ProcessSnapshot | undefined>
}

function probeEnvironment(): NodeJS.ProcessEnv {
  const { TMUX: _tmux, TMUX_PANE: _pane, ...rest } = process.env
  return { ...rest, LC_ALL: 'C', TZ: 'UTC' }
}

async function inspectSocket(path: string): Promise<SocketSnapshot> {
  try {
    const canonical = await realpath(path)
    const info = await stat(canonical)
    if (!info.isSocket() || !process.getuid || info.uid !== process.getuid()) {
      throw new PaneProbeError('socket_not_owned_unix_socket')
    }
    return { path: canonical, device: info.dev, inode: info.ino, uid: info.uid }
  } catch (error) {
    if (error instanceof PaneProbeError) throw error
    throw new PaneProbeError('socket_inspection_failed', error)
  }
}

const integerText = z.string().regex(/^\d+$/).transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
const paneRowSchema = z.tuple([
  tmuxCoordinatesSchema.shape.socket_path, integerText, integerText,
  z.string().regex(/^%\d+$/), integerText, z.string().min(1),
])

export function parsePaneFields(line: string): z.infer<typeof paneRowSchema> {
  const fields = line.split(FIELD_SEPARATOR)
  const parsed = paneRowSchema.safeParse([
    fields.slice(0, -5).join(FIELD_SEPARATOR), ...fields.slice(-5),
  ])
  if (!parsed.success) throw new PaneProbeError('tmux_response_invalid')
  return parsed.data
}

async function inspectPanes(socket: SocketSnapshot): Promise<PaneSnapshot[]> {
  let stdout: string
  try {
    const result = await exec('tmux', [
      '-S', socket.path, 'list-panes', '-a', '-F', PANE_FORMAT,
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES,
      env: probeEnvironment() })
    stdout = result.stdout
  } catch (error) {
    throw new PaneProbeError('tmux_query_failed', error)
  }
  return Promise.all(stdout.split('\n').filter(Boolean).map(async line => {
    const [path, pid, started, pane, panePid, tty] = parsePaneFields(line)
    const normalized = normalizeTty(tty)
    if (!normalized) throw new PaneProbeError('pane_tty_missing')
    try {
      return { socket_path: await realpath(path), server_pid: pid,
        server_started_at: started, pane_id: pane, pane_pid: panePid,
        tty: normalized }
    } catch (error) {
      throw new PaneProbeError('reported_socket_inspection_failed', error)
    }
  }))
}

const processSchema = z.object({
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  pgid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tpgid: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
  tty: z.string(), started_at: z.number().finite(),
  stat: z.string().min(1), command: z.string().min(1),
}).strict()
const PROCESS_PATTERN = new RegExp(
  /^(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+/.source
  + /(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/.source
)

export function parseProcessSnapshot(line: string): ProcessSnapshot | undefined {
  const match = line.trim().match(PROCESS_PATTERN)
  if (!match) return undefined
  const tty = normalizeTty(match[4]) ?? ''
  const started = Date.parse(`${match[5]} UTC`)
  if (!Number.isFinite(started)) return undefined
  const parsed = processSchema.safeParse({
    pid: Number(match[1]), pgid: Number(match[2]), tpgid: Number(match[3]),
    tty, started_at: started, stat: match[6], command: match[7],
  })
  return parsed.success ? parsed.data : undefined
}

async function inspectProcess(pid: number): Promise<ProcessSnapshot | undefined> {
  let stdout: string
  try {
    const result = await exec('ps', [
      '-p', String(pid), '-o', 'pid=,pgid=,tpgid=,tty=,lstart=,stat=,args=',
    ], { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES,
      env: probeEnvironment() })
    stdout = result.stdout
  } catch (error) {
    const missing = z.object({ code: z.literal(1), stdout: z.literal(''),
      stderr: z.literal('') }).safeParse(error)
    if (missing.success) return undefined
    throw new PaneProbeError('process_query_failed', error)
  }
  const lines = stdout.split('\n').filter(line => line.trim().length > 0)
  if (lines.length === 0) return undefined
  const parsed = lines.length === 1 ? parseProcessSnapshot(lines[0]) : undefined
  if (!parsed || parsed.pid !== pid) {
    throw new PaneProbeError('process_response_invalid')
  }
  return parsed
}

export const defaultPaneProbes: PaneProbes = {
  socket: inspectSocket, panes: inspectPanes, process: inspectProcess,
}
