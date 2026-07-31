import type {
  IdentityKeyConflict,
  RegisterAgentService,
} from './register-agent.js'
import { describeError } from './codex-appserver-rpc.js'
import { opencodeAuthHeaders, type OpencodeAuthResult } from './opencode-auth.js'

type FetchLike = typeof globalThis.fetch

export interface RegisterOpencodeSelfInput {
  connection_id: string
  name: string
  device?: string
  model?: string
  role?: string
  team?: string
  project_dir?: string
  base_url: string
  session_id?: string
  auth_token_ref?: string
  identity_key?: string
}

export type RegisterOpencodeSelfResult =
  | {
      agent_id: string
      team: string
      session_id: string
      base_url: string
    }
  | { error: 'agent_id_collision' }
  | { error: 'invalid_delivery'; reason: string }
  | { error: 'claude_ui_pid_requires_channel_proxy' }
  | { error: 'device_spoofing_from_loopback' }
  | { error: 'device_required_from_remote' }
  | { error: 'device_spoofing_local_label_from_remote' }
  | { error: 'invalid_device_label' }
  | { error: 'invalid_name_label' }
  | { error: 'invalid_team_label' }
  | { error: 'opencode_unreachable'; detail: { base_url: string; cause: string } }
  | { error: 'no_active_session'; detail: { base_url: string } }
  | { error: 'session_not_found'; detail: { base_url: string; session_id: string } }
  | { error: 'missing_auth_token'; detail: { ref: string } }
  | IdentityKeyConflict

export type ResolveOpencodeSessionResult =
  | { session_id: string }
  | { error: 'opencode_unreachable'; detail: { base_url: string; cause: string } }
  | { error: 'no_active_session'; detail: { base_url: string } }
  | { error: 'session_not_found'; detail: { base_url: string; session_id: string } }
  | { error: 'missing_auth_token'; detail: { ref: string } }

export interface RegisterOpencodeSelfDeps {
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
}

