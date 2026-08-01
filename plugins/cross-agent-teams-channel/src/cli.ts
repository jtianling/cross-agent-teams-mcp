#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createProxyServer, relayChannelWake } from './proxy.js'
import { runReconnectingProxy } from './daemon-client.js'

interface CliArgs {
  daemonUrl: string
  token?: string
  // Omitted when the user did not pass --device AND the daemon is on loopback.
  // The daemon then auto-fills its own local label on loopback registrations,
  // which keeps zero-config proxies working against a daemon whose operator
  // chose a custom --device.  For non-loopback daemons the proxy auto-derives
  // a label from os.hostname() (see deviceAutoDerivedNotice).
  device?: string
  // Set when --device was not supplied and we auto-derived one because the
  // daemon is non-loopback.  Surfaced so main() can emit a one-line stderr
  // notice; daemon-side validation may still reject the derived label
  // (e.g. device_spoofing_local_label_from_remote).
  deviceAutoDerivedNotice?: string
  // Opaque per-pane value the launcher minted, read from XATS_IDENTITY_KEY.
  // Env-only on purpose: `.mcp.json` is shared by directory, so a flag would
  // hand every Claude Code instance in that directory the same key. The proxy
  // never puts it on its own row — it only inlines it into the host agent's
  // startup hint.
  identityKey?: string
}

export interface ParseCliArgsDeps {
  hostname?: () => string
}

export class CliArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliArgError'
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '::', '::1'])

export function isNonLoopbackDaemonUrl(daemonUrl: string): boolean {
  try {
    const parsed = new URL(daemonUrl)
    // WHATWG URL keeps IPv6 literals wrapped in brackets in `hostname` —
    // strip them so `::1` matches the loopback set.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === '') return false
    if (LOOPBACK_HOSTS.has(host)) return false
    if (host.startsWith('127.')) return false
    return true
  } catch {
    // Unparseable URL: assume remote so we still try to derive a device label;
    // daemon-client will surface the real connect error shortly.
    return true
  }
}

export function deriveHostnameDeviceLabel(hostnameValue: string): string | null {
  const normalized = hostnameValue
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/^-+|-+$/g, '')
  if (normalized.length === 0 || normalized.length > 64) return null
  return normalized
}

