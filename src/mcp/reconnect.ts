import type { AgentsRepo, RuntimeUiPidMatch } from '../storage/agents-repo.js'
import { kimiAuthHeaders, DEFAULT_KIMI_TOKEN_FILE } from './kimi-auth.js'
import { kimiSessionUrl, parseStrictEnvelopeData } from './kimi-session-state.js'

const MISSING_IDENTITY_GUIDANCE =
  'There is no prior identity to reconnect. Ask the user for the missing ' +
  'name/team before calling register_agent. Do not invent a name or team; ' +
  'need_register is not authorization to create an identity.'

export interface ReconnectCandidate {
  agent_id: string
  device: string
  team: string
  name: string
  role: string
  last_seen_at: string
}

export type ReconnectResolution =
  | { kind: 'need_register'; reason: string }
  | { kind: 'single'; match: ReconnectCandidate }
  | { kind: 'ambiguous'; candidates: ReconnectCandidate[] }

function toCandidate(row: RuntimeUiPidMatch): ReconnectCandidate {
  return {
    agent_id: row.agent_id,
    device: row.device,
    team: row.team,
    name: row.name,
    role: row.role,
    last_seen_at: row.last_seen_at,
  }
}

/**
 * Reverse-look-up a prior local claude-code identity by its `runtime_ui_pid`
 * (the Claude UI process id / `$PPID`) and decide how `reconnect` should branch:
 * 0 matches → `need_register`, 1 match → reuse, N matches → `ambiguous`.
 *
 * This function only reads; it never mutates a row. The single-match register /
 * takeover / auto-bind side effects are driven by the caller using the recovered
 * `(device, team, name)`.
 */
export function resolveReconnect(
  repo: AgentsRepo,
  ui_pid: number,
  localDevice: string
): ReconnectResolution {
  const rows = repo.findByRuntimeUiPid(ui_pid, localDevice)
  if (rows.length === 0) {
    return {
      kind: 'need_register',
      reason:
        `No local agent is registered for ui_pid ${ui_pid}. ` +
        MISSING_IDENTITY_GUIDANCE,
    }
  }
  if (rows.length === 1) {
    return { kind: 'single', match: toCandidate(rows[0]) }
  }
  return { kind: 'ambiguous', candidates: rows.map(toCandidate) }
}

/**
 * Reverse-look-up a prior local identity by the launcher-minted
 * `identity_key`. `UNIQUE(device, identity_key)` admits at most one row, so
 * the ambiguous branch is unreachable in practice — it is kept so a somehow
 * duplicated key surfaces instead of being silently resolved to one row.
 */
export function resolveIdentityKeyReconnect(
  repo: AgentsRepo,
  identity_key: string,
  localDevice: string
): ReconnectResolution {
  const rows = repo.findByIdentityKey(identity_key, localDevice)
  if (rows.length === 0) {
    return {
      kind: 'need_register',
      reason:
        'No local agent holds this identity_key. ' +
        MISSING_IDENTITY_GUIDANCE +
        ' Once the user supplies the identity, pass the same identity_key.',
    }
  }
  if (rows.length === 1) {
    return { kind: 'single', match: toCandidate(rows[0]) }
  }
  return { kind: 'ambiguous', candidates: rows.map(toCandidate) }
}

export function resolveCodexReconnect(
  repo: AgentsRepo,
  thread_id: string,
  localDevice: string
): ReconnectResolution {
  const rows = repo.findByCodexThreadId(thread_id, localDevice)
  if (rows.length === 0) {
    return {
      kind: 'need_register',
      reason:
        `No local Codex agent is registered for thread_id ${thread_id}. ` +
        MISSING_IDENTITY_GUIDANCE,
    }
  }
  if (rows.length === 1) {
    return { kind: 'single', match: toCandidate(rows[0]) }
  }
  return { kind: 'ambiguous', candidates: rows.map(toCandidate) }
}

/** Pure-read kimi reverse lookup by (base_url, session_id). session_id is
 *  REQUIRED for the kimi path: the daemon never auto-resolves a kimi session
 *  by recency, mirroring the registration-time refusal to guess. */
export function resolveKimiReconnect(
  repo: AgentsRepo,
  base_url: string,
  session_id: string,
  localDevice: string
): ReconnectResolution {
  const rows = repo.findByKimiSession(base_url, session_id, localDevice)
  if (rows.length === 0) {
    return {
      kind: 'need_register',
      reason:
        `No local kimi agent is registered for session_id ${session_id} ` +
        `on base_url ${base_url}. ` +
        MISSING_IDENTITY_GUIDANCE,
    }
  }
  if (rows.length === 1) {
    return { kind: 'single', match: toCandidate(rows[0]) }
  }
  return { kind: 'ambiguous', candidates: rows.map(toCandidate) }
}

export interface KimiSessionProbeDeps {
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  tokenFilePath?: string
}

export type ValidateKimiSessionResult =
  | { ok: true }
  | {
      error: 'missing_auth_token'
      detail: { ref: string } | { token_file: string }
    }
  | {
      error: 'session_not_found'
      detail: { base_url: string; session_id: string; cause: string }
    }

/**
 * Revalidate a kimi session before a reconnect reuses its identity. Bearer
 * resolution is exactly the poke dispatcher's (delivery auth_token_ref, else
 * the kimi token file). Unlike the busy gate, every probe failure fails
 * CLOSED: rebinding onto an archived/stale session would silently misroute
 * pokes, so the caller mutates nothing on session_not_found.
 */
export async function validateKimiSession(
  args: { base_url: string; session_id: string; auth_token_ref?: string },
  deps: KimiSessionProbeDeps = {}
): Promise<ValidateKimiSessionResult> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const auth = kimiAuthHeaders(
    args.auth_token_ref,
    env,
    deps.tokenFilePath ?? DEFAULT_KIMI_TOKEN_FILE
  )
  if ('error' in auth) return auth
  const notFound = (cause: string): ValidateKimiSessionResult => ({
    error: 'session_not_found',
    detail: { base_url: args.base_url, session_id: args.session_id, cause },
  })
  let response: Response
  try {
    response = await fetchImpl(
      kimiSessionUrl(args.base_url, args.session_id),
      { method: 'GET', headers: auth.headers }
    )
  } catch (error) {
    return notFound(error instanceof Error ? error.message : String(error))
  }
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }
  if (!response.ok) return notFound(`http_${response.status}`)
  const data = parseStrictEnvelopeData(bodyText)
  if (data === undefined) return notFound('error_envelope')
  // A 200 envelope alone proves nothing: require the payload to identify the
  // requested session and to not be archived, else rebinding would silently
  // misroute pokes to a session nobody is watching.
  if (data.id !== args.session_id) return notFound('session_mismatch')
  if (data.archived === true) return notFound('archived')
  return { ok: true }
}

/** Pure-read opencode reverse lookup by (base_url, session_id). */
export function resolveOpencodeReconnect(
  repo: AgentsRepo,
  base_url: string,
  session_id: string,
  localDevice: string
): ReconnectResolution {
  const rows = repo.findByOpencodeSession(base_url, session_id, localDevice)
  if (rows.length === 0) {
    return {
      kind: 'need_register',
      reason:
        `No local opencode agent is registered for session_id ${session_id} ` +
        `on base_url ${base_url}. ` +
        MISSING_IDENTITY_GUIDANCE,
    }
  }
  if (rows.length === 1) {
    return { kind: 'single', match: toCandidate(rows[0]) }
  }
  return { kind: 'ambiguous', candidates: rows.map(toCandidate) }
}