interface OpencodeSessionEntry {
  id?: unknown
  time_updated?: unknown
  time?: { updated?: unknown } | undefined
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function updatedOf(entry: OpencodeSessionEntry | undefined | null): number | undefined {
  if (!entry) return undefined
  if (typeof entry.time_updated === 'number') return entry.time_updated
  const nested = entry.time?.updated
  if (typeof nested === 'number') return nested
  return undefined
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export class RegisterOpencodeSelfService {
  constructor(
    private readonly registerSvc: RegisterAgentService,
    private readonly deps: RegisterOpencodeSelfDeps = {}
  ) {}

  async register(
    input: RegisterOpencodeSelfInput
  ): Promise<RegisterOpencodeSelfResult> {
    const explicitSessionId = trimToUndefined(input.session_id)
    // Both explicit and auto-resolved session_ids go through the server so a
    // stale/explicit id is rejected (session_not_found) before any DB write.
    const resolved = await this.resolveSessionId(
      input.base_url,
      input.auth_token_ref,
      explicitSessionId
    )
    if ('error' in resolved) return resolved
    const sessionId = resolved.session_id

    const result = this.registerSvc.register({
      connection_id: input.connection_id,
      agent_type: 'opencode',
      model: input.model,
      device: input.device,
      name: input.name,
      role: input.role,
      team: input.team,
      project_dir: input.project_dir,
      identity_key: input.identity_key,
      delivery: {
        kind: 'opencode-server',
        session_id: sessionId,
        base_url: input.base_url,
        ...(input.auth_token_ref === undefined
          ? {}
          : { auth_token_ref: input.auth_token_ref }),
      },
    })
    if ('error' in result) return result
    // prior_snapshot and register_generation are register-internal state;
    // never expose them here.
    const {
      prior_snapshot: _priorSnapshot,
      register_generation: _registerGeneration,
      ...publicResult
    } = result
    return {
      ...publicResult,
      session_id: sessionId,
      base_url: input.base_url,
    }
  }

  async healthCheck(
    baseUrlRaw: string,
    auth_token_ref?: string
  ): Promise<
    | { ok: true }
    | { error: 'opencode_unreachable'; detail: { base_url: string; cause: string } }
    | { error: 'missing_auth_token'; detail: { ref: string } }
  > {
    const fetchImpl = this.deps.fetch ?? globalThis.fetch
    const baseUrl = normalizeBaseUrl(baseUrlRaw)
    const auth = this.authHeaders(auth_token_ref)
    if ('error' in auth) return auth
    try {
      const healthRes = await fetchImpl(`${baseUrl}/global/health`, {
        method: 'GET',
        headers: auth.headers,
      })
      if (healthRes.ok) return { ok: true }
      return {
        error: 'opencode_unreachable',
        detail: { base_url: baseUrlRaw, cause: `health check HTTP ${healthRes.status}` },
      }
    } catch (error) {
      return {
        error: 'opencode_unreachable',
        detail: { base_url: baseUrlRaw, cause: describeError(error) },
      }
    }
  }

  /**
   * Health-check + list /session, then validate preferredSessionId or pick
   * the newest. Shared by register + reconnect.
   */
  async resolveSessionId(
    baseUrlRaw: string,
    auth_token_ref?: string,
    preferredSessionId?: string
  ): Promise<ResolveOpencodeSessionResult> {
    const health = await this.healthCheck(baseUrlRaw, auth_token_ref)
    if ('error' in health) return health

    const list = await this.listSessions(baseUrlRaw, auth_token_ref)
    if ('error' in list) return list

    const candidates = list.sessions
      .filter((entry): entry is OpencodeSessionEntry & { id: string } =>
        typeof entry?.id === 'string' && updatedOf(entry) !== undefined
      )
      .sort((a, b) => (updatedOf(b) ?? 0) - (updatedOf(a) ?? 0))

    if (preferredSessionId) {
      const found = candidates.some(entry => entry.id === preferredSessionId)
      if (!found) {
        return {
          error: 'session_not_found',
          detail: { base_url: baseUrlRaw, session_id: preferredSessionId },
        }
      }
      return { session_id: preferredSessionId }
    }

    if (candidates.length === 0) {
      return {
        error: 'no_active_session',
        detail: { base_url: baseUrlRaw },
      }
    }
    return { session_id: candidates[0].id }
  }

  private authHeaders(auth_token_ref?: string): OpencodeAuthResult {
    const env = this.deps.env ?? process.env
    return opencodeAuthHeaders(auth_token_ref, env)
  }

  private async listSessions(
    baseUrlRaw: string,
    auth_token_ref?: string
  ): Promise<
    | { sessions: OpencodeSessionEntry[] }
    | { error: 'opencode_unreachable'; detail: { base_url: string; cause: string } }
    | { error: 'missing_auth_token'; detail: { ref: string } }
  > {
    const fetchImpl = this.deps.fetch ?? globalThis.fetch
    const baseUrl = normalizeBaseUrl(baseUrlRaw)
    const auth = this.authHeaders(auth_token_ref)
    if ('error' in auth) return auth
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}/session`, {
        method: 'GET',
        headers: auth.headers,
      })
    } catch (error) {
      return {
        error: 'opencode_unreachable',
        detail: { base_url: baseUrlRaw, cause: describeError(error) },
      }
    }
    if (!res.ok) {
      return {
        error: 'opencode_unreachable',
        detail: { base_url: baseUrlRaw, cause: `session list HTTP ${res.status}` },
      }
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (error) {
      return {
        error: 'opencode_unreachable',
        detail: { base_url: baseUrlRaw, cause: describeError(error) },
      }
    }
    let sessions: OpencodeSessionEntry[] = []
    if (Array.isArray(body)) {
      sessions = body as OpencodeSessionEntry[]
    } else if (body && typeof body === 'object') {
      const maybeArr = (body as { data?: unknown }).data
      if (Array.isArray(maybeArr)) sessions = maybeArr as OpencodeSessionEntry[]
    }
    return { sessions }
  }
}
