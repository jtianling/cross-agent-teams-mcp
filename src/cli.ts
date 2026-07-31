#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './daemon/server.js'
import { wireShutdown } from './daemon/shutdown.js'
import { acquirePidFile } from './daemon/pid.js'
import { selectPort } from './daemon/port.js'
import { resolveLocalDeviceLabel } from './daemon/local-device.js'
import { isLoopbackHost } from './daemon/network-origin.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

function parseArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}

function defaultHome(): string {
  return process.env.CROSS_AGENT_TEAMS_MCP_HOME ?? join(homedir(), '.cross-agent-teams-mcp')
}

export interface DaemonCliArgs {
  pidPath: string
  dbPath: string
  token?: string
  requestedPort: number
  host: string
  localDevice: string
  loopbackCompanion: boolean
}

export function parseDaemonCliArgs(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): DaemonCliArgs {
  const originalArgv = process.argv
  try {
    process.argv = [...argv]
    const home = env.CROSS_AGENT_TEAMS_MCP_HOME ?? defaultHome()
    const tokenExplicit = parseArg('--token')
    const token = tokenExplicit ?? env.CROSS_AGENT_TEAMS_MCP_TOKEN
    const host = parseArg('--host', '127.0.0.1') ?? '127.0.0.1'
    const localDevice = resolveLocalDeviceLabel(parseArg('--device'))
    const requestedPort = Number(parseArg('--port', '9100'))
    const loopbackCompanion = !process.argv.includes('--no-loopback-companion')
    return {
      pidPath: parseArg('--pid-file', join(home, 'daemon.pid'))!,
      dbPath: parseArg('--db', join(home, 'data.db'))!,
      token,
      requestedPort,
      host,
      localDevice,
      loopbackCompanion,
    }
  } finally {
    process.argv = originalArgv
  }
}

async function runDaemon(): Promise<void> {
  const args = parseDaemonCliArgs()
  if (!isLoopbackHost(args.host) && (!args.token || args.token.trim().length === 0)) {
    console.error('token_required_for_non_loopback_bind')
    process.exit(1)
  }
  const requested = args.requestedPort
  const port = requested === 0 ? 0 : await selectPort([requested, requested + 1, requested + 2])
  const r = acquirePidFile(args.pidPath, port || requested)
  if (!r.ok) { console.error('daemon already running pid=' + r.pid); process.exit(1) }
  const started = await startServer({
    dbPath: args.dbPath,
    token: args.token,
    port,
    host: args.host,
    localDevice: args.localDevice,
    loopbackCompanion: args.loopbackCompanion,
  })
  const companion = started.loopbackCompanion
  wireShutdown(started.app, args.pidPath, {
    extraForceClose: companion
      ? () => { try { companion.closeAllConnections() } catch { /* best-effort */ } }
      : undefined,
  })
  const companionSuffix = companion ? ` (+ 127.0.0.1:${started.port} loopback companion)` : ''
  console.log(`listening on ${started.host}:${started.port}${companionSuffix} device=${args.localDevice}`)
}

function resolveDaemonPort(explicit: string | undefined): number | undefined {
  if (explicit !== undefined) {
    const n = Number(explicit)
    if (Number.isInteger(n) && n > 0) return n
    return undefined
  }
  const pidPath = parseArg('--pid-file', join(defaultHome(), 'daemon.pid'))!
  if (!existsSync(pidPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as { port?: number }
    if (typeof parsed.port === 'number' && parsed.port > 0) return parsed.port
  } catch { /* ignore corrupt pid file */ }
  return undefined
}

const IDENTITY_KEY_ENV_DEFAULT = 'XATS_IDENTITY_KEY'

// The key must never appear on any argv (process-visible), so the flag names
// an environment variable instead of carrying the value. A following token
// starting with `--` is the next flag, not a variable name.
function parseIdentityKeyEnvFlag(
  argv: readonly string[]
): { present: false } | { present: true; varName: string } {
  const i = argv.indexOf('--identity-key-env')
  if (i < 0) return { present: false }
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('--')) {
    return { present: true, varName: IDENTITY_KEY_ENV_DEFAULT }
  }
  return { present: true, varName: next }
}

const PRE_REGISTER_FLAGS = new Set([
  '--pane', '--agent-id', '--ttl', '--identity-key-env', '--port', '--token',
])

