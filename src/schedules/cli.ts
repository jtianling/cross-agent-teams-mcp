import { z } from 'zod'
import { isIP } from 'node:net'
import { isLoopbackHost } from '../daemon/network-origin.js'
import { patchSchema, planInputSchema, ruleSchema } from './schema.js'

const BASE = '/api/schedules'
const CONFIG_FLAGS = [
  '--name', '--team', '--agent', '--prompt', '--kind', '--at',
  '--every-seconds', '--start-at', '--time', '--timezone',
  '--weekday', '--day', '--count',
]
const CONNECTION_FLAGS = ['--port', '--pid-file']
const USAGE = 'usage: cross-agent-teams-mcp schedules ' +
  '<add|list|show|update|pause|resume|remove|runs> [--id <uuid>] ' +
  '[--kind <once|interval|daily|weekly|monthly>] [options]'

function schedule(flags: Record<string, string>) {
  const kind = flags['--kind']
  const timezone = flags['--timezone'] ??
    Intl.DateTimeFormat().resolvedOptions().timeZone
  const calendar = { time: flags['--time'], timezone }
  const rules: Record<string, unknown> = {
    once: { kind, at: flags['--at'] },
    interval: { kind, every_seconds: Number(flags['--every-seconds']),
      start_at: flags['--start-at'] },
    daily: { kind, ...calendar },
    weekly: { kind, ...calendar, weekday: Number(flags['--weekday']) },
    monthly: { kind, ...calendar, day: Number(flags['--day']) },
  }
  const allowed: Record<string, string[]> = {
    once: ['--at'], interval: ['--every-seconds', '--start-at'],
    daily: ['--time', '--timezone'],
    weekly: ['--time', '--timezone', '--weekday'],
    monthly: ['--time', '--timezone', '--day'],
  }
  for (const key of ['--at', '--every-seconds', '--start-at', '--time',
    '--timezone', '--weekday', '--day']) {
    if (key in flags && !allowed[kind]?.includes(key)) {
      throw new Error(`Unexpected ${key} for ${kind}`)
    }
  }
  return ruleSchema.parse(rules[kind])
}

function config(flags: Record<string, string>, adding: boolean) {
  const fieldFlags = { name: '--name', to_team: '--team',
    to_agent_name: '--agent', prompt: '--prompt' }
  const fields = Object.fromEntries(Object.entries(fieldFlags)
    .filter(([, flag]) => flags[flag] !== undefined)
    .map(([key, flag]) => [key, flags[flag]]))
  const count = flags['--count']
  const maxRuns = count === undefined ? {} : {
    max_runs: count === 'forever' ? null : Number(count),
  }
  const timeFlags = ['--at', '--every-seconds', '--start-at', '--time',
    '--timezone', '--weekday', '--day']
  if (!flags['--kind'] && timeFlags.some(key => key in flags)) {
    throw new Error('Changing schedule fields requires --kind')
  }
  const input = { ...fields, ...maxRuns,
    ...(flags['--kind'] ? { schedule: schedule(flags) } : {}),
  }
  return adding ? planInputSchema.parse(input) : patchSchema.parse(input)
}

export function parseScheduleArgs(argv: readonly string[]): {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown
} {
  const [command, ...rest] = argv
  const allowed = ['add', 'update'].includes(command)
    ? [...CONFIG_FLAGS, ...(command === 'update' ? ['--id'] : [])]
    : command === 'list' ? [] : ['--id']
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    const value = rest[i + 1]
    if (![...allowed, ...CONNECTION_FLAGS].includes(key) || !value ||
      value.startsWith('--') || key in flags) throw new Error(USAGE)
    flags[key] = value
  }
  if (flags['--port']) z.coerce.number().int().min(1).max(65535)
    .parse(flags['--port'])
  if (command === 'list') return { method: 'GET', path: BASE }
  if (command === 'add') return { method: 'POST', path: BASE,
    body: config(flags, true) }
  const id = z.string().uuid().parse(flags['--id'])
  const path = `${BASE}/${id}`
  if (command === 'show') return { method: 'GET', path }
  if (command === 'runs') return { method: 'GET', path: `${path}/runs` }
  if (command === 'remove') return { method: 'DELETE', path }
  if (command === 'update') return { method: 'PATCH', path,
    body: config(flags, false) }
  if (command === 'pause' || command === 'resume') {
    return { method: 'POST', path: `${path}/${command}` }
  }
  throw new Error(USAGE)
}

export async function runScheduleCli(argv: readonly string[], endpoint: {
  host: string; port?: number; token?: string
}): Promise<unknown> {
  const args = parseScheduleArgs(argv)
  if (!endpoint.port) throw new Error('Daemon port unresolved. Pass --port.')
  if (!isLoopbackHost(endpoint.host) ||
    (endpoint.host !== 'localhost' && isIP(endpoint.host) === 0)) {
    throw new Error('Schedule management requires a loopback daemon host')
  }
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  const response = await fetch(`http://${host}:${endpoint.port}${args.path}`, {
    method: args.method,
    headers: {
      ...(args.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
    signal: AbortSignal.timeout(40_000),
  })
  const result: unknown = await response.json()
  if (!response.ok) throw new Error(`Schedule request failed (${response.status}): ` +
    JSON.stringify(result))
  return result
}
