import type { AgentsRepo } from '../storage/agents-repo.js'
import type { RegisterAgentService } from './register-agent.js'
import { validateKimiSession } from './reconnect.js'
import { canonicalKimiBaseUrl } from './kimi-session-state.js'

/**
 * Handshake-level kimi identity. kimi-code session-scoped MCP connections
 * (scope:"session") attach these headers to initialize and every later
 * request, templated from the per-session env overlay. They let the daemon
 * re-associate a brand-new MCP session with the already-registered agent
 * after a client reconnect / config hot-reload / daemon restart, without an
 * explicit reconnect call. The daemon trusts ONLY these explicit headers and
 * never guesses identity from any other channel.
 */
export const KIMI_SESSION_ID_HEADER = 'x-kimi-session-id'
export const KIMI_BASE_URL_HEADER = 'x-kimi-base-url'

export interface KimiHandshakeIdentity {
  session_id: string
  base_url?: string
}

export function readKimiHandshakeHeaders(
  headers: Record<string, unknown>
): KimiHandshakeIdentity | undefined {
  const sessionId = headers[KIMI_SESSION_ID_HEADER]
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    return undefined
  }
  const baseUrl = headers[KIMI_BASE_URL_HEADER]
  return {
    session_id: sessionId.trim(),
    base_url:
      typeof baseUrl === 'string' && baseUrl.trim().length > 0
        ? baseUrl.trim()
        : undefined,
  }
}

export type KimiHandshakeBindOutcome =
  | 'bound'
  | 'no_match'
  | 'ambiguous'
  | 'probe_failed'

export interface AttemptKimiHandshakeBindArgs {
  identity: KimiHandshakeIdentity
  connection_id: string
  repo: AgentsRepo
  registerSvc: RegisterAgentService
  onRegisterSuccess: (agent_id: string, team: string) => void
  localDevice: string
  log?: (line: string) => void
}

/**
 * Try to bind an unbound MCP session to a registered kimi agent using the
 * handshake identity headers. Semantics mirror the reconnect tool: reverse
 * lookup the agent row, probe-validate the live kimi session (fail CLOSED —
 * no bind on any probe error), then associate the connection without
 * mutating the registry. When X-Kimi-Base-Url is absent the unique local
 * row claiming the session id supplies the base_url; zero or multiple
 * matches fail closed (no bind, no error — the session simply stays
 * unregistered and the normal register_agent path remains available).
 */
export async function attemptKimiHandshakeBind(
  args: AttemptKimiHandshakeBindArgs
): Promise<KimiHandshakeBindOutcome> {
  const candidates = args.identity.base_url !== undefined
    ? args.repo.findByKimiSession(
        args.identity.base_url,
        args.identity.session_id,
        args.localDevice
      )
    : args.repo.findKimiBySessionId(args.identity.session_id, args.localDevice)
  if (candidates.length === 0) return 'no_match'
  if (candidates.length > 1) {
    args.log?.(
      `mcp handshake bind skipped: sid=${args.connection_id} ` +
      `session_id=${args.identity.session_id} reason=ambiguous ` +
      `candidates=${candidates.length}`
    )
    return 'ambiguous'
  }
  const match = candidates[0]
  const row = args.repo.findById(match.agent_id)
  if (!row || row.delivery.kind !== 'kimi-server') return 'no_match'
  const base_url = canonicalKimiBaseUrl(row.delivery.base_url)
  const probe = await validateKimiSession({
    base_url,
    session_id: args.identity.session_id,
    auth_token_ref: row.delivery.auth_token_ref,
  })
  if ('error' in probe) {
    args.log?.(
      `mcp handshake bind skipped: sid=${args.connection_id} ` +
      `session_id=${args.identity.session_id} reason=probe_failed ` +
      `error=${probe.error}`
    )
    return 'probe_failed'
  }
  args.onRegisterSuccess(row.agent_id, row.team)
  args.registerSvc.bindExistingConnection({
    connection_id: args.connection_id,
    agent_type: 'kimi-code',
    delivery: row.delivery,
    device: row.device,
    team: row.team,
    name: row.name,
  })
  args.log?.(
    `mcp handshake bind: sid=${args.connection_id} ` +
    `agent=${row.agent_id} team=${row.team} name=${row.name}`
  )
  return 'bound'
}
