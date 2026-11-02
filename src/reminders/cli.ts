import { z } from 'zod'
import { isIP } from 'node:net'
import { watchInputSchema } from './schema.js'
import { isLoopbackHost } from '../daemon/network-origin.js'

const FLAGS = new Set([
  '--list-id', '--team', '--agent', '--id', '--port', '--pid-file',
  '--event', '--tag',
])
const USAGE = 'usage: cross-agent-teams-mcp reminders ' +
  'add --list-id <uuid> --team <team> --agent <name> ' +
  '--event <added|completed|tag> [--tag <name>] | list | remove --id <uuid>'

export function parseReminderArgs(argv: readonly string[]): {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: unknown
} {
  const [command, ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]
    const value = rest[i + 1]
    if (!FLAGS.has(key) || !value || value.startsWith('--') || key in flags) {
      throw new Error(`Invalid argument ${key}. ${USAGE}`)
    }
    flags[key] = value
  }
  const allowed = command === 'add'
    ? ['--list-id', '--team', '--agent', '--event', '--tag']
    : command === 'remove' ? ['--id'] : []
  for (const key of Object.keys(flags)) {
    if (!allowed.includes(key) && key !== '--port' && key !== '--pid-file') {
      throw new Error(`Unexpected argument ${key}. ${USAGE}`)
    }
  }
  if (flags['--port']) z.coerce.number().int().min(1).max(65535)
    .parse(flags['--port'])
  const path = '/api/reminder-watches'
  if (command === 'list') return { method: 'GET', path }
  if (command === 'remove') {
    const id = z.string().uuid().parse(flags['--id'])
    return { method: 'DELETE', path: `${path}/${id}` }
  }
  if (command !== 'add') throw new Error(USAGE)
  return { method: 'POST', path, body: watchInputSchema.parse({
    list_id: flags['--list-id'],
    to_team: flags['--team'],
    to_agent_name: flags['--agent'],
    event: flags['--event'],
    ...(flags['--tag'] === undefined ? {} : { tag: flags['--tag'] }),
  }) }
}

export async function runReminderCli(
  argv: readonly string[],
  endpoint: { host: string; port?: number; token?: string }
): Promise<unknown> {
  const args = parseReminderArgs(argv)
  if (!endpoint.port) throw new Error('Daemon port unresolved. Pass --port.')
  if (!isLoopbackHost(endpoint.host) ||
    (endpoint.host !== 'localhost' && isIP(endpoint.host) === 0)) {
    throw new Error('Reminder management requires a loopback daemon host')
  }
  const host = endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host
  const response = await fetch(`http://${host}:${endpoint.port}${args.path}`, {
    method: args.method,
    headers: {
      ...(args.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
    },
    body: args.body ? JSON.stringify(args.body) : undefined,
    signal: AbortSignal.timeout(40_000),
  })
  const result: unknown = await response.json()
  if (!response.ok) {
    throw new Error(`Reminder request failed (${response.status}): ` +
      JSON.stringify(result))
  }
  return result
}
