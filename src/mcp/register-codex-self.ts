import {
  RegisterAgentService,
  type IdentityKeyConflict,
} from './register-agent.js'
import type { IdentityRowSnapshot } from '../storage/agents-repo.js'
import {
  JsonRpcSocketClient,
  defaultWebSocketFactory,
  describeError,
  resolveAuthToken,
  safeClose,
  type CodexWebSocketFactory,
  type JsonRpcResponse,
  type WebSocketLike,
} from './codex-appserver-rpc.js'

export interface RegisterCodexSelfInput {
  connection_id: string
  name: string
  device?: string
  model?: string
  role?: string
  team?: string
  project_dir?: string
  ws_url?: string
  auth_token_ref?: string
  thread_id?: string
  tmux_pane_id?: string
  cwd?: string
  tty?: string
  title_contains?: string
  identity_key?: string
}

type UnsupportedClientDetail = {
  expected: 'codex'
  reason: 'codex_appserver_unreachable' | 'codex_protocol_unavailable'
  ws_url: string
  cause?: unknown
}

export type RegisterCodexSelfResult =
  | {
      agent_id: string
      team: string
      thread_id: string
      ws_url: string
      // Actual pre-upsert row state returned by the persist transaction
      // (CAS input; see RegisterResult) plus the generation that upsert
      // minted.  Both stripped by the MCP tool layer.
      prior_snapshot: IdentityRowSnapshot | null
      register_generation: number
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
  | { error: 'missing_auth_token'; detail: { ref: string } }
  | { error: 'unsupported_client'; detail: UnsupportedClientDetail }
  | { error: 'codex_connect_failed'; detail?: unknown }
  | { error: 'codex_initialize_failed'; detail?: unknown }
  | { error: 'codex_loaded_list_failed'; detail?: unknown }
  | { error: 'no_loaded_threads'; detail?: unknown }
  | { error: 'thread_id_required'; detail: { ws_url: string; thread_ids: string[] } }
  | { error: 'codex_resume_failed'; detail?: unknown }
  | {
      error: 'codex_endpoint_ambiguous'
      detail: { thread_id: string; ws_urls: string[] }
    }
  | {
      error: 'codex_endpoint_config_invalid'
      detail: { env: 'CROSS_AGENT_TEAMS_CODEX_WS_URLS'; reason: string }
    }
  | IdentityKeyConflict

export interface RegisterCodexSelfDeps {
  env?: NodeJS.ProcessEnv
  webSocketFactory?: CodexWebSocketFactory
}

type RpcErrorCode =
  | 'codex_initialize_failed'
  | 'codex_loaded_list_failed'
  | 'codex_resume_failed'

type EndpointProbe =
  | { ok: true; ws_url: string }
  | {
      ok: false
      ws_url: string
      error: 'unsupported_client'
      detail: UnsupportedClientDetail
    }
  | {
      ok: false
      ws_url: string
      error: 'codex_resume_failed'
      detail: { thread_id: string; cause: unknown }
    }

const DEFAULT_CODEX_WS_URL = 'ws://127.0.0.1:8799'
const MULTI_WS_URL_ENV = 'CROSS_AGENT_TEAMS_CODEX_WS_URLS' as const

async function requestStep(
  client: JsonRpcSocketClient,
  method: string,
  params: unknown,
  errorCode: RpcErrorCode
): Promise<{ ok: JsonRpcResponse } | { error: RpcErrorCode; detail: unknown }> {
  try {
    const response = await client.request(method, params)
    if (response.error) return { error: errorCode, detail: response.error }
    return { ok: response }
  } catch (error) {
    return { error: errorCode, detail: describeError(error) }
  }
}

function normalizedWebSocketUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined
    return url.href
  } catch {
    return undefined
  }
}

function parseMultiWsUrls(
  raw: string
):
  | { ok: string[] }
  | Extract<
      RegisterCodexSelfResult,
      { error: 'codex_endpoint_config_invalid' }
    > {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      error: 'codex_endpoint_config_invalid',
      detail: { env: MULTI_WS_URL_ENV, reason: describeError(error) },
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return {
      error: 'codex_endpoint_config_invalid',
      detail: { env: MULTI_WS_URL_ENV, reason: 'expected_non_empty_json_array' },
    }
  }

  const urls: string[] = []
  const normalizedUrls = new Set<string>()
  for (const value of parsed) {
    const candidate = typeof value === 'string' ? value.trim() : ''
    const normalized = candidate
      ? normalizedWebSocketUrl(candidate)
      : undefined
    if (!normalized) {
      return {
        error: 'codex_endpoint_config_invalid',
        detail: { env: MULTI_WS_URL_ENV, reason: 'invalid_websocket_url' },
      }
    }
    if (!normalizedUrls.has(normalized)) {
      normalizedUrls.add(normalized)
      urls.push(candidate)
    }
  }
  return { ok: urls }
}

