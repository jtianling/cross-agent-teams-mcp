import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { isAlive } from '../../../src/daemon/pid.js'
import { agyLaunchIdSchema } from '../../../src/lib/delivery-spec.js'

const label = z.string().min(1).refine(s => s === s.trim())
const launch = z.object({
  agy_launch_id: agyLaunchIdSchema,
  name: label,
  team: label,
  identity_key: z.string().min(1).optional(),
})
export type Launch = z.infer<typeof launch>
export type DeferredOwner = { pid: number, launchId: string, key: string }
const slotKey = z.string().refine(value => {
  const bytes = Buffer.byteLength(value)
  return bytes >= 16 && bytes <= 256
}, 'Expected a slot key of 16-256 UTF-8 bytes')

const exec = promisify(execFile)
async function readAncestor(pid: number) {
  const darwin = process.platform === 'darwin'
  const format = darwin ? 'ppid=,ucomm=' : 'ppid=,comm='
  const { stdout } = await exec('/bin/ps', ['-p', String(pid), '-o', format],
    { timeout: 1500 })
  const match = /^(\d+)\s+(.+)$/.exec(stdout.trim())
  if (!match) throw new Error('Cannot identify ancestor process ' + pid)
  const image = darwin ? match[2]
    : (await readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '')
  return { parent: Number(match[1]), executable: basename(image) }
}

export function getLaunch(env: NodeJS.ProcessEnv) {
  if (!env.XATS_AGY_LAUNCH_ID || !env.XATS_AGY_PID) return
  const deferred = env.XATS_AGY_DEFER_REGISTRATION === '1'
  const key = slotKey.safeParse(env.XATS_AGY_IDENTITY_KEY)
  if (deferred && !key.success) return
  if (!deferred && (!env.XATS_AGY_NAME || !env.XATS_AGY_TEAM)) return
  const pid = z.string().regex(/^[1-9]\d*$/).pipe(
    z.coerce.number().int().safe().gt(1),
  ).parse(env.XATS_AGY_PID)
  if (deferred && key.success) {
    return { mode: 'deferred' as const, pid,
      launchId: agyLaunchIdSchema.parse(env.XATS_AGY_LAUNCH_ID),
      key: key.data }
  }
  const fields = launch.parse({
    agy_launch_id: env.XATS_AGY_LAUNCH_ID,
    name: env.XATS_AGY_NAME,
    team: env.XATS_AGY_TEAM,
    identity_key: env.XATS_AGY_IDENTITY_KEY || undefined,
  })
  return { mode: 'named' as const, fields, pid }
}

export async function ownsLaunch(pid: number) {
  let parent = process.ppid
  const seen = new Set<number>()
  while (parent > 1 && !seen.has(parent)) {
    seen.add(parent)
    const row = await readAncestor(parent)
    if (row.executable === 'agy' || row.executable === 'antigravity') {
      return parent === pid
    }
    if (parent === pid) return false
    parent = row.parent
  }
  return false
}

function loopbackUrl(raw: string): URL {
  const invalid = 'CROSS_AGENT_TEAMS_MCP_URL must be a loopback HTTP(S) /mcp URL'
  const authority = /^https?:\/\/([^/@?#\\\s]+)\/mcp$/.exec(raw)?.[1]
  if (!authority || !URL.canParse(raw)) throw new Error(invalid)
  const url = new URL(raw)
  const host = authority.replace(/:\d+$/, '').toLowerCase()
  const local = host === 'localhost' || url.hostname === '[::1]'
    || (isIPv4(host) && host.startsWith('127.'))
  if (!local || url.port === '0') throw new Error(invalid)
  return url
}

const pidRecord = z.object({
  pid: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
})

export async function daemonUrl(env: NodeJS.ProcessEnv): Promise<URL> {
  if (env.CROSS_AGENT_TEAMS_MCP_URL !== undefined) {
    return loopbackUrl(env.CROSS_AGENT_TEAMS_MCP_URL)
  }
  const home = env.CROSS_AGENT_TEAMS_MCP_HOME
    ?? join(homedir(), '.cross-agent-teams-mcp')
  const path = join(home, 'daemon.pid')
  const record = pidRecord.parse(JSON.parse(await readFile(path, 'utf8')))
  if (!isAlive(record.pid)) throw new Error('Stale daemon.pid: process is not alive')
  return new URL(`http://127.0.0.1:${record.port}/mcp`)
}