export function buildStartupHint(
  csid: string,
  device?: string,
  identityKey?: string
): { content: string; meta: { source: string; kind: string } } {
  // Local default path (no --device): emit the original same-host hint with NO
  // device-related noise. Pure-local users never need to think about device.
  // Cross-host path (--device passed): surface the device value in both the
  // user-facing ask and the register_agent call so the agent and the human
  // both know it is required (daemon returns device_required_from_remote
  // otherwise).
  const isCrossHost = device !== undefined
  const deviceClause = isCrossHost ? `, device: "${device}"` : ''
  const deviceRegisterFragment = isCrossHost
    ? ` (this proxy is running with --device "${device}", so include device: "${device}" verbatim — the daemon enforces per-origin device validation, and on a remote daemon omitting it returns device_required_from_remote)`
    : ''
  const ask = isCrossHost
    ? `'To join cross-agent-teams (xats) and message other agents, reply with: Register to xats — name: your-agent-name, team: your-team-name (optional; defaults to the current working directory basename), device: ${device} (cross-host setup — keep this value verbatim).'`
    : `'To join cross-agent-teams (xats) and message other agents, reply with: Register to xats — name: your-agent-name, team: your-team-name (optional; defaults to the current working directory basename).'`
  // The value is baked into the call the agent is shown rather than left as
  // "read this env var": a first registration that forgets the key binds
  // nothing, and every later recovery then answers need_register without
  // either side reporting an error.
  // The identity branch closes its own loop and hands off explicitly, and
  // everything after it is gated on that hand-off. An unconditional ask sitting
  // beside it is satisfiable with no tool call at all, which makes it the
  // cheapest complete action in the message — measured, a restarted pane took
  // exactly that action and never attempted recovery.
  const identityBranch = identityKey === undefined ? [] : [
    `This pane carries an identity key: ${identityKey}. Start here. Call reconnect({identity_key: "${identityKey}", ui_pid: $PPID}) — it recovers the identity this pane had before it was restarted, which no other lookup can do once $PPID has changed. If it returns ok you are done: state which identity you recovered, and disregard the rest of this message. Only if it returns need_register does anything below apply, and in that case add identity_key: "${identityKey}" verbatim to that register_agent call and to every later register_agent call — leaving it out silently disables restart recovery for this pane.`
  ]
  // Only meaningful once the identity branch exists: without it there is no
  // earlier step for the rest of the message to be conditional on.
  const gate = identityKey === undefined
    ? ''
    : 'Everything below applies only when the step above returned need_register. '
  const content = [
    `cross-agent-teams-mcp: your channel_session_id is ${csid}. The tools named below may not be directly callable yet — where this host defers them you receive their names without schemas, and a tool has to be loaded before it can be invoked. Load one first if a call below is not directly available.`,
    ...identityBranch,
    `${gate}Do NOT register automatically. First ask the user (in English) to register this session so it can talk to other agents — use exactly this wording: ${ask}`,
    `Once the user provides a name (and optionally a team), call register_agent({agent_type: "claude-code", name: "<name from user>", team: "<team from user, omit if not provided>"${deviceClause}, ui_pid: $PPID, project_dir: "<current working directory>"})${deviceRegisterFragment}. Do NOT pass channel_session_id here; the daemon auto-binds via ui_pid.`,
    // The preference for register_agent here is stated inside this branch's own
    // condition. Phrased as a bare "do NOT call reconnect" it read as a global
    // prohibition sitting a few lines under the identity branch's "call
    // reconnect" — the keyed and unkeyed messages are not a superset relation,
    // and a sentence that is unambiguous without the identity branch can become
    // a contradiction once it is added above.
    `If this is a reconnect (context clear, resume, or channel re-attach), route by whether you still remember your own (team, name): if you DO remember it (for example after closing Claude Code and resuming the conversation, where your $PPID has changed but the context survived), call register_agent({agent_type: "claude-code", name: "<your remembered name>", team: "<your remembered team>"${deviceClause}, ui_pid: $PPID, project_dir: "<current working directory>"}) and then state in your reply which identity you re-registered as — for that case register_agent is the right call rather than reconnect({ui_pid: $PPID}), because a reverse look-up on the changed $PPID would find no match and return need_register. If you do NOT remember your (team, name) (for example after a context clear), call reconnect({ui_pid: $PPID}) to recover your prior (team, name) and rebind to this new csid in one step; on a need_register result, ask the user. bind_channel({channel_session_id: "${csid}"}) only rebinds when your CURRENT MCP session is already bound to your agent; on a fresh or resumed MCP session it returns unknown_agent, so use reconnect (or register_agent with your remembered identity) instead. Neither is the primary first-time registration path.`,
    `Do not use curl or another external HTTP client for Claude registration here — that would create a different MCP session, and follow-up tools in Claude Code could still see unknown_agent.`
  ].join('\n\n')
  return {
    content,
    meta: { source: 'cross_agent_teams_mcp', kind: 'startup_bind_hint' }
  }
}

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: ParseCliArgsDeps = {}
): CliArgs {
  let daemonUrl: string | undefined
  let token: string | undefined
  let explicitDevice: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    switch (flag) {
      case '--daemon-url':
        daemonUrl = next; i++; break
      case '--token':
        token = next; i++; break
      case '--device':
        explicitDevice = next; i++; break
      default:
        // Ignore unknown flags for forward-compat (including legacy
        // --agent-team / --agent-name, which are no longer honored).
        break
    }
  }

  if (!daemonUrl || daemonUrl.length === 0) {
    daemonUrl = env.CROSS_AGENT_TEAMS_MCP_DAEMON_URL
  }
  if (!token || token.length === 0) {
    token = env.CROSS_AGENT_TEAMS_MCP_TOKEN
  }

  if (!daemonUrl || daemonUrl.length === 0) {
    throw new CliArgError(
      'missing --daemon-url (or CROSS_AGENT_TEAMS_MCP_DAEMON_URL env var)'
    )
  }

  // Explicit --device wins. Otherwise: loopback daemons let the daemon
  // auto-fill its own localDevice (zero-config); non-loopback daemons require
  // a device on register_agent — the daemon returns device_required_from_remote
  // when it is missing, which would put the proxy in a register/fail/respawn
  // loop. Auto-derive from os.hostname() with a stderr notice; fail-fast when
  // the hostname yields nothing usable.
  let device: string | undefined
  let deviceAutoDerivedNotice: string | undefined
  if (explicitDevice !== undefined) {
    device = resolveDeviceLabel(explicitDevice)
  } else if (isNonLoopbackDaemonUrl(daemonUrl)) {
    const hostnameFn = deps.hostname ?? hostname
    const derived = deriveHostnameDeviceLabel(hostnameFn())
    if (derived === null) {
      throw new CliArgError(
        `--device is required when --daemon-url is non-loopback (got ${daemonUrl}); ` +
        `os.hostname() did not yield a usable label`
      )
    }
    device = derived
    deviceAutoDerivedNotice =
      `--device not supplied; auto-derived "${derived}" from os.hostname() for remote daemon ${daemonUrl}. ` +
      `Pass --device <label> explicitly to silence this notice and pin the device label.`
  }
  const rawIdentityKey = env.XATS_IDENTITY_KEY?.trim()
  const identityKey = rawIdentityKey ? rawIdentityKey : undefined
  return { daemonUrl, token, device, deviceAutoDerivedNotice, identityKey }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let args: CliArgs
  try {
    args = parseCliArgs(argv, env)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`cross-agent-teams-proxy: ${msg}\n`)
    process.exit(2)
  }
  if (args.deviceAutoDerivedNotice !== undefined) {
    process.stderr.write(`cross-agent-teams-proxy: ${args.deviceAutoDerivedNotice}\n`)
  }

  // Fresh csid per startup — no persistence. Multi-instance safe.
  const csid = randomUUID()

  const hostServer = createProxyServer()
  const stdioTransport = new StdioServerTransport()

  let registrationEverSucceeded = false
  const controller = runReconnectingProxy({
    daemonUrl: args.daemonUrl,
    token: args.token,
    device: args.device,
    channel_session_id: csid,
    notificationHandler: (params) => {
      relayChannelWake(hostServer, params as { content: string; meta: Record<string, string> })
    },
    onSequenceComplete: () => {
      registrationEverSucceeded = true
      // Announce csid to Claude via host-facing channel notification so Claude
      // can call bind_channel({channel_session_id}) to bind its own agent row.
      const hint = buildStartupHint(csid, args.device, args.identityKey)
      relayChannelWake(hostServer, hint)
    }
  })

  let stopped = false
  const shutdown = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    try { await controller.stop() } catch { /* best-effort */ }
    try { await hostServer.close() } catch { /* best-effort */ }
    if (!registrationEverSucceeded) {
      process.stderr.write(`cross-agent-teams-proxy: daemon unreachable at ${args.daemonUrl}\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  stdioTransport.onclose = () => { void shutdown() }

  await hostServer.connect(stdioTransport)

  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

// Entry-point check.  The naive `import.meta.url === \`file://${process.argv[1]}\``
// breaks when launched via an npm `.bin` symlink (npx, `npm install -g`):
// process.argv[1] is the symlink path, while import.meta.url is already
// resolved.  Compare realpath-resolved file paths instead.
function isEntry(): boolean {
  try {
    const metaPath = fileURLToPath(import.meta.url)
    const argvPath = realpathSync(process.argv[1])
    return metaPath === argvPath
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-misused-promises
if (isEntry()) {
  void main()
}

function resolveDeviceLabel(explicit?: string): string {
  const raw = explicit ?? hostname()
  if (raw.includes(':')) {
    throw new CliArgError('invalid_device_label')
  }
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  const label = normalized.length > 0 ? normalized : 'local'
  if (label.length > 64) {
    throw new CliArgError('invalid_device_label')
  }
  return label
}
