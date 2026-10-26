import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, createHash } from 'node:crypto'
import { echoSchema, echoHandler } from './echo.js'
import { sendControlPlaneReject } from './control-plane-reject.js'
import { registerBusinessTools, type AgentIdHolder } from './tools.js'
import { RegisterAgentService } from './register-agent.js'
import { AgentsRepo } from '../storage/agents-repo.js'
import {
  attemptKimiHandshakeBind,
  readKimiHandshakeHeaders,
  type KimiHandshakeBindOutcome,
} from './kimi-handshake-bind.js'
import type { SseFanout, SseSink } from '../daemon/sse-fanout.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import type { DaemonContext } from '../daemon/server.js'
import type { SessionOriginInfo } from '../daemon/network-origin.js'
import type { ManagedService } from '../managed/service.js'
import { managedIdentityExists, managedDeliveryExists } from '../managed/guard.js'
import { describeRedactedError } from './log-redact.js'

interface Session {
  transport: StreamableHTTPServerTransport
  server: McpServer
  sink: SseSink
  sessionId: string
  agentIdHolder: AgentIdHolder
  onRegisterSuccess: (agentId: string, team: string) => void
  /**
   * Handshake-level identity bind state (X-Kimi-Session-Id / X-Kimi-Base-Url
   * headers). `attempted` records identity keys with a terminal outcome
   * (bound / no_match / ambiguous) so each identity is tried once; a
   * probe_failed outcome is NOT recorded and may be retried by a later
   * request. `inFlight` lets subsequent requests await an ongoing bind
   * instead of racing it into unknown_agent. `lastFailure` keeps the most
   * recent non-bound outcome so the unknown_agent hint can distinguish
   * "rebind failed" from "never registered".
   */
  handshake: {
    attempted: Set<string>
    inFlight?: Promise<void>
    lastFailure?: KimiHandshakeBindOutcome
  }
  registeredTeam?: string
  createdAt: number
  lastActivityAt: number
  clientInfo?: {
    name?: string
    version?: string
  }
  originInfo: SessionOriginInfo
  managedToken?: string
  managedProxyToken?: string
}

export interface OrphanSessionGcOptions {
  idleMs?: number
  maxAgeMs?: number
  maxSessions?: number
}

export interface McpSessionMetrics {
  total: number
  registered: number
  orphan: number
  fanout: number
}

export interface MountMcpResult {
  /**
   * Force-close unregistered sessions that cross the configured idle window,
   * max-age window, or orphan-session count limit. Registered sessions are
   * intentionally exempt so long-idle user-facing clients remain attached.
   */
  reapOrphanSessions: (now: number, opts?: number | OrphanSessionGcOptions) => void
  sessionMetrics: () => McpSessionMetrics
}