/**
 * Every flag is looked up by name, so an unrecognised one would simply never
 * be read — the command would succeed while silently doing less than the
 * caller asked.  That is how a launcher passing `--identity-key-env` to a
 * daemon build that predates the flag got `{"ok":true}` with the key dropped,
 * and why its own degrade-and-retry branch never fired: the call had not
 * failed.  An unknown flag is therefore a hard error, so callers learn from
 * the exit status that this build cannot do what they asked.
 */
function rejectUnknownPreRegisterFlags(argv: readonly string[]): void {
  const unknown = argv
    .slice(3)
    .filter(arg => arg.startsWith('--') && !PRE_REGISTER_FLAGS.has(arg))
  if (unknown.length === 0) return
  console.error(JSON.stringify({
    ok: false,
    error: 'invalid_arguments',
    detail: `unknown flag(s): ${unknown.join(', ')}`,
  }))
  process.exit(2)
}

async function runPreRegisterCodexPane(): Promise<void> {
  rejectUnknownPreRegisterFlags(process.argv)
  const pane = parseArg('--pane')
  const agentId = parseArg('--agent-id')
  const ttlRaw = parseArg('--ttl')
  const keyEnvFlag = parseIdentityKeyEnvFlag(process.argv)
  const tokenExplicit = parseArg('--token')
  const portExplicit = parseArg('--port')

  if (!pane || !agentId) {
    console.error('usage: cross-agent-teams-mcp pre-register-codex-pane --pane <pane_id> --agent-id <uuid> [--identity-key-env [VAR]] [--ttl <seconds>] [--port <n>] [--token <t>]')
    process.exit(2)
  }

  // Fail fast locally: a missing or empty env value with the flag present is
  // always invalid, so the daemon is never contacted for it.
  let identityKey: string | undefined
  if (keyEnvFlag.present) {
    const value = process.env[keyEnvFlag.varName]
    if (value === undefined || value.trim().length === 0) {
      console.error(JSON.stringify({
        ok: false,
        error: 'invalid_arguments',
        detail: `identity_key env ${keyEnvFlag.varName} is missing or empty`,
      }))
      process.exit(2)
    }
    identityKey = value
  }

  const port = resolveDaemonPort(portExplicit)
  if (!port) {
    console.error('{"ok":false,"error":"daemon_port_unresolved","detail":"pass --port or start the daemon so the pid file is present"}')
    process.exit(1)
  }

  const token = tokenExplicit ?? process.env.CROSS_AGENT_TEAMS_MCP_TOKEN
  const host = process.env.CROSS_AGENT_TEAMS_MCP_HOST ?? '127.0.0.1'
  const base = new URL(`http://${host}:${port}/mcp`)

  const requestInit: RequestInit | undefined = token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined

  const transport = new StreamableHTTPClientTransport(base, {
    requestInit,
  })
  const client = new Client({ name: 'cross-agent-teams-mcp-cli', version: '0.1.0' })

  try {
    await client.connect(transport)
    const args: Record<string, unknown> = {
      pane_id: pane,
      xats_agent_id: agentId,
    }
    if (identityKey !== undefined) {
      args.identity_key = identityKey
    }
    if (ttlRaw !== undefined) {
      const ttl = Number(ttlRaw)
      if (!Number.isInteger(ttl) || ttl <= 0) {
        console.error('{"ok":false,"error":"invalid_ttl"}')
        process.exit(2)
      }
      args.ttl_seconds = ttl
    }
    const resp = await client.callTool({
      name: 'pre_register_codex_pane',
      arguments: args,
    })
    const content = (resp as { content?: Array<{ text?: string }> }).content
    const text = content?.[0]?.text ?? ''
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
    const obj = (parsed ?? {}) as Record<string, unknown>
    if (obj.ok === true) {
      console.log(JSON.stringify(obj))
      process.exit(0)
    }
    console.error(JSON.stringify(obj))
    process.exit(1)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({ ok: false, error: 'cli_failed', detail: msg }))
    process.exit(1)
  } finally {
    try { await transport.close() } catch { /* best-effort */ }
    try { await client.close() } catch { /* best-effort */ }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'daemon') {
    await runDaemon()
    return
  }
  if (cmd === 'pre-register-codex-pane') {
    await runPreRegisterCodexPane()
    return
  }
  console.error('usage: cross-agent-teams-mcp <daemon|pre-register-codex-pane> [options]')
  process.exit(2)
}

function isEntry(): boolean {
  if (process.argv[1] === undefined) return false
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
}

if (isEntry()) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })
}