function resolveWsUrls(
  input: RegisterCodexSelfInput,
  env: NodeJS.ProcessEnv
):
  | { ok: string[] }
  | Extract<
      RegisterCodexSelfResult,
      { error: 'codex_endpoint_config_invalid' }
    > {
  const explicit = input.ws_url?.trim()
  if (explicit) return { ok: [explicit] }
  const legacy = env.CROSS_AGENT_TEAMS_CODEX_WS_URL?.trim()
  if (legacy) return { ok: [legacy] }
  const multi = env[MULTI_WS_URL_ENV]?.trim()
  if (multi) return parseMultiWsUrls(multi)
  return { ok: [DEFAULT_CODEX_WS_URL] }
}

function extractThreadIds(response: JsonRpcResponse): string[] {
  const result = response.result as { data?: unknown } | undefined
  if (!result || !Array.isArray(result.data)) return []
  return result.data.filter((value): value is string => typeof value === 'string')
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function unsupportedDetail(
  wsUrl: string,
  reason: UnsupportedClientDetail['reason'],
  cause: unknown
): UnsupportedClientDetail {
  return {
    expected: 'codex',
    reason,
    ws_url: wsUrl,
    cause,
  }
}

async function probeThread(args: {
  wsUrl: string
  threadId: string
  headers?: Record<string, string>
  factory: CodexWebSocketFactory
}): Promise<EndpointProbe> {
  let ws: WebSocketLike
  try {
    ws = args.factory({ url: args.wsUrl, headers: args.headers })
  } catch (error) {
    return {
      ok: false,
      ws_url: args.wsUrl,
      error: 'unsupported_client',
      detail: unsupportedDetail(
        args.wsUrl,
        'codex_appserver_unreachable',
        describeError(error)
      ),
    }
  }

  const client = new JsonRpcSocketClient(ws)
  try {
    await client.waitForOpen()
    const init = await initializeClient(client)
    if ('error' in init) {
      return {
        ok: false,
        ws_url: args.wsUrl,
        error: 'unsupported_client',
        detail: unsupportedDetail(
          args.wsUrl,
          'codex_protocol_unavailable',
          init.detail
        ),
      }
    }
    const resume = await resumeThread(client, args.threadId)
    if ('error' in resume) {
      return {
        ok: false,
        ws_url: args.wsUrl,
        error: 'codex_resume_failed',
        detail: { thread_id: args.threadId, cause: resume.detail },
      }
    }
    return { ok: true, ws_url: args.wsUrl }
  } catch (error) {
    return {
      ok: false,
      ws_url: args.wsUrl,
      error: 'unsupported_client',
      detail: unsupportedDetail(
        args.wsUrl,
        'codex_appserver_unreachable',
        describeError(error)
      ),
    }
  } finally {
    safeClose(ws)
  }
}

async function initializeClient(
  client: JsonRpcSocketClient
): Promise<{ ok: JsonRpcResponse } | { error: RpcErrorCode; detail: unknown }> {
  const init = await requestStep(
    client,
    'initialize',
    {
      clientInfo: {
        name: 'cross-agent-teams-mcp',
        title: null,
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    },
    'codex_initialize_failed'
  )
  if (!('error' in init)) client.notify('initialized')
  return init
}

function resumeThread(
  client: JsonRpcSocketClient,
  threadId: string
): Promise<{ ok: JsonRpcResponse } | { error: RpcErrorCode; detail: unknown }> {
  return requestStep(
    client,
    'thread/resume',
    { threadId, persistExtendedHistory: false },
    'codex_resume_failed'
  )
}

export class RegisterCodexSelfService {
  constructor(
    private readonly registerSvc: RegisterAgentService,
    private readonly deps: RegisterCodexSelfDeps = {}
  ) {}

  async register(
    input: RegisterCodexSelfInput
  ): Promise<RegisterCodexSelfResult> {
    const env = this.deps.env ?? process.env
    const resolved = resolveWsUrls(input, env)
    if ('error' in resolved) return resolved

    const token = resolveAuthToken(input.auth_token_ref, env)
    if ('error' in token) return token
    const headers = token.ok === undefined
      ? undefined
      : { Authorization: `Bearer ${token.ok}` }
    const threadId = trimToUndefined(input.thread_id)

    if (!threadId) {
      return this.diagnoseSingleEndpoint(resolved.ok[0], headers)
    }

    const probes = await Promise.all(
      resolved.ok.map(wsUrl => probeThread({
        wsUrl,
        threadId,
        headers,
        factory: this.deps.webSocketFactory ?? defaultWebSocketFactory,
      }))
    )
    return this.finishProbes(input, threadId, probes)
  }

  private finishProbes(
    input: RegisterCodexSelfInput,
    threadId: string,
    probes: EndpointProbe[]
  ): RegisterCodexSelfResult {
    const matches = probes.filter(
      (probe): probe is Extract<EndpointProbe, { ok: true }> => probe.ok
    )
    if (matches.length > 1) {
      return {
        error: 'codex_endpoint_ambiguous',
        detail: { thread_id: threadId, ws_urls: matches.map(item => item.ws_url) },
      }
    }
    if (matches.length === 1) {
      return this.persist(input, threadId, matches[0].ws_url)
    }

    const failures = probes.filter(
      (probe): probe is Extract<EndpointProbe, { ok: false }> => !probe.ok
    )
    const resumeFailures = failures.filter(
      failure => failure.error === 'codex_resume_failed'
    )
    if (probes.length === 1) {
      const failure = failures[0]
      if (failure.error === 'unsupported_client') {
        return { error: 'unsupported_client', detail: failure.detail }
      }
      return { error: 'codex_resume_failed', detail: failure.detail }
    }
    if (resumeFailures.length > 0) {
      return {
        error: 'codex_resume_failed',
        detail: {
          thread_id: threadId,
          attempts: failures.map(({ ws_url, error, detail }) => ({
            ws_url,
            error,
            detail,
          })),
        },
      }
    }
    const unsupportedFailures = failures.filter(
      (
        failure
      ): failure is Extract<
        EndpointProbe,
        { ok: false; error: 'unsupported_client' }
      > => failure.error === 'unsupported_client'
    )
    return {
      error: 'unsupported_client',
      detail: unsupportedDetail(
        unsupportedFailures[0].ws_url,
        unsupportedFailures[0].detail.reason,
        unsupportedFailures.map(({ ws_url, detail }) => ({ ws_url, detail }))
      ),
    }
  }

  private persist(
    input: RegisterCodexSelfInput,
    threadId: string,
    wsUrl: string
  ): RegisterCodexSelfResult {
    const result = this.registerSvc.register({
      connection_id: input.connection_id,
      agent_type: 'codex',
      model: input.model ?? 'codex',
      device: input.device,
      name: input.name,
      role: input.role,
      team: input.team,
      project_dir: input.project_dir,
      tmux_pane_id: trimToUndefined(input.tmux_pane_id),
      identity_key: input.identity_key,
      delivery: {
        kind: 'codex-appserver',
        thread_id: threadId,
        ws_url: wsUrl,
        ...(input.auth_token_ref === undefined
          ? {}
          : { auth_token_ref: input.auth_token_ref }),
      },
    })
    if ('error' in result) return result
    return { ...result, thread_id: threadId, ws_url: wsUrl }
  }

  private async diagnoseSingleEndpoint(
    wsUrl: string,
    headers?: Record<string, string>
  ): Promise<RegisterCodexSelfResult> {
    let ws: WebSocketLike
    try {
      ws = (this.deps.webSocketFactory ?? defaultWebSocketFactory)({
        url: wsUrl,
        headers,
      })
    } catch (error) {
      return {
        error: 'unsupported_client',
        detail: unsupportedDetail(
          wsUrl,
          'codex_appserver_unreachable',
          describeError(error)
        ),
      }
    }

    const client = new JsonRpcSocketClient(ws)
    try {
      await client.waitForOpen()
      const init = await initializeClient(client)
      if ('error' in init) {
        return {
          error: 'unsupported_client',
          detail: unsupportedDetail(
            wsUrl,
            'codex_protocol_unavailable',
            init.detail
          ),
        }
      }
      return await this.listLiveThreads(client, wsUrl)
    } catch (error) {
      return {
        error: 'unsupported_client',
        detail: unsupportedDetail(
          wsUrl,
          'codex_appserver_unreachable',
          describeError(error)
        ),
      }
    } finally {
      safeClose(ws)
    }
  }

  private async listLiveThreads(
    client: JsonRpcSocketClient,
    wsUrl: string
  ): Promise<RegisterCodexSelfResult> {
    const list = await requestStep(
      client,
      'thread/loaded/list',
      { cursor: null, limit: 20 },
      'codex_loaded_list_failed'
    )
    if ('error' in list) return list

    const threadIds = extractThreadIds(list.ok)
    if (threadIds.length === 0) {
      return { error: 'no_loaded_threads', detail: { ws_url: wsUrl } }
    }

    const liveThreadIds: string[] = []
    const failures: Array<{ thread_id: string; detail: unknown }> = []
    for (const threadId of threadIds) {
      const resume = await resumeThread(client, threadId)
      if ('error' in resume) {
        failures.push({ thread_id: threadId, detail: resume.detail })
      } else {
        liveThreadIds.push(threadId)
      }
    }
    if (liveThreadIds.length === 0) {
      return { error: 'codex_resume_failed', detail: failures }
    }
    return {
      error: 'thread_id_required',
      detail: { ws_url: wsUrl, thread_ids: liveThreadIds },
    }
  }
}