export function mountMcp(
  app: FastifyInstance,
  db: Database.Database,
  fanout: SseFanout,
  channelWakeFanout?: ChannelWakeFanout,
  opts: {
    log?: (line: string) => void
    context?: DaemonContext
    orphanSessionLimit?: number
    managed?: ManagedService
  } = {}
): MountMcpResult {
  const sessions = new Map<string, Session>()
  const log = (line: string): void => {
    try {
      opts.log?.(line)
    } catch (error) {
      console.error('MCP transport logger failed.', error)
      console.error(line)
    }
  }
  const context = opts.context ?? { localDevice: 'local' }

  function reportSessionCloseError(
    connectionId: string,
    error: unknown
  ): void {
    console.error(`Failed to close MCP session ${connectionId}.`, error)
  }

  function closeSessionByConnectionId(connectionId: string): boolean {
    const s = sessions.get(connectionId)
    if (!s) return false
    let closeIssued = true
    try {
      void s.transport.close().catch(error => {
        reportSessionCloseError(connectionId, error)
      })
    } catch (error) {
      reportSessionCloseError(connectionId, error)
      closeIssued = false
    } finally {
      finalizeSessionClose(connectionId)
    }
    return closeIssued
  }

  // Single RegisterAgentService for the whole daemon: its `connections` Map is
  // the cross-session (device, team, name) → connection_id ledger. Per-session
  // instantiation would defeat takeover detection.
  const registerSvc = new RegisterAgentService(db, {
    closeSessionByConnectionId,
    log,
    localDevice: context.localDevice,
    getSessionOrigin: (connectionId) => sessions.get(connectionId)?.originInfo,
    authorizeManagedProxy: (connectionId, channel, pid) =>
      opts.managed?.proxyAuthorized(
        sessions.get(connectionId)?.managedProxyToken, channel, pid
      ) ?? false,
  })

  function detachOrRestoreFanout(
    agentId: string,
    excludedSessionId: string | undefined
  ): void {
    const fallback = Array.from(sessions.values())
      .filter(session =>
        session.sessionId !== excludedSessionId &&
        session.agentIdHolder.current === agentId &&
        session.registeredTeam !== undefined
      )
      .at(-1)
    if (fallback?.registeredTeam === undefined) {
      fanout.detach(agentId)
      return
    }
    fanout.attach(agentId, fallback.registeredTeam, fallback.sink)
  }

  function finalizeSessionClose(sessionId: string): void {
    opts.managed?.detach(sessionId)
    const session = sessions.get(sessionId)
    if (!session) return
    const agentId = session.agentIdHolder.current
    if (agentId) {
      runSessionCleanup(sessionId, 'fanout', () => {
        detachOrRestoreFanout(agentId, sessionId)
      })
    }
    runSessionCleanup(sessionId, 'channel wake', () => {
      channelWakeFanout?.detachBySession(sessionId)
    })
    if (agentId) {
      runSessionCleanup(sessionId, 'registry', () => {
        registerSvc.releaseConnection(agentId, sessionId)
      })
    }
    const remaining = sessions.size - 1
    sessions.delete(sessionId)
    sessionOwners.delete(sessionId)
    log(
      `mcp session closed: sid=${sessionId} ` +
      `had_agent=${agentId ?? 'none'} sessions=${remaining}`
    )
  }

  function runSessionCleanup(
    sessionId: string,
    target: string,
    cleanup: () => void
  ): void {
    try {
      cleanup()
    } catch (error) {
      console.error(
        `Failed to clean up MCP session ${sessionId} ${target}.`,
        error
      )
    }
  }

  // Once register_agent succeeds for a session id, pin the owning Authorization hash.
  // A later register_agent presenting a different Authorization triggers HTTP 409.
  const sessionOwners = new Map<string, string>()

  function normalizeGcOptions(opts: number | OrphanSessionGcOptions | undefined): Required<OrphanSessionGcOptions> {
    if (typeof opts === 'number') {
      return { idleMs: opts, maxAgeMs: opts, maxSessions: Number.POSITIVE_INFINITY }
    }
    const idleMs = opts?.idleMs ?? 300_000
    return {
      idleMs,
      // Accepted for backward-compat but inert: reapOrphanSessions no longer
      // reaps by max-age (subsumed by the idle rule once active sessions are
      // exempt). Retained so existing ORPHAN_GC_MAX_AGE_MS / orphanGcMaxAgeMs
      // config does not error.
      maxAgeMs: opts?.maxAgeMs ?? idleMs,
      maxSessions: opts?.maxSessions ?? Number.POSITIVE_INFINITY,
    }
  }

  function closeOrphanSession(session: Session, now: number, reason: string): void {
    const ageS = Math.floor((now - session.createdAt) / 1000)
    const idleS = Math.floor((now - session.lastActivityAt) / 1000)
    log(
      `mcp orphan session reap: sid=${session.sessionId} ` +
      `age_s=${ageS} idle_s=${idleS} reason=${reason}`
    )
    closeSessionByConnectionId(session.sessionId)
  }

  function enforceOrphanSessionLimit(now: number, maxSessions: number, candidates?: Session[]): void {
    if (!Number.isFinite(maxSessions)) return
    const orphans = (candidates ?? Array.from(sessions.values()))
      .filter(session => session.agentIdHolder.current === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)
    if (orphans.length <= maxSessions) return
    for (const session of orphans.slice(0, orphans.length - maxSessions)) {
      closeOrphanSession(session, now, 'max_sessions')
    }
  }

  function createSession(): Session {
    const server = new McpServer(
      { name: 'cross-agent-teams-mcp', version: '0.1.0' },
      {
        instructions:
          'xats 是 cross-agent-teams 的缩写. 当用户或其他 agent 提到 xats 时, 指的是本 MCP server (cross-agent-teams-mcp) 及其跨 agent 协作工具 (register_agent, send_message, broadcast 等). 用户说"注册到 xats"或"注册到 cross-agent-teams"时, 表示注册到本 MCP 服务, xats 和 cross-agent-teams 不是 team 名, 不要把它们传给 team. 不要把单独的常用词"注册"默认劫持为本工具; 只有当前上下文已经在讨论 cross-agent-teams 注册时才可续接. 注册时 (register_agent) 如果用户未显式指定 team, 默认传 project_dir=当前工作目录 (cwd), daemon 会用它的 basename 作为 team 默认值; 都不传时回落 default.'
          + ' register_agent is the single registration entry point; pass `agent_type` explicitly.'
          + ' 身份必须来自用户明确指定的 name, 或当前会话已明确建立的旧 name/team. '
          + '缺少 name 时先询问用户, 禁止按 runtime/thread/cwd/角色自行起名. '
          + 'pane token 仅用于绑定 pane, 不构成注册或重连请求. '
          + '恢复身份必须沿用完整旧 name/team, 不得用默认 team 替代缺失的旧 team. '
          + '默认 team 规则仅适用于用户已指定 name 的新注册. '
          + ' 身份简写 name@team 与 name(team) 等价: x-name@y-team 和 '
          + 'x-name(y-team) 都表示 name="x-name", team="y-team", 即 '
          + 'x-name in y-team. 根据上下文确定是注册身份还是发送对象. '
          + '注册时拆成 register_agent 的 name 和 team; 发送时拆成 '
          + 'send_message 的 to_agent_name 和 to_team. 简写中的 team '
          + '属于用户明确指定的团队, 跨 team 发送时也应直接使用. '
          + '不要把整个简写传入 name 或 to_agent_name, daemon 不解析这两种简写. '
          + '@team 和 (team) 表示团队, 与表示设备的 :device 后缀不同.'
          + ' For `agent_type="kimi-code"`: read `$KIMI_XATS_BASE_URL` (exported by the `xats-kimi` launcher) and pass that value as `base_url`, plus a REQUIRED `session_id` read from `$KIMI_XATS_SESSION_ID` (the launcher pre-creates the session via the kimi server REST API and exports it; do NOT guess from `~/.kimi-code/session_index.jsonl`).'
          + ' For `agent_type="opencode"`: read `$OPENCODE_XATS_BASE_URL` (exported by the `free-xats-opencode` launcher) and pass that value as `base_url`; omit `session_id` (daemon auto-resolves it as the most recently updated session on that base_url).'
          + ' For `agent_type="codex"` (Codex CLI or Mac Codex App): read `$CODEX_THREAD_ID` (codex 0.124.0+ exports it) and pass it as `thread_id` (REQUIRED). For Codex CLI, do NOT pass `ui_pid` because the launcher\'s `pre_register_codex_pane` flow handles tmux pane binding. Mac Codex App has no tmux launcher flow; omit `ui_pid` because an App or app-server pid is not conversation-scoped.'
          + ' For `agent_type="claude-code"`: pass `$PPID` as `ui_pid` so channel delivery auto-binds.'
          + ' For ANY other harness (cursor, an editor extension, an unknown caller, etc.): use `agent_type="custom"` together with `agent_type_name=<your harness name>`. Do NOT guess from system-wide signals like "binary X is on PATH" — those reflect what the user has installed, not what runtime you are inside.'
          + ' `model` is OPTIONAL for any agent_type; omit it when you do not have an authoritative model identifier.'
          + ' Anti-pattern: DO NOT call list_agents to pre-verify / pre-check a recipient before send_message. list_agents is scoped to the caller\'s team and CANNOT see cross-team agents, so using it as a pre-flight check before a cross-team send_message will always falsely report the target as missing; for same-team sends the pre-check is wasted work. On miss, send_message itself returns unknown_recipient cleanly with no side effects — the correct pattern is "try send_message, then handle unknown_recipient", never "list_agents first, then send_message".'
      }
    )
    const agentIdHolder: AgentIdHolder = { current: undefined }
    server.registerTool('echo', { title: 'Echo', description: 'Return the input', inputSchema: echoSchema }, echoHandler as any)

    let sessionIdForCaller: string | undefined
    // `caller()` returns the session id before register_agent succeeds (to serve as
    // a stable connection_id), and the bound agent_id after register succeeds.
    const getCallerAgentId = (): string | undefined =>
      agentIdHolder.current ?? sessionIdForCaller

    const sink: SseSink = {
      sendHeartbeat(): void {
        void transport.send({
          jsonrpc: '2.0' as const,
          method: 'notifications/heartbeat',
          params: {}
        }).catch(() => { /* no active GET stream yet */ })
      },
      close(): void { /* transport.onclose handles lifecycle */ }
    }

    const onRegisterSuccess = (agent_id: string, team: string): void => {
      if (agentIdHolder.current && agentIdHolder.current !== agent_id) {
        detachOrRestoreFanout(agentIdHolder.current, sessionIdForCaller)
      }
      fanout.attach(agent_id, team, sink)
      agentIdHolder.current = agent_id
      const currentSession = sessionIdForCaller
        ? sessions.get(sessionIdForCaller)
        : undefined
      if (currentSession && sessionIdForCaller) {
        sessions.set(sessionIdForCaller, {
          ...currentSession,
          registeredTeam: team,
        })
      }
    }

    const onUnregisterSuccess = (agent_id: string): void => {
      fanout.detach(agent_id)
      if (sessionIdForCaller && channelWakeFanout) {
        channelWakeFanout.detachBySession(sessionIdForCaller)
      }
      if (agentIdHolder.current === agent_id) agentIdHolder.current = undefined
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessionIdForCaller = sid
        const now = Date.now()
        sessions.set(sid, {
          transport,
          server,
          sink,
          sessionId: sid,
          agentIdHolder,
          onRegisterSuccess,
          handshake: { attempted: new Set() },
          createdAt: now,
          lastActivityAt: now,
          clientInfo: undefined,
          originInfo: { origin: 'local', remote_addr: null },
        })
        log(`mcp session created: sid=${sid} sessions=${sessions.size}`)
        if (opts.orphanSessionLimit !== undefined) {
          enforceOrphanSessionLimit(now, opts.orphanSessionLimit)
        }
      }
    })
    transport.onclose = () => {
      if (transport.sessionId) finalizeSessionClose(transport.sessionId)
    }
    registerBusinessTools(
      server,
      db,
      getCallerAgentId,
      fanout,
      onRegisterSuccess,
      () => sessionIdForCaller,
      channelWakeFanout,
      () => transport,
      () => {
        const sid = sessionIdForCaller
        if (!sid) return undefined
        return sessions.get(sid)?.clientInfo
      },
      () => {
        const sid = sessionIdForCaller
        if (!sid) return undefined
        return sessions.get(sid)?.originInfo
      },
      context,
      onUnregisterSuccess,
      registerSvc,
      log,
      () => {
        const sid = sessionIdForCaller
        if (!sid) return undefined
        return sessions.get(sid)?.handshake.lastFailure
      }
    )
    server.connect(transport)
    const now = Date.now()
    return {
      transport,
      server,
      sink,
      sessionId: '',
      agentIdHolder,
      onRegisterSuccess,
      handshake: { attempted: new Set() },
      createdAt: now,
      lastActivityAt: now,
      originInfo: { origin: 'local', remote_addr: null },
    }
  }

  const handshakeRepo = new AgentsRepo(db)

  /**
   * Handshake-level identity rebind for kimi-code session-scoped connections.
   * Runs when an unbound session presents X-Kimi-Session-Id; terminal
   * outcomes are memoized per identity so the cheap path is a Set lookup.
   * Awaiting an in-flight bind before dispatch keeps the first post-init
   * tools/call from racing the probe into unknown_agent.
   */
  async function ensureKimiHandshakeBind(
    session: Session,
    req: FastifyRequest
  ): Promise<void> {
    if (session.agentIdHolder.current !== undefined) return
    if (session.handshake.inFlight) {
      await session.handshake.inFlight
      return
    }
    const identity = readKimiHandshakeHeaders(
      req.headers as Record<string, unknown>
    )
    if (!identity) return
    const key = `${identity.base_url ?? ''} ${identity.session_id}`
    if (session.handshake.attempted.has(key)) return
    const run = attemptKimiHandshakeBind({
      identity,
      connection_id: session.sessionId,
      repo: handshakeRepo,
      registerSvc,
      onRegisterSuccess: session.onRegisterSuccess,
      localDevice: context.localDevice,
      log,
    })
    const tracked = run
      .then(outcome => {
        if (outcome === 'bound') {
          session.handshake.lastFailure = undefined
        } else {
          session.handshake.lastFailure = outcome
        }
        if (outcome !== 'probe_failed') session.handshake.attempted.add(key)
      })
      .catch(error => {
        log(
          `mcp handshake bind error: sid=${session.sessionId} ` +
          `cause=${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => {
        if (session.handshake.inFlight === tracked) {
          session.handshake.inFlight = undefined
        }
      })
    session.handshake.inFlight = tracked
    await tracked
  }

  function authHashFor(req: FastifyRequest): string | null {
    const raw = req.headers['authorization']
    if (typeof raw !== 'string') return null
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    return createHash('sha256').update(trimmed).digest('hex')
  }

  interface ToolsCallBody {
    method?: string
    params?: { name?: string; arguments?: Record<string, unknown> }
  }

  function bindManagedSession(session: Session, token: string): void {
    session.managedToken = token
    const agent = opts.managed?.attach(token, session.sessionId)
    if (!agent) return
    session.onRegisterSuccess(agent.agent_id, agent.team)
    registerSvc.bindExistingConnection({
      connection_id: session.sessionId, agent_type: agent.agent_type!,
      delivery: agent.delivery, device: agent.device,
      team: agent.team, name: agent.name,
    })
  }

  opts.managed?.setBindingListener(token => {
    for (const session of sessions.values()) {
      if (session.managedToken === token) bindManagedSession(session, token)
    }
  })

  function managedRequestValid(session: Session, req: FastifyRequest): boolean {
    if (session.managedProxyToken !== undefined) {
      return req.headers['x-xats-managed-proxy-token'] === session.managedProxyToken
        && opts.managed?.claims.byToken(session.managedProxyToken) !== undefined
    }
    if (session.managedToken === undefined) return true
    return req.headers['x-xats-managed-token'] === session.managedToken
      && opts.managed?.claims.byToken(session.managedToken) !== undefined
  }

  const managedTools = new Set([
    'send_message', 'send_message_by_id', 'broadcast', 'broadcast_to_role',
    'get_inbox', 'list_agents', 'get_delivery_status', 'echo',
  ])

  async function bindManagedProxy(session: Session): Promise<void> {
    if (!session.managedProxyToken || !session.agentIdHolder.current) return
    const proxy = db.prepare(
      `SELECT claude_ui_pid,
       json_extract(delivery_payload, '$.channel_session_id') AS channel_session_id
       FROM agents
       WHERE agent_id = ? AND role = '__channel_proxy__'`
    ).get(session.agentIdHolder.current) as {
      claude_ui_pid: number | null; channel_session_id: string | null
    } | undefined
    if (!proxy?.claude_ui_pid || !proxy.channel_session_id
      || !channelWakeFanout?.has(proxy.channel_session_id)) return
    try {
      const result = await opts.managed?.bindClaudeProxy(
        session.managedProxyToken, proxy.claude_ui_pid, proxy.channel_session_id
      )
      if (result && 'error' in result) {
        log(`managed Claude bind failed: error=${result.error} `
          + `detail=${result.detail}`)
      }
    } catch (error) {
      log('managed Claude bind failed: '
        + describeRedactedError(error, session.managedProxyToken))
    }
  }

  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const body = req.body as ToolsCallBody | undefined
    const isInit = body?.method === 'initialize'
    let session = sid ? sessions.get(sid) : undefined
    const originInfo = (req as FastifyRequest & { xatsPeer?: SessionOriginInfo }).xatsPeer
      ?? { origin: 'local' as const, remote_addr: null }
    if (!session && !isInit) {
      log(`mcp unknown_session: route=POST method=${body?.method ?? 'unknown'} name=${body?.params?.name ?? 'none'} sid=${sid ?? 'none'} sessions=${sessions.size}`)
      return sendControlPlaneReject(reply, 404)
    }

    const managedToken = req.headers['x-xats-managed-token']
    const proxyToken = req.headers['x-xats-managed-proxy-token']
    if (session && (session.managedToken !== managedToken
      || session.managedProxyToken !== proxyToken)) {
      return sendControlPlaneReject(reply, 403)
    }
    if (proxyToken !== undefined) {
      if (typeof proxyToken !== 'string' || managedToken !== undefined
        || originInfo.origin !== 'local'
        || opts.managed?.claims.byToken(proxyToken)?.agent_type !== 'claude-code') {
        return sendControlPlaneReject(reply, 403)
      }
      if (session?.managedProxyToken && session.managedProxyToken !== proxyToken) {
        return sendControlPlaneReject(reply, 403)
      }
      if (session) session.managedProxyToken = proxyToken
      if (body?.method === 'tools/call') {
        const name = body.params?.name
        const args = body.params?.arguments
        if (!['register_agent', 'subscribe_channel_wake', 'echo'].includes(name ?? '')
          || (name === 'register_agent' && args?.role !== '__channel_proxy__')) {
          return sendControlPlaneReject(reply, 403)
        }
      }
    }
    if (session?.managedProxyToken && !managedRequestValid(session, req)) {
      return sendControlPlaneReject(reply, 403)
    }
    if (managedToken !== undefined) {
      if (typeof managedToken !== 'string' || originInfo.origin !== 'local'
        || !opts.managed?.claims.byToken(managedToken)) {
        return sendControlPlaneReject(reply, 403)
      }
      if (session) bindManagedSession(session, managedToken)
    }
    if (session?.managedToken !== undefined
      && managedToken !== session.managedToken) {
      return sendControlPlaneReject(reply, 403)
    }
    if (body?.method === 'tools/call') {
      const args = body.params?.arguments
      const channel = typeof args?.channel_session_id === 'string'
        ? args.channel_session_id.trim() : undefined
      if (body.params?.name === 'subscribe_channel_wake'
        && typeof channel === 'string'
        && managedDeliveryExists(db, context.localDevice, {
          kind: 'claude-channel', channel_session_id: channel,
        })
        && !opts.managed?.proxyAuthorized(session?.managedProxyToken, channel)) {
        return sendControlPlaneReject(reply, 403)
      }
      const protectedIdentity = managedIdentityExists(db, {
        device: context.localDevice,
        agent_id: session?.agentIdHolder.current,
        identity_key: typeof args?.identity_key === 'string'
          ? args.identity_key : undefined,
      })
      if ((protectedIdentity || managedToken !== undefined)
        && (!session?.managedToken
          || !opts.managed?.connectionValid(session.managedToken,
            session.sessionId)
          || !managedTools.has(body.params?.name ?? ''))) {
        return sendControlPlaneReject(reply, 403)
      }
    }

    // register_agent presenting a different Authorization header than the one that
    // first claimed this session id -> agent_id_collision (HTTP 409). Absence of
    // an Authorization header disables collision enforcement per spec.
    if (session && body?.method === 'tools/call' && body.params?.name === 'register_agent') {
      const authHash = authHashFor(req)
      if (authHash !== null) {
        const owner = sessionOwners.get(session.sessionId)
        if (owner && owner !== authHash) {
          return sendControlPlaneReject(reply, 409)
        }
        if (!owner) sessionOwners.set(session.sessionId, authHash)
      }
    }

    // Spoofed from_agent_id on tools/call -> 403. Compare against the session's
    // currently bound agent_id (post register_agent), NOT the raw MCP session id.
    if (session && body?.method === 'tools/call') {
      const claimed = body.params?.arguments?.from_agent_id
      if (typeof claimed === 'string') {
        const current = session.agentIdHolder.current
        if (current === undefined || claimed !== current) {
          return sendControlPlaneReject(reply, 403)
        }
      }
    }

    if (!session) { session = createSession() }
    if (session) {
      session.originInfo = originInfo
      session.lastActivityAt = Date.now()
    }

    // Handshake-level identity: a non-init request on a stored (unbound)
    // session awaits any in-flight bind, or starts one when it carries the
    // kimi identity headers — before the tool dispatch below can hit
    // unknown_agent. Init requests are handled after handleRequest, once the
    // session id exists.
    if (!isInit && managedToken === undefined) {
      await ensureKimiHandshakeBind(session, req)
    }

    if (body?.method === 'initialize') {
      const params = body.params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined
      const clientInfo = params?.clientInfo
      session.clientInfo = {
        name: typeof clientInfo?.name === 'string' ? clientInfo.name : undefined,
        version: typeof clientInfo?.version === 'string' ? clientInfo.version : undefined,
      }
    }
    await session.transport.handleRequest(req.raw, reply.raw, body)
    if (isInit && session.transport.sessionId) {
      const initialized = sessions.get(session.transport.sessionId)
      if (initialized) {
        initialized.originInfo = originInfo
        if (typeof proxyToken === 'string') {
          initialized.managedProxyToken = proxyToken
        }
        if (typeof managedToken === 'string') {
          bindManagedSession(initialized, managedToken)
        }
        // The initialize response is already written; start the bind in the
        // background and let the next request await it via inFlight.
        if (managedToken === undefined) {
          void ensureKimiHandshakeBind(initialized, req)
        }
      }
    }
    if (!isInit && session.managedProxyToken) await bindManagedProxy(session)
    return reply
  })

  app.get('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const session = sid ? sessions.get(sid) : undefined
    if (!session) {
      log(`mcp unknown_session: route=GET sid=${sid ?? 'none'} sessions=${sessions.size}`)
      return sendControlPlaneReject(reply, 404)
    }
    if (!managedRequestValid(session, req)) {
      return sendControlPlaneReject(reply, 403)
    }
    session.lastActivityAt = Date.now()
    await session.transport.handleRequest(req.raw, reply.raw)
    return reply
  })

  app.delete('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    const sid = req.headers['mcp-session-id'] as string | undefined
    const session = sid ? sessions.get(sid) : undefined
    if (!session) {
      log(`mcp unknown_session: route=DELETE sid=${sid ?? 'none'} sessions=${sessions.size}`)
      return sendControlPlaneReject(reply, 404)
    }
    if (!managedRequestValid(session, req)) {
      return sendControlPlaneReject(reply, 403)
    }
    session.lastActivityAt = Date.now()
    await session.transport.handleRequest(req.raw, reply.raw)
    return reply
  })

  function reapOrphanSessions(now: number, opts?: number | OrphanSessionGcOptions): void {
    const gc = normalizeGcOptions(opts)
    const survivors: Session[] = []
    for (const session of sessions.values()) {
      if (session.agentIdHolder.current !== undefined) continue
      const idleMs = now - session.lastActivityAt
      // GC is idle-based + cap-based. An orphan is reaped once it has had no
      // client transport activity within idleMs; an actively-transacting but
      // not-yet-registered client (e.g. a codex session mid-setup / just after
      // compact) is thereby exempt from time-based reaping. `maxAgeMs` is still
      // an accepted config knob (see normalizeGcOptions) for backward-compat but
      // is now INERT: exempting active sessions leaves max-age with nothing the
      // idle rule does not already catch, so it never fires independently. The
      // orphan cap below still bounds active orphans over maxSessions.
      if (idleMs >= gc.idleMs) {
        closeOrphanSession(session, now, 'idle')
        continue
      }
      survivors.push(session)
    }
    enforceOrphanSessionLimit(now, gc.maxSessions, survivors)
  }

  function sessionMetrics(): McpSessionMetrics {
    let registered = 0
    let orphan = 0
    for (const session of sessions.values()) {
      if (session.agentIdHolder.current === undefined) orphan += 1
      else registered += 1
    }
    return {
      total: sessions.size,
      registered,
      orphan,
      fanout: fanout.peek().length,
    }
  }

  return { reapOrphanSessions, sessionMetrics }
}
