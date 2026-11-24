import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { isIP } from 'node:net'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'

const pidSchema = z.object({ pid: z.number().int().positive(),
  port: z.number().int().min(0).max(65535) }).strict()
const configSchema = z.object({ node: z.string().min(1),
  host: z.string().refine(value => value === 'localhost' || isIP(value) > 0),
  port: z.number().int().min(0).max(65535), device: z.string().min(1),
  db: z.string().min(1), token: z.string().min(1), companion: z.boolean() })

export function configuration(argv, repository) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    repo: { type: 'string', default: repository },
    'state-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) return null
  const repo = realpathSync(resolve(values.repo))
  if (!z.object({ name: z.literal('cross-agent-teams-mcp') })
    .safeParse(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))).success) {
    throw new Error('Repository is not cross-agent-teams-mcp')
  }
  const custom = values['state-dir'] !== undefined
  if (custom && repo === realpathSync(repository)) {
    throw new Error('--state-dir requires --repo pointing at an isolated repository')
  }
  const state = resolve(values['state-dir'] ?? process.env.CROSS_AGENT_TEAMS_MCP_HOME
    ?? join(homedir(), '.cross-agent-teams-mcp'))
  const config = custom ? state : join(homedir(), '.config/xats')
  return { repo, state, pidFile: join(state, 'daemon.pid'),
    wrapperPid: custom ? join(state, 'local-daemon.pid') : join(config, 'local/daemon.pid'),
    log: join(config, custom ? 'daemon.log' : 'local-daemon.log'),
    tokenFile: join(config, 'token'), custom }
}

export function readPid(path) {
  if (!existsSync(path)) return null
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) }
  catch { throw new Error(`Invalid daemon PID file: ${path}`) }
  const result = pidSchema.safeParse(parsed)
  if (!result.success) throw new Error(`Invalid daemon PID metadata: ${path}`)
  return result.data
}

export function processInfo(pid) {
  try { process.kill(pid, 0) }
  catch (error) {
    if (error.code === 'ESRCH') return null
    throw new Error(`Cannot inspect daemon PID ${pid}: ${error.code}`)
  }
  let stat, command, started
  try {
    stat = execFileSync('ps', ['-p', String(pid), '-o', 'stat='],
      { encoding: 'utf8', timeout: 3000 }).trim()
    command = execFileSync('ps', ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', timeout: 3000 }).trim()
    started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 3000 }).trim()
  } catch (error) {
    if (error.status === 1 && !String(error.stdout).trim()) return null
    throw error
  }
  if (stat.startsWith('Z')) return null
  return { command, started }
}

function nodeExecutable(first, pid) {
  if (isAbsolute(first) && basename(first) === 'node') return realpathSync(first)
  const result = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
    { encoding: 'utf8', timeout: 3000 })
  const paths = [...new Set(result.split('\n').filter(line => line.startsWith('n')
    && basename(line.slice(1)) === 'node').map(line => line.slice(1)))]
  if (paths.length !== 1) throw new Error('Cannot verify the running Node executable')
  return realpathSync(paths[0])
}

export function inspectDaemon(config, metadata) {
  const current = processInfo(metadata.pid)
  if (!current) return null
  const entry = join(config.repo, 'dist/cli.js')
  const marker = ` ${entry} daemon`
  const offset = current.command.indexOf(marker)
  if (offset <= 0 || !/^(?:\s|$)/.test(current.command.slice(offset + marker.length))) {
    throw new Error('PID file points at a different process; refusing to stop it')
  }
  const first = current.command.slice(0, offset)
  if (first.includes(' ') || basename(first) !== 'node') {
    throw new Error('Unsupported daemon executable; refusing to stop it')
  }
  const args = current.command.slice(offset + marker.length).trim().split(/\s+/).filter(Boolean)
  const flags = {}
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]
    if (key === '--no-loopback-companion') { flags[key] = true; continue }
    if (!['--db', '--pid-file', '--host', '--port', '--device', '--token'].includes(key)
      || flags[key] !== undefined || args[index + 1] === undefined) {
      throw new Error('Unsupported daemon launch arguments; original service preserved')
    }
    flags[key] = args[++index]
  }
  if (flags['--pid-file'] && resolve(flags['--pid-file']) !== config.pidFile) {
    throw new Error('Daemon PID file does not match the requested instance')
  }
  if ((flags['--db'] && !isAbsolute(flags['--db'])) || !flags['--device']) {
    throw new Error('Running daemon requires explicit absolute --db or a verified default database, and --device')
  }
  const fallback = coldLaunch(config, flags['--token'])
  if (!flags['--db']) {
    const owners = execFileSync('lsof', ['-a', '-p', String(metadata.pid),
      '-t', '--', fallback.db], { encoding: 'utf8', timeout: 3000 }).trim().split('\n')
    if (!owners.includes(String(metadata.pid))) {
      throw new Error('Cannot verify the original daemon default database')
    }
  }
  const launch = configSchema.safeParse({ ...fallback,
    node: nodeExecutable(first, metadata.pid), port: metadata.port,
    db: flags['--db'] ?? fallback.db, host: flags['--host'] ?? '127.0.0.1',
    device: flags['--device'] ?? fallback.device,
    token: flags['--token'] ?? fallback.token,
    companion: !flags['--no-loopback-companion'] })
  if (!launch.success || metadata.port === 0) throw new Error('Invalid current daemon configuration')
  return { metadata, current, launch: launch.data }
}

export function coldLaunch(config, override) {
  const token = override ?? (existsSync(config.tokenFile)
    ? readFileSync(config.tokenFile, 'utf8').trim()
    : process.env.CROSS_AGENT_TEAMS_MCP_TOKEN)
  if (!token?.trim()) throw new Error(`Existing daemon token required: ${config.tokenFile}`)
  return { node: process.execPath, host: config.custom ? '127.0.0.1' : '0.0.0.0',
    port: config.custom ? 0 : 9100,
    device: config.custom ? process.env.XATS_DEVICE
      ?? hostname().toLowerCase().replace(/[^a-z0-9_-]/g, '-') : 'jt',
    db: join(config.state, 'data.db'), token, companion: true }
}

export function replacementLaunch(config, target) {
  if (config.custom && target) return target.launch
  return { ...coldLaunch(config, target?.launch.token),
    node: target?.launch.node ?? process.execPath }
}
