import type Database from 'better-sqlite3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  AgentsRepo,
  sameIdentityRowSnapshot,
  type IdentityRowSnapshot,
} from '../storage/agents-repo.js'
import { EventsOutbox } from '../storage/events-outbox.js'
import {
  RegisterAgentService,
  deriveDefaultTeam,
  resolveEffectiveDevice,
} from './register-agent.js'
import { SendMessageService } from './send-message.js'
import { BroadcastService } from './broadcast.js'
import { BroadcastToRoleService } from './broadcast-to-role.js'
import { GetInboxService } from './get-inbox.js'
import { GetDeliveryStatusService } from './delivery-status.js'
import { poke } from './poke.js'
import { wrapStorage } from '../daemon/errors.js'
import type { SseFanout } from '../daemon/sse-fanout.js'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { SubscribeChannelWakeService } from './subscribe-channel-wake.js'
import { BindChannelService } from './bind-channel.js'
import { AutoBindChannelService } from './auto-bind-channel.js'
import {
  BindRuntimeIdentityService,
  type VerifiedRuntimeIdentity,
} from './bind-runtime-identity.js'
import { RegisterCodexSelfService } from './register-codex-self.js'
import { RegisterOpencodeSelfService } from './register-opencode-self.js'
import {
  resolveCodexReconnect,
  resolveIdentityKeyReconnect,
  resolveKimiReconnect,
  resolveOpencodeReconnect,
  resolveReconnect,
  validateKimiSession,
  type ReconnectCandidate,
  type ReconnectResolution,
} from './reconnect.js'
import { canonicalKimiBaseUrl, kimiBaseUrlIssue } from '../lib/kimi-url.js'
import { UnregisterSelfService } from './unregister-self.js'
import { listAgentsForTeam } from './list-agents.js'
import { detectTmuxPane } from '../daemon/tmux-pane-detect.js'
import { bindRuntimeIdentity } from '../daemon/runtime-identity.js'
import type { DetectAgentKind } from '../daemon/tmux-pane-detect.js'
import type { AgentType } from '../lib/agent-type.js'
import { CodexPanePreRegRepo } from './codex-pane-pre-register-repo.js'
import {
  PreRegisterCodexPaneService,
  preRegisterCodexPaneInputSchema,
} from './pre-register-codex-pane.js'
import {
  autoBindCodexPane,
  detectForegroundCodexCarrierPid,
} from './auto-bind-codex-pane.js'
import {
  followSeatIdentityKey,
  type SeatFollowDeps,
} from './codex-seat-follow.js'
import {
  collapseSameThreadRows,
  type InheritSeat,
  type SameThreadCollapse,
} from './same-thread-seat.js'
import {
  cancelCodexRecoverySchedule,
  evaluateCodexRecoveryOnPreRegister,
  type CodexRecoveryDeps,
} from './codex-recovery-poke.js'
import {
  cancelCodexSeedingSchedule,
  evaluateCodexSeedingOnPreRegister,
  type CodexSeedingDeps,
} from './codex-seeding-poke.js'
import type { SessionOriginInfo } from '../daemon/network-origin.js'
import { isAlive } from '../daemon/pid.js'
import { consumeCodexRecoveryNonce } from './codex-recovery-nonce.js'
import type { DaemonContext } from '../daemon/server.js'

export interface AgentIdHolder { current: string | undefined }

type TextContent = { content: Array<{ type: 'text'; text: string }> }

function toText(value: unknown): TextContent {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

const deliverySchema = z.object({
  kind: z.string(),
}).passthrough()

const agentTypeSchema = z.enum(['codex', 'claude-code', 'opencode', 'kimi-code', 'custom'])

const detectTmuxPaneSchema = z.object({
  agent: z.enum(['codex', 'claude-code', 'opencode', 'custom']),
  cwd: z.string().optional(),
  tty: z.string().optional(),
  title_contains: z.string().optional(),
  process_pattern: z.string().optional(),
})

const detectTmuxPaneArgsSchema = detectTmuxPaneSchema.superRefine((value, ctx) => {
  if (value.agent === 'custom' && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['process_pattern'],
      message: 'process_pattern is required when agent=custom',
    })
  }
})

const bindRuntimeIdentitySchema = z.object({
  agent: z.enum(['codex', 'claude-code', 'opencode', 'custom']),
  ui_pid: z.number().int().positive().optional(),
  ui_tty: z.string().optional(),
  tmux_pane_id: z.string().min(1).optional(),
  process_pattern: z.string().optional(),
})

const bindRuntimeIdentityArgsSchema = bindRuntimeIdentitySchema.superRefine((value, ctx) => {
  if (value.agent === 'custom' && (!value.process_pattern || value.process_pattern.trim().length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['process_pattern'],
      message: 'process_pattern is required when agent=custom',
    })
  }
  const hasPid = value.ui_pid !== undefined
  const hasTtyPair =
    value.ui_tty !== undefined &&
    value.ui_tty.trim().length > 0 &&
    value.tmux_pane_id !== undefined &&
    value.tmux_pane_id.trim().length > 0
  if (!hasPid && !hasTtyPair) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'provide ui_pid, or ui_tty together with tmux_pane_id',
    })
  }
})

const SEND_MESSAGE_DESC = [
  'Private 1→1 message to another agent by name.  By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.',
  'Set need_reply:false for FYI/no-response-needed messages; recipients see need_reply in get_inbox.',
  'to_agent_name is the target\'s `name` within its team; bare names resolve on the caller\'s device, and `name:device` targets a specific device.  For UUID-based sends use send_message_by_id.',
  'If the user refers to a recipient in the shorthand `name(team)` (e.g. `skills-creator(default)`), split it into `to_agent_name`=`skills-creator` and `to_team`=`default`. The daemon does NOT parse `name(team)`, so the literal string fails to resolve (unknown_recipient). This is distinct from the `name:device` suffix, which the daemon DOES parse.',
  'REPLY RULE: when replying to a message returned by get_inbox, treat its `from_device` as authoritative — if it differs from your own device, you MUST send to `from_name + ":" + from_device` (bare `from_name` would resolve on YOUR device and miss the actual sender). Same-device replies can use the bare name. The safe fallback for unknown device is send_message_by_id({to_agent_id: from_agent_id, ...}).',
  'For multi-recipient use broadcast (same-team) or broadcast_to_role (same-team, by role).',
  '除非用户明确指定 to_team, 不要跨 team 沟通 (explicitly set to_team only when user asks).',
  'Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, pane_reassigned, self, kimi_session_busy, kimi_pending_interaction); on guard_failed and kimi_session_busy daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.  kimi_session_busy / kimi_pending_interaction mean the kimi session was mid-turn or waiting on a human approval so the wake-up was NOT injected — the mailbox row is written regardless and the recipient sees it on its next get_inbox; kimi_pending_interaction is never retried.  pane_reassigned means the recorded tmux pane is no longer hosted by the target (another agent took it over, or the target process is gone), so nothing was injected; it is never retried and the mailbox row is still written.',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender> → <recipient_name>@<recipient_team>, 请调 get_inbox 查看), NOT the body — read bodies via get_inbox.  The → segment names who the wake-up was addressed to, so a pane that receives one but finds an empty get_inbox can tell at a glance it was not the intended recipient.',
  'Delivery is NOT filtered by online/idle; direct and fan-out deliveries write mailbox rows for offline targets. The list_agents `online` flag reflects process liveness.',
  'DO NOT pre-verify the recipient via list_agents before calling send_message — this rule applies to BOTH same-team and cross-team sends (list_agents is caller-team scoped and CANNOT see cross-team agents, so a cross-team pre-check always falsely reports "missing"; for same-team sends the pre-check is pure waste).',
  'On miss send_message returns unknown_recipient cleanly with no side effects, so the correct pattern is "try send, then handle unknown_recipient" — never "list_agents first, then send".'
].join(' ')

const SEND_MESSAGE_BY_ID_DESC = [
  'Private 1→1 message to another agent by agent_id (UUID).  Use this when you already hold the target\'s agent_id; prefer send_message (by name) otherwise.',
  'Same-team only: the recipient must belong to the caller\'s team.  For cross-team sends use send_message with to_team.',
  'By default auto-poke=true with quiet-guard (auto_poke:false opts out), and need_reply=true.  Set need_reply:false for FYI/no-response-needed messages.',
  'Reports poked, poke_skip_reasons (no_pane, guard_failed, tmux_unavailable, pane_reassigned, self, kimi_session_busy, kimi_pending_interaction); on guard_failed and kimi_session_busy daemon retries at 30s/180s/600s (retry_scheduled, retry_delays_s); stops early on poked.  kimi_session_busy / kimi_pending_interaction mean the kimi session was mid-turn or waiting on a human approval so the wake-up was NOT injected — the mailbox row is written regardless and the recipient sees it on its next get_inbox; kimi_pending_interaction is never retried.  pane_reassigned means the recorded tmux pane is no longer hosted by the target (another agent took it over, or the target process is gone), so nothing was injected; it is never retried and the mailbox row is still written.',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender> → <recipient_name>@<recipient_team>, 请调 get_inbox 查看), NOT the body — read bodies via get_inbox.  The → segment names who the wake-up was addressed to, so a pane that receives one but finds an empty get_inbox can tell at a glance it was not the intended recipient.',
  'Delivery is NOT filtered by online/idle — offline targets still receive the mailbox row.'
].join(' ')

const BROADCAST_DESC = [
  'Same-team broadcast to every other agent in the caller team across all devices; delivers to every team member except the sender.',
  'Auto-poke default true (quiet-guard on tmux targets, busy-gate on kimi targets; both retry at 30s/180s/600s — reports poked, poke_skip_reasons, retry_scheduled, retry_delays_s).  auto_poke:false opts out.  See send_message for what each poke_skip_reasons value means, incl. pane_reassigned (the recipient no longer hosts its recorded tmux pane, so no wake-up was injected; never retried, mailbox row still written).',
  'For role filter use broadcast_to_role.  For cross-team 1→1 use send_message({to_team}).',
  'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender> → <recipient_name>@<recipient_team>, 请调 get_inbox 查看) — never the body.  Read via get_inbox.',
  'Delivery is NOT filtered by online/idle; offline targets still receive mailbox rows. The list_agents `online` flag reflects process liveness.'
].join(' ')

const BROADCAST_TO_ROLE_DESC = [
  'Same-team broadcast filtered by role across all devices; delivers to every matching team member.  Strictly same-team — no cross-team variant.',
  'For cross-team private 1→1 use send_message({to_team}).',
  'Auto-poke default true with quiet-guard on tmux targets / busy-gate on kimi targets, both retrying at 30s/180s/600s (auto_poke:false opts out); injects only a SHORT wake-up hint, not the message body.  Recipients read via get_inbox.',
  'See send_message for what each poke_skip_reasons value means, incl. pane_reassigned (the recipient no longer hosts its recorded tmux pane, so no wake-up was injected; never retried, mailbox row still written).',
  'Returns unknown_recipient when no same-team agent matches to_role.'
].join(' ')

const RECONNECT_DESC = [
  'Recover this session\'s prior xats identity when you no longer remember ' +
    'your own (team, name), such as after a context clear.',
  'Invoke this when the user asks to "reconnect xats", "re-register xats", ' +
    '"重连 xats", or "重新注册 xats".',
  'BRANCH 1 (check this first): if `printenv XATS_IDENTITY_KEY` is ' +
    'non-empty, call `reconnect({identity_key: <that value>, ui_pid: ' +
    '$PPID})` — or `reconnect({identity_key: <that value>, thread_id: ' +
    '$CODEX_THREAD_ID})` from codex — before considering the two branches ' +
    'below. `identity_key` is the only lookup that survives a pane restart, ' +
    'and it does NOT belong to the exactly-one group below: it resolves the ' +
    'identity while the accompanying `ui_pid` / `thread_id` refreshes the ' +
    'live runtime in the same call. This branch must come first because a ' +
    'restarted pane both holds a key and no longer remembers its ' +
    '(team, name), so the later branches would capture the case and fail. ' +
    'On a `need_register` result, ask the user for (team, name) as usual ' +
    'and pass the same `identity_key` on that `register_agent` call.',
  'Otherwise pass exactly one runtime lookup key: Claude Code passes `ui_pid=$PPID`; ' +
    'Codex CLI and Mac Codex App pass ' +
    '`thread_id=$CODEX_THREAD_ID`; opencode passes ' +
    '`base_url=$OPENCODE_XATS_BASE_URL` (and optionally `session_id`); ' +
    'kimi-code passes `agent_type="kimi-code"`, ' +
    '`base_url=$KIMI_XATS_BASE_URL`, plus a REQUIRED ' +
    '`session_id=$KIMI_XATS_SESSION_ID`.',
  'Claude Code lookup uses local `runtime_ui_pid` and reuses the existing ' +
    'channel and pane binding paths.',
  'For Codex CLI and Mac Codex App, `CODEX_THREAD_ID` is the stable ' +
    'conversation/thread identity when the same task is resumed after a ' +
    'context clear, MCP session replacement, or conversation resume. Do not ' +
    'use the ' +
    'App pid, app-server pid, or an old database row as proof of identity.',
  'Codex lookup uses the local codex-appserver delivery `thread_id`. On a ' +
    'single match, the daemon verifies `thread/resume` through the configured ' +
    'Codex app-server before reusing the identity and rebinding the current ' +
    'connection and fanout. No agent row is mutated when that verification ' +
    'fails.',
  'Codex `ws_url` and `auth_token_ref` are optional and follow ' +
    'register_agent defaults.',
  'opencode lookup uses the local `opencode-server` delivery ' +
    '(base_url, session_id) pair. The daemon always revalidates the session ' +
    'against `<base_url>/session` through the server before reusing an ' +
    'identity: when `session_id` is omitted it picks the most recently ' +
    'updated session; when supplied it confirms that id still exists. A ' +
    'stale/unknown id returns `session_not_found` and no row is mutated. ' +
    'For authenticated servers pass `auth_token_ref` (env-var name whose ' +
    'value is the OPENCODE_SERVER_PASSWORD; username defaults to opencode or ' +
    'OPENCODE_SERVER_USERNAME, both sent as HTTP Basic auth verbatim); ' +
    '`missing_auth_token` is returned when the referenced env var is unset. ' +
    'When reconnect omits `auth_token_ref`, the daemon first recovers a ' +
    'stored ref from candidate rows: a single shared ref across candidates ' +
    'is used to pre-validate the server (this is not identity selection) and ' +
    'the row\'s ref is preserved on reuse. `auth_ambiguous` (zero write) is ' +
    'returned when candidates carry multiple distinct non-empty refs, OR when ' +
    'candidates mix ref and no-ref rows — in either case `detail.refs` lists ' +
    'only the known non-empty refs (possibly a single element in the mixed ' +
    'case); supply `auth_token_ref` explicitly to resolve.',
  'kimi-code lookup uses the local `kimi-server` delivery ' +
    '(base_url, session_id) pair. Pass `agent_type="kimi-code"` — it is the ' +
    'runtime discriminator for the base_url arm; without it a kimi reconnect ' +
    'is routed by local row residency and, when no rows match, falls to the ' +
    'opencode probe with opencode-flavored errors instead of ' +
    '`need_register`. `session_id` is REQUIRED for the kimi ' +
    'path — the daemon never auto-resolves a kimi session by ' +
    'recency, because several kimi sessions routinely share a workDir and ' +
    'binding the wrong one misdelivers pokes while reporting success. The ' +
    'daemon revalidates via GET <base_url>/api/v1/sessions/<session_id> with ' +
    'the poke dispatcher\'s bearer resolution (stored auth_token_ref, else ' +
    'the kimi token file) before reusing the identity; a missing/archived ' +
    'session or failed probe returns `session_not_found` and no row is ' +
    'mutated. On success the connection shares with live engine connections ' +
    'of the same session instead of taking over. In the common case the ' +
    'whole recovery is restarting the TUI: the launcher re-exports ' +
    'KIMI_XATS_BASE_URL / KIMI_XATS_SESSION_ID.',
  'On a single match: returns { ok, agent_id, name, team, last_seen_at } ' +
    'plus the runtime-specific delivery fields.',
  'On zero matches: returns { need_register, reason } — reconnect does NOT ' +
    'auto-register; call register_agent to create a new identity.',
  'On multiple matches: returns { ambiguous, candidates } ordered by ' +
    'last_seen_at descending and does not choose or mutate a row.',
  'Each candidate/match carries last_seen_at. A successful Codex resume ' +
    'proves the current app-server can load the thread, but cannot prove a ' +
    'stale stored identity still owns a reused thread id; surface stale or ' +
    'ambiguous matches instead of trusting them without surfacing. The same ' +
    'applies ' +
    'to opencode: a reachable server proves the session exists, not that a ' +
    'stale stored row still owns it.',
  'If you still remember (team, name), call register_agent directly instead ' +
    'of reconnect.',
].join(' ')

function isWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'ws:' || url.protocol === 'wss:'
  } catch {
    return false
  }
}

function suppressTmuxHint(
  args: { delivery?: { kind?: string } }
): boolean {
  return args.delivery?.kind !== undefined && args.delivery.kind !== 'none'
}

function defaultClaudeSelfModel(
  clientInfo: SessionClientInfo | undefined
): string {
  const raw = `${clientInfo?.name ?? ''} ${clientInfo?.version ?? ''}`.trim()
  if (/claude/i.test(raw)) return raw
  return 'claude-code'
}

export const HINT_MAX_CHARS = 200

export function buildAutoPokeHint(
  row: { name?: string | null } | undefined,
  fromAgentId: string,
  target?: { name?: string | null; team?: string | null } | undefined
): string {
  const dn = row?.name
  const sender = typeof dn === 'string' && dn.length > 0
    ? `${dn} (${fromAgentId})`
    : fromAgentId.slice(0, 8)
  const targetName = target?.name
  const targetTeam = target?.team
  const to = typeof targetName === 'string' && targetName.length > 0
    && typeof targetTeam === 'string' && targetTeam.length > 0
    ? ` → ${targetName}@${targetTeam}`
    : ''
  const render = (who: string, segment: string): string =>
    `新邮件 from ${who}${segment}, 请调 get_inbox 查看`
  // Neither name carries a schema length cap, so the hint sheds the target
  // segment first and then the sender's display name, in that order, rather
  // than letting either push it past HINT_MAX_CHARS.
  for (const candidate of [render(sender, to), render(sender, ''), render(fromAgentId.slice(0, 8), '')]) {
    if (candidate.length <= HINT_MAX_CHARS) return candidate
  }
  return render(fromAgentId.slice(0, 8), '')
}

export function createAutoPokeImpl(
  db: Database.Database,
  _agents: AgentsRepo,
  channelWakeFanout?: ChannelWakeFanout,
  localDevice?: string
): import('./auto-poke-fanout.js').AutoPokeFn {
  return async (args) => {
    const row = db
      .prepare('SELECT name FROM agents WHERE agent_id=?')
      .get(args.fromAgentId) as { name: string | null } | undefined
    const target = db
      .prepare('SELECT name, team FROM agents WHERE agent_id=?')
      .get(args.targetAgentId) as { name: string | null; team: string } | undefined
    const hint = buildAutoPokeHint(row, args.fromAgentId, target)
    const res = await poke(
      {
        db,
        callerAgentId: args.fromAgentId,
        allowCrossTeam: true,
        channelWakeFanout,
        localDevice,
        paneSnapshot: args.paneSnapshot,
      },
      { target_agent_id: args.targetAgentId, prompt: hint, skipGuard: args.skipGuard }
    )
    if ('ok' in res && res.ok) return { ok: true }
    const err = (res as { error?: string }).error
    if (err === 'codex_turn_start_unconfirmed' || err === 'codex_wake_unconfirmed') {
      // The app-server accepted the turn input. Confirmation uncertainty must
      // not trigger tmux fallback or retry duplicate delivery.
      return { ok: true }
    }
    // kimi deferrals are "not injected yet", not delivery failures: they route
    // to the kimi retry gradient, and pending_interaction to nothing at all.
    if (err === 'kimi_session_busy') return { ok: false, reason: 'kimi_session_busy' }
    if (err === 'kimi_pending_interaction') {
      return { ok: false, reason: 'kimi_pending_interaction' }
    }
    if (err === 'pane_reassigned') return { ok: false, reason: 'pane_reassigned' }
    if (err === 'tmux_unavailable') return { ok: false, reason: 'tmux_unavailable' }
    if (err === 'tmux_pane_not_set') return { ok: false, reason: 'no_pane' }
    if (err === 'no_transport_available') return { ok: false, reason: 'no_pane' }
    if (err === 'self_poke_denied') return { ok: false, reason: 'self' }
    // Remaining errors (incl. guard_failed) map to guard_failed so the retry
    // scheduler picks them up; this preserves the pre-change fall-through.
    return { ok: false, reason: 'guard_failed' }
  }
}

export interface RegisterSuccessHook {
  (agent_id: string, team: string): void
}

export interface UnregisterSuccessHook {
  (agent_id: string): void
}


export interface TransportLike {
  send(msg: Record<string, unknown>): Promise<void> | void
}

export interface SessionClientInfo {
  name?: string
  version?: string
}

function inferRuntimeAgentKind(
  args: { agent_type?: AgentType; delivery?: { kind?: string }; model?: string },
  clientInfo: SessionClientInfo | undefined
): DetectAgentKind | undefined {
  if (args.agent_type === 'custom') return undefined
  // kimi-code has no tmux runtime-bind matcher; its delivery is HTTP-only.
  if (args.agent_type === 'kimi-code') return undefined
  if (args.agent_type) return args.agent_type
  if (args.delivery?.kind === 'codex-appserver') return 'codex'

  const raw = `${clientInfo?.name ?? ''} ${clientInfo?.version ?? ''} ${args.model ?? ''}`.toLowerCase()
  if (raw.includes('codex')) return 'codex'
  if (raw.includes('gpt-')) return 'codex'
  if (raw.includes('claude')) return 'claude-code'
  if (raw.includes('opus') || raw.includes('sonnet')) return 'claude-code'
  if (raw.includes('opencode')) return 'opencode'
  return undefined
}

type SameThreadOutcome =
  | 'none'
  | 'inherit'
  | 'inherit_seat_vacated'
  | 'inherit_fail_closed'
  | 'ambiguous'
  | 'cas_drift'

/** What each outcome means for the paths BELOW it, spelled out in the log so
 *  a reader never has to infer which of them was skipped. */
const SAME_THREAD_TAIL: Record<SameThreadOutcome, string> = {
  inherit: '; pre-reg scan skipped',
  none: '; proceeding to pre-reg scan',
  inherit_seat_vacated:
    '; seat carrier gone — pre-reg scan only, no pane detection',
  inherit_fail_closed:
    '; fail closed — no pre-reg scan, no pane detection, no runtime bind',
  ambiguous:
    '; fail closed — no pre-reg scan, no pane detection, no runtime bind',
  cas_drift:
    '; fail closed — no pre-reg scan, no pane detection, no runtime bind',
}

/**
 * Positive proof that the seat's carrier is GONE: a recorded positive pid
 * that is not running.  A pid-less seat (a tty/pane bind records none) is
 * liveness UNKNOWN, never "dead" — the same rule the identity-key
 * arbitration and seat-follow already hold to.
 */
function seatCarrierGone(seat: InheritSeat): boolean {
  const pid = seat.runtime_ui_pid
  return pid !== null && pid > 0 && !isAlive(pid)
}

export function registerBusinessTools(
  server: McpServer,
  db: Database.Database,
  getCallerAgentId: () => string | undefined,
  fanout?: SseFanout,
  onRegisterSuccess?: RegisterSuccessHook,
  getSessionId?: () => string | undefined,
  channelWakeFanout?: ChannelWakeFanout,
  getTransport?: () => TransportLike,
  getSessionClientInfo?: () => SessionClientInfo | undefined,
  getSessionOriginInfo?: () => SessionOriginInfo | undefined,
  context?: DaemonContext,
  onUnregisterSuccess?: UnregisterSuccessHook,
  injectedRegisterSvc?: RegisterAgentService,
  log?: (line: string) => void
): void {
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)
  const registerSvc = injectedRegisterSvc ?? new RegisterAgentService(db, {
    localDevice: context?.localDevice,
    getSessionOrigin: () => getSessionOriginInfo?.(),
  })
  const bindRuntimeIdentitySvc = new BindRuntimeIdentityService(db, log)
  const registerCodexSelfSvc = new RegisterCodexSelfService(registerSvc)
  const registerOpencodeSelfSvc = new RegisterOpencodeSelfService(registerSvc)
  const unregisterSelfSvc = new UnregisterSelfService(db, agents)

  const autoPokeImpl = createAutoPokeImpl(db, agents, channelWakeFanout, context?.localDevice)

  const sendSvc = new SendMessageService(db, agents, events, { poke: autoPokeImpl })
  const broadcastSvc = new BroadcastService(db, agents, { poke: autoPokeImpl })
  const broadcastToRoleSvc = new BroadcastToRoleService(db, agents, events, { poke: autoPokeImpl })
  const inboxSvc = new GetInboxService(db, agents)
  const deliveryStatusSvc = new GetDeliveryStatusService(db)
  const codexPanePreRegRepo = new CodexPanePreRegRepo(db)
  const recoveryLocalDevice = context?.localDevice ?? 'local'
  const codexRecoveryDeps: CodexRecoveryDeps = {
    repo: codexPanePreRegRepo,
    findByIdentityKey: key =>
      agents.findByIdentityKey(key, recoveryLocalDevice),
    localDevice: recoveryLocalDevice,
    log,
  }
  const codexSeedingDeps: CodexSeedingDeps = { repo: codexPanePreRegRepo, log }
  const preRegisterCodexPaneSvc = new PreRegisterCodexPaneService(
    codexPanePreRegRepo,
    undefined,
    row => {
      // Recovery first: a pane it schedules must already hold its token when
      // the seeding trigger decides which panes still need one.
      evaluateCodexRecoveryOnPreRegister(row, codexRecoveryDeps)
      evaluateCodexSeedingOnPreRegister(row, codexSeedingDeps)
    },
    log
  )
  const seatFollowDeps: SeatFollowDeps = {
    findCaller: agentId => {
      const row = agents.findById(agentId)
      if (!row) return undefined
      return {
        team: row.team,
        name: row.name,
        identity_key: row.identity_key,
        codex_thread_id:
          row.delivery.kind === 'codex-appserver'
            ? row.delivery.thread_id
            : null,
      }
    },
    findKeyHoldersBySeat: agentId =>
      agents.findKeyHoldersBySeat(agentId, recoveryLocalDevice),
    applyPlan: (plan, attachAgentId, key) => {
      // Same transactional shape as register_agent: the old row must not
      // lose the key unless the caller row gets it.
      const tx = db.transaction(() => {
        if (plan.kind === 'migrate') {
          agents.clearIdentityKey(plan.from_agent_id)
        }
        agents.bindIdentityKey(attachAgentId, key)
      })
      tx()
    },
    log,
  }

  // SEAT-FOLLOW hook: runs after a codex registration's runtime bind settles
  // so a key still attached to the seat's previous row follows the seat.
  // followSeatIdentityKey catches internally; this guard only covers a
  // throwing log sink, keeping register_agent results uncorrupted.
  function runCodexSeatFollow(callerAgentId: string): void {
    try {
      followSeatIdentityKey({ callerAgentId, deps: seatFollowDeps })
    } catch { /* best-effort */ }
  }

  function caller(): string | undefined { return getCallerAgentId() }

  async function run(fn: () => unknown): Promise<TextContent> {
    const out = await wrapStorage(() => fn())
    touchIfRegistered()
    return toText(out)
  }

  function touchIfRegistered(): void {
    const c = caller()
    if (!c) return
    try {
      if (agents.findById(c)) agents.touch(c)
    } catch { /* best-effort */ }
  }

  function requireAgent(): string | { error: 'unknown_agent' } {
    const c = caller()
    if (!c) return { error: 'unknown_agent' }
    const row = agents.findById(c)
    if (!row) return { error: 'unknown_agent' }
    return c
  }

  /**
   * SAME-THREAD EVIDENCE (unified semantics): once ANY row on this device
   * proves the registering codex-appserver thread already had a bound
   * runtime, the registration is a same-conversation re-registration.  It
   * must NEVER scan foreign pre-reg rows and NEVER run unrestricted global
   * pane detection — the only correlation either has is "unique machine-wide
   * candidate", which is no caller association at all.  Evidence rows
   * collapse by PHYSICAL seat (a rename chain A→B→C leaves old rows with
   * pid/tty intact, only the pane LWW-cleared): a unique seat is inherited
   * exactly; distinct seats fail closed.  The caller's own upsert-reused row
   * counts as evidence only when its PRE-UPSERT stored thread equals the
   * registering thread (same-name re-register); a NEW thread (restart
   * recovery) contributes nothing, keeping the pre-reg scan reachable.
   */
  function resolveSameThreadSeat(
    callerAgentId: string,
    preUpsertThreadId: string | undefined
  ): SameThreadCollapse {
    const callerRow = agents.findById(callerAgentId)
    if (!callerRow || callerRow.delivery.kind !== 'codex-appserver') {
      return { kind: 'none', rowCount: 0, seatCount: 0 }
    }
    const thread = callerRow.delivery.thread_id
    const rows = agents
      .findRuntimeByThread(thread, recoveryLocalDevice)
      .filter(row =>
        row.agent_id !== callerAgentId || preUpsertThreadId === thread)
    return collapseSameThreadRows(rows)
  }

  /**
   * ONE decision point for the same-thread resolution: EVERY outcome (none /
   * inherit success & failure / ambiguous / CAS drift) logs through here with
   * row count, seat count, and involved agent ids — never key values.
   */
  function logSameThreadDecision(args: {
    callerAgentId: string
    outcome: SameThreadOutcome
    rowCount: number
    seatCount: number
    agentIds: string[]
    reason?: string
  }): void {
    const tail = SAME_THREAD_TAIL[args.outcome]
    log?.(
      `same-thread decision (debug): caller=${args.callerAgentId} ` +
      `outcome=${args.outcome} rows=${args.rowCount} ` +
      `seats=${args.seatCount} ` +
      `agents=${args.agentIds.length > 0 ? args.agentIds.join(',') : '-'}` +
      (args.reason === undefined ? '' : ` reason=${args.reason}`) +
      tail
    )
  }

  /**
   * Inherit EXACTLY the collapsed seat: a positive pid re-verifies live via
   * the pid bind path; a pid-less seat binds its recorded tty/pane with no
   * detection.  Bind failure, or a seat with no bindable runtime info,
   * fails closed — never the global detect path, never the pre-reg scan.
   */
  async function inheritSameThreadSeat(
    callerAgentId: string,
    seat: InheritSeat,
    expectedRegisterGeneration: number
  ): Promise<
    | { ok: true }
    | { ok: false; reason: string; superseded: boolean }
  > {
    const pid = seat.runtime_ui_pid
    const bound = pid !== null && pid > 0
      ? await bindRuntimeIdentitySvc.bind({
          callerAgentId,
          agent: 'codex',
          ui_pid: pid,
          expectedRegisterGeneration,
        })
      : seat.runtime_tty !== null && seat.tmux_pane_id !== null
        ? await bindRuntimeIdentitySvc.bind({
            callerAgentId,
            agent: 'codex',
            ui_tty: seat.runtime_tty,
            tmux_pane_id: seat.tmux_pane_id,
            expectedRegisterGeneration,
          })
        : undefined
    if (bound !== undefined && 'ok' in bound && bound.ok) {
      runCodexSeatFollow(callerAgentId)
      return { ok: true }
    }
    return {
      ok: false,
      reason: bound === undefined ? 'no_bindable_runtime_info' : 'bind_failed',
      // A registration the row has already moved past must act on NOTHING.
      // Its bind failed because it was superseded, not because the seat is
      // vacant, so no amount of liveness evidence may reopen a path for it.
      superseded: bound !== undefined && 'error' in bound
        && bound.error === 'stale_registration_bind',
    }
  }

  /**
   * A recovery nonce, when the caller echoes one back, names the pane the
   * daemon itself poked — so it SELECTS the row instead of leaving the scan to
   * infer one from "exactly one machine-wide candidate".  Spending it here
   * (rather than after a successful bind) keeps it single-use even when the
   * bind then fails: a token that survived a failure could re-target a later
   * registration at a pane that has moved on.  An unknown token resolves to
   * nothing and the scan proceeds exactly as before.
   */
  async function tryCodexPreRegScan(
    callerAgentId: string,
    expectedRegisterGeneration: number,
    recoveryNonce?: string
  ): Promise<boolean> {
    const targetPaneId = recoveryNonce === undefined
      ? undefined
      : consumeCodexRecoveryNonce(recoveryNonce)
    if (recoveryNonce !== undefined) {
      log?.(
        `codex-recovery nonce (debug): caller=${callerAgentId} ` +
        `outcome=${targetPaneId === undefined ? 'unknown' : 'resolved'} ` +
        `pane=${targetPaneId ?? '-'}`
      )
    }
    const auto = await autoBindCodexPane({
      callerAgentId,
      repo: codexPanePreRegRepo,
      bindRuntimeIdentitySvc,
      expectedRegisterGeneration,
      targetPaneId,
      // One synchronous transaction for "re-arbitrate the key → write the
      // runtime binding (with its incumbent-pane eviction) → consume the row
      // → attach the key"; better-sqlite3 nests via savepoints, so the
      // attach's own transaction composes inside this one.  Rollback is the
      // complete undo — nothing to compensate for afterwards.
      runAtomic: fn => db.transaction(fn)(),
      identityKeyAttach: {
        findCaller: agentId => {
          const row = agents.findById(agentId)
          if (!row) return undefined
          return {
            team: row.team,
            name: row.name,
            identity_key: row.identity_key,
          }
        },
        findByIdentityKey: key =>
          agents.findByIdentityKey(key, recoveryLocalDevice),
        applyPlan: (plan, attachAgentId, key) => {
          // Same transactional shape as register_agent: the old row must
          // not lose the key unless the caller row gets it.
          const tx = db.transaction(() => {
            if (plan.kind === 'migrate') {
              agents.clearIdentityKey(plan.from_agent_id)
            }
            agents.bindIdentityKey(attachAgentId, key)
          })
          tx()
        },
        log,
      },
      onConsumed: paneId => {
        cancelCodexRecoverySchedule(paneId, { reason: 'row_consumed', log })
        cancelCodexSeedingSchedule(paneId, { reason: 'row_consumed', log })
      },
      log,
    })
    if (auto === false) return false
    // Seat-follow only after a CONSUMED row: a stale outcome means the
    // pre-reg row was overwritten during the bind, and re-attaching the
    // seat key here would bypass the full-snapshot consume protection.
    if (auto === 'bound_consumed') runCodexSeatFollow(callerAgentId)
    return true
  }

  function paneHasPendingPreReg(paneId: string): boolean {
    const pending = codexPanePreRegRepo.getByPaneId(paneId)
    return pending !== undefined
      && pending.expires_at > new Date().toISOString()
  }

  /**
   * A pane with a PENDING pre-reg row is a pane some launcher announced for a
   * codex that has not registered yet.  Had the caller been that codex, the
   * pre-reg scan would have consumed the row (uuid + foreground carrier
   * proof); it did not, so this pane belongs to another identity — and
   * `detect_tmux_pane` scores panes machine-wide with NO caller correlation at
   * all, so it is exactly the wrong tool to overrule that.
   *
   * The check sits in the SAME synchronous commit as the runtime write: every
   * fallback shape still awaits probes before committing, and a launcher
   * announcing that pane inside that window would otherwise be overruled by a
   * bind with no caller correlation whatsoever.
   */
  function commitFallbackBind(
    verified: VerifiedRuntimeIdentity,
    paneId: string,
    callerAgentId: string
  ): boolean {
    return db.transaction(() => {
      if (paneHasPendingPreReg(paneId)) {
        log?.(
          `auto-bind skip (debug): pane=${paneId} ` +
          `reason=pane_has_pending_prereg caller=${callerAgentId}`
        )
        return false
      }
      const written = bindRuntimeIdentitySvc.commit(callerAgentId, verified)
      return !('error' in written)
    })()
  }

  /**
   * Codex prefers a pid bind: when the detected pane's tty hosts exactly one
   * foreground codex carrier, bind with its REAL pid so the caller row records
   * runtime_ui_pid (used by liveness and poke carrier confirms).  The pid is
   * heuristically chosen — detectTmuxPane scores ALL panes and the probe only
   * proves "unique foreground codex on that tty" — so it is NOT caller
   * association: seat-follow authorizes alive-holder migration by
   * codex-appserver thread equality only.  A failed pid verify is terminal for
   * this bind; it does not fall through to the tty shape.
   */
  async function verifyFallbackIdentity(
    inferredAgent: DetectAgentKind,
    callerAgentId: string,
    pane: { pane_id: string; tty: string },
    expectedRegisterGeneration: number
  ): Promise<VerifiedRuntimeIdentity | undefined> {
    if (inferredAgent === 'codex') {
      const carrierPid = await detectForegroundCodexCarrierPid(pane.tty)
      if (carrierPid !== undefined) {
        const byPid = await bindRuntimeIdentitySvc.verify({
          callerAgentId,
          agent: inferredAgent,
          ui_pid: carrierPid,
          tmux_pane_id: pane.pane_id,
          expectedRegisterGeneration,
        })
        return 'error' in byPid ? undefined : byPid
      }
    }
    const byTty = await bindRuntimeIdentitySvc.verify({
      callerAgentId,
      agent: inferredAgent,
      ui_tty: pane.tty,
      tmux_pane_id: pane.pane_id,
      expectedRegisterGeneration,
    })
    return 'error' in byTty ? undefined : byTty
  }

  async function tryDetectFallbackBind(
    inferredAgent: DetectAgentKind,
    callerAgentId: string,
    expectedRegisterGeneration: number
  ): Promise<boolean> {
    const detected = await detectTmuxPane({ agent: inferredAgent })
    if (!('ok' in detected) || !detected.ok) return false
    const pane = detected.pane

    if (paneHasPendingPreReg(pane.pane_id)) {
      // Early exit purely to skip the probes below; the authoritative check is
      // the one inside commitFallbackBind's transaction.
      log?.(
        `auto-bind skip (debug): pane=${pane.pane_id} ` +
        `reason=pane_has_pending_prereg caller=${callerAgentId}`
      )
      return false
    }

    const verified = await verifyFallbackIdentity(
      inferredAgent,
      callerAgentId,
      pane,
      expectedRegisterGeneration
    )
    if (verified === undefined) return false
    if (!commitFallbackBind(verified, pane.pane_id, callerAgentId)) return false
    // The fallback bind is the path a same-pane re-registration actually
    // takes (its pre-reg row was consumed at seeding), so the seat-follow
    // hook must fire here too.  Alive holders migrate only on codex thread
    // equality; without it seat-follow fails closed.
    if (inferredAgent === 'codex') runCodexSeatFollow(callerAgentId)
    return true
  }

  // Every register-time bind below carries expectedRegisterGeneration so its
  // final write is conditional on the registration that requested it; a
  // stale bind (a newer same-name registration re-minted the generation
  // while this bind awaited verification) fails closed with no runtime
  // write and no seat-follow.
  async function autoBindRuntimeIdentity(
    args: {
      agent_type?: AgentType
      model?: string
      delivery?: { kind?: string }
      ui_pid?: number
      recovery_nonce?: string
    },
    callerAgentId: string,
    priorCodexThreadId: string | undefined,
    expectedRegisterGeneration: number
  ): Promise<boolean> {
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.())
    if (!inferredAgent) return false

    if (args.ui_pid !== undefined) {
      const boundByPid = await bindRuntimeIdentitySvc.bind({
        callerAgentId,
        agent: inferredAgent,
        ui_pid: args.ui_pid,
        expectedRegisterGeneration,
      })
      return 'ok' in boundByPid && boundByPid.ok
    }

    if (inferredAgent === 'codex') {
      // Same-thread evidence DIRECTS the resolution instead of ending it: a
      // unique seat is inherited exactly, and only a registration with NO
      // evidence reaches the global pane detection.  The one seat outcome
      // that continues is a seat whose carrier is PROVABLY gone — inheriting
      // a dead pid is impossible and failing closed there would strand the
      // restart the pre-reg scan exists to recover, so that case reaches the
      // scan (a launcher-asserted pane, with its own carrier and key proofs)
      // and nothing else.
      // priorCodexThreadId is the TRANSACTION-returned pre-upsert thread
      // (already CAS-verified against the pre-probe capture by the caller).
      const evidence = resolveSameThreadSeat(callerAgentId, priorCodexThreadId)
      if (evidence.kind === 'seat') {
        const inherit = await inheritSameThreadSeat(
          callerAgentId,
          evidence.seat,
          expectedRegisterGeneration
        )
        const vacated = !inherit.ok
          && !inherit.superseded
          && seatCarrierGone(evidence.seat)
        logSameThreadDecision({
          callerAgentId,
          outcome: inherit.ok
            ? 'inherit'
            : vacated
              ? 'inherit_seat_vacated'
              : 'inherit_fail_closed',
          rowCount: evidence.rowCount,
          seatCount: evidence.seatCount,
          agentIds: [evidence.seat.agent_id],
          ...(inherit.ok ? {} : { reason: inherit.reason }),
        })
        if (inherit.ok) return true
        if (!vacated) return false
        // Scan ONLY.  The seat being gone says nothing about which pane the
        // caller occupies now, so the global detection below stays out of
        // reach — unlike the no-evidence path, which may fall through to it.
        return tryCodexPreRegScan(
          callerAgentId, expectedRegisterGeneration, args.recovery_nonce
        )
      }
      if (evidence.kind === 'ambiguous') {
        logSameThreadDecision({
          callerAgentId,
          outcome: 'ambiguous',
          rowCount: evidence.rowCount,
          seatCount: evidence.seatCount,
          agentIds: evidence.agentIds,
        })
        return false
      }
      logSameThreadDecision({
        callerAgentId,
        outcome: 'none',
        rowCount: evidence.rowCount,
        seatCount: evidence.seatCount,
        agentIds: [],
      })
      if (await tryCodexPreRegScan(
        callerAgentId, expectedRegisterGeneration, args.recovery_nonce
      )) {
        return true
      }
    }

    return tryDetectFallbackBind(
      inferredAgent,
      callerAgentId,
      expectedRegisterGeneration
    )
  }

  async function preflightUiPidClient(
    args: {
      agent_type?: AgentType
      model?: string
      delivery?: { kind?: string }
      ui_pid?: number
    }
  ): Promise<
    | undefined
    | {
        error: 'ui_pid_client_mismatch'
        detail: string
      }
  > {
    if (args.ui_pid === undefined) return undefined
    const inferredAgent = inferRuntimeAgentKind(args, getSessionClientInfo?.())
    if (!inferredAgent) return undefined

    const validated = await bindRuntimeIdentity({
      agent: inferredAgent,
      ui_pid: args.ui_pid,
    })
    if (!('error' in validated) || validated.error !== 'agent_process_mismatch') {
      return undefined
    }

    return {
      error: 'ui_pid_client_mismatch',
      detail:
        `ui_pid ${args.ui_pid} does not belong to agent_type=\"${inferredAgent}\". ` +
        'Pass the runtime kind for the process behind ui_pid; for example, use agent_type="opencode" when ui_pid points at an opencode process.',
    }
  }

  const registerAgentInputSchema = z.object({
    model: z.string().optional(),
    name: z.string().min(1).refine(v => v.trim().length > 0, { message: 'name must not be empty' }),
    device: z.string().optional(),
    role: z.string().optional(),
    team: z.string().optional(),
    project_dir: z.string().min(1).optional(),
    agent_type: agentTypeSchema,
    agent_type_name: z.string().min(1).optional(),
    ui_pid: z.number().int().positive().optional().describe(
      'STRONGLY RECOMMENDED. Visible agent UI process pid (e.g. Claude Code CLI pid — `$PPID` from a Bash tool call inside Claude Code). Enables one-shot pid → tty → pane binding at registration; without it, tmux-based cross-agent poke delivery typically stays off.'
    ),
    channel_session_id: z.string().min(1).optional(),
    thread_id: z.string().min(1).refine(v => v.trim().length > 0, { message: 'thread_id must not be empty' }).optional(),
    ws_url: z.string().optional(),
    auth_token_ref: z.string().min(1).optional(),
    base_url: z.string().min(1).refine(v => v.trim().length > 0, { message: 'base_url must not be empty' }).optional(),
    session_id: z.string().trim().min(1, { message: 'session_id must not be empty' }).optional(),
    identity_key: z.string().min(1).refine(v => v.trim().length > 0, {
      message: 'identity_key must not be empty',
    }).optional().describe(
      'Opaque per-pane value from `$XATS_IDENTITY_KEY`, minted by the launcher. Pass it on EVERY registration, including the first one — it is what lets this identity be recovered after the pane is restarted. Applies to every agent_type.'
    ),
    claude_ui_pid: z.number().int().positive().optional().describe(
      "Internal field for the cross-agent-teams-mcp channel proxy.  Stores the proxy's parent Claude Code UI pid (`process.ppid`) so that Claude Code hosts registering in the same lineage can auto-bind their claude-channel delivery.  Only valid when role='__channel_proxy__'; rejected otherwise."
    ),
    recovery_nonce: z.string().min(1).optional().describe(
      'One-time token quoted verbatim in a cross-agent-teams notice written into your pane — either a recovery notice (re-register as a named identity) or a pane token notice (a first registration while several panes are starting at once). Pass it back EXACTLY as given on the register_agent call you make in response: the daemon sent it to one specific tmux pane, so it is what tells the daemon which pane you are. It says nothing about who you register as. Omitting it is safe and only means the daemon falls back to guessing; inventing one has no effect.'
    ),
    delivery: deliverySchema.optional(),
  }).strict(
    'Unrecognized key in register_agent input. Note: the fields `client` and `client_name` were renamed to `agent_type` and `agent_type_name` in 0.5.0.'
  )

  const registerAgentArgsSchema = registerAgentInputSchema.superRefine((value, ctx) => {
    // `thread_id` and `ws_url` are codex-exclusive transport fields.
    // `auth_token_ref` is shared between codex-appserver and opencode-server deliveries.
    const hasCodexOnlyFields =
      value.thread_id !== undefined ||
      value.ws_url !== undefined
    if (hasCodexOnlyFields && value.agent_type !== 'codex') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=codex is required when thread_id or ws_url is provided',
      })
    }
    if (
      value.auth_token_ref !== undefined &&
      value.agent_type !== 'codex' &&
      value.agent_type !== 'opencode' &&
      value.agent_type !== 'kimi-code'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=codex, agent_type=opencode, or agent_type=kimi-code is required when auth_token_ref is provided',
      })
    }
    if (value.channel_session_id !== undefined && value.agent_type !== 'claude-code') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=claude-code is required when channel_session_id is provided',
      })
    }
    if (value.agent_type_name !== undefined && value.agent_type !== 'custom') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type_name'],
        message: 'agent_type_name is only allowed when agent_type=custom',
      })
    }
    if (value.claude_ui_pid !== undefined && value.role !== '__channel_proxy__') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claude_ui_pid'],
        message: "claude_ui_pid is only allowed when role='__channel_proxy__'",
      })
    }
    if (
      value.agent_type === 'codex' &&
      value.delivery === undefined &&
      (value.thread_id === undefined || value.thread_id === '')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['thread_id'],
        message:
          'thread_id is required when agent_type="codex". '
          + 'If you are a launcher pre-registering a codex pane, use pre_register_codex_pane instead.',
      })
    }
    if (value.agent_type === 'opencode') {
      if (value.base_url === undefined || value.base_url.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['base_url'],
          message:
            'base_url is required when agent_type="opencode". '
            + 'Read it from $OPENCODE_XATS_BASE_URL (set by the free-xats-opencode launcher).',
        })
      } else {
        let parsedUrl: URL | null = null
        try { parsedUrl = new URL(value.base_url) } catch { /* invalid */ }
        if (!parsedUrl || (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['base_url'],
            message: 'base_url must be a parseable http:// or https:// URL when agent_type="opencode".',
          })
        }
      }
      if (value.session_id !== undefined && value.session_id.trim().length > 0) {
        if (!value.session_id.startsWith('ses')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['session_id'],
            message: 'session_id must start with "ses" when supplied for agent_type="opencode".',
          })
        }
      }
    }
    if (value.agent_type === 'kimi-code') {
      if (value.base_url === undefined || value.base_url.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['base_url'],
          message:
            'base_url is required when agent_type="kimi-code". '
            + 'Read it from $KIMI_XATS_BASE_URL (set by the xats-kimi launcher).',
        })
      } else {
        const issue = kimiBaseUrlIssue(value.base_url)
        if (issue === 'unparseable' || issue === 'not_http') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['base_url'],
            message: 'base_url must be a parseable http:// or https:// URL when agent_type="kimi-code".',
          })
        } else if (issue !== undefined) {
          // Kimi endpoints are built by appending /api/v1/... to base_url;
          // a query/hash/userinfo component would corrupt every request URL.
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['base_url'],
            message: 'base_url must not carry a query, fragment, or userinfo when agent_type="kimi-code".',
          })
        }
      }
      if (value.session_id === undefined || value.session_id.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['session_id'],
          message:
            'session_id is required when agent_type="kimi-code" (the daemon does NOT auto-resolve it). '
            + 'Read it from $KIMI_XATS_SESSION_ID (exported by the xats-kimi launcher, which pre-creates the session via the kimi server REST API).',
        })
      }
    }
    if (value.base_url !== undefined && value.agent_type !== 'opencode' && value.agent_type !== 'kimi-code') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=opencode or agent_type=kimi-code is required when base_url is provided',
      })
    }
    if (value.session_id !== undefined && value.agent_type !== 'opencode' && value.agent_type !== 'kimi-code') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['agent_type'],
        message: 'agent_type=opencode or agent_type=kimi-code is required when session_id is provided',
      })
    }
  })

  /**
   * C2 evidence capture, CAS leg 1 of 2: the (device, team, name) upsert
   * reuses the caller's own row, preserves its bound runtime, and OVERWRITES
   * its stored delivery thread — so "did this row already carry the
   * registering thread?" is only answerable BEFORE the upsert.  The codex
   * register path awaits an async WS probe between this capture and the
   * persist, so the capture alone is NOT trustworthy: the persist
   * transaction re-reads the row atomically (leg 2) and the two snapshots
   * must match, otherwise the runtime auto-bind fails closed (CAS drift).
   * Returns undefined for non-codex registrations (no CAS applies); null
   * for a codex registration with no resolvable prior row.
   */
  function captureCodexPreUpsertSnapshot(args: {
    agent_type?: AgentType
    device?: string
    name: string
    team?: string
    project_dir?: string
  }): IdentityRowSnapshot | null | undefined {
    if (args.agent_type !== 'codex') return undefined
    const device = resolveEffectiveDevice({
      requestedDevice: args.device,
      originInfo: getSessionOriginInfo?.(),
      localDevice: context?.localDevice ?? 'local',
    })
    if ('error' in device) return null
    const team = deriveDefaultTeam({
      team: args.team,
      project_dir: args.project_dir,
    })
    return agents.readIdentityRowSnapshot({
      device: device.ok,
      team,
      name: args.name,
    }) ?? null
  }

  async function executeRegister(
    args: {
      agent_type?: AgentType
      agent_type_name?: string
      model?: string
      device?: string
      name: string
      role?: string
      team?: string
      project_dir?: string
      ui_pid?: number
      channel_session_id?: string
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      base_url?: string
      session_id?: string
      claude_ui_pid?: number
      identity_key?: string
      delivery?: { kind: string; [key: string]: unknown }
    }
  ): Promise<unknown> {
    let nativeDeliveryBound = suppressTmuxHint(args)
    let autoBoundChannelCsid: string | undefined
    const bindChannelSvc = channelWakeFanout
      ? new BindChannelService(db, channelWakeFanout)
      : undefined
    const autoBindChannelSvc = channelWakeFanout
      ? new AutoBindChannelService(db, channelWakeFanout)
      : undefined
    if (args.agent_type === 'claude-code' && args.model === undefined) {
      args.model = defaultClaudeSelfModel(getSessionClientInfo?.())
    }
    if (args.agent_type === 'codex' && args.ws_url === undefined) {
      args.ws_url = ''
    }
    if (args.agent_type === 'codex' && args.model === undefined) {
      args.model = 'gpt'
    }
    const connectionId = getSessionId?.() ?? caller()
    if (!connectionId) return { error: 'unknown_agent' }
    const uiPidClientError = await preflightUiPidClient(args)
    if (uiPidClientError) return uiPidClientError

    // opencode HTTP branch: register via the opencode-server delivery path.
    // Bypasses channel auto-bind and tmux runtime auto-bind because the
    // opencode-server transport is HTTP-based, not tmux-based.
    if (args.agent_type === 'opencode' && args.base_url !== undefined) {
      const opencodeRes = await registerOpencodeSelfSvc.register({
        connection_id: connectionId,
        name: args.name,
        device: args.device,
        model: args.model,
        role: args.role,
        team: args.team,
        project_dir: args.project_dir,
        base_url: args.base_url,
        session_id: args.session_id,
        auth_token_ref: args.auth_token_ref,
        identity_key: args.identity_key,
      })
      if ('agent_id' in opencodeRes) {
        if (onRegisterSuccess) {
          try { onRegisterSuccess(opencodeRes.agent_id, opencodeRes.team) } catch { /* best-effort */ }
        } else if (fanout) {
          try { fanout.rebind(opencodeRes.agent_id, opencodeRes.team) } catch { /* best-effort */ }
        }
      }
      return opencodeRes
    }
    // kimi-code HTTP branch: register via the kimi-server delivery path.
    // No register-time health check (start-xats may launch the kimi server
    // later; reachability failures surface at poke time as kimi_connect_failed).
    if (
      args.agent_type === 'kimi-code' &&
      args.base_url !== undefined &&
      args.session_id !== undefined
    ) {
      // Canonical at the write boundary: the share key and the reconnect
      // lookup both compare canonical URLs, so equivalent spellings of the
      // same endpoint must persist identically.
      const kimiBaseUrl = canonicalKimiBaseUrl(args.base_url)
      const kimiRes = registerSvc.register({
        connection_id: connectionId,
        agent_type: 'kimi-code',
        model: args.model,
        device: args.device,
        name: args.name,
        role: args.role,
        team: args.team,
        project_dir: args.project_dir,
        identity_key: args.identity_key,
        delivery: {
          kind: 'kimi-server',
          session_id: args.session_id,
          base_url: kimiBaseUrl,
          ...(args.auth_token_ref === undefined
            ? {}
            : { auth_token_ref: args.auth_token_ref }),
        },
      })
      if ('agent_id' in kimiRes) {
        if (onRegisterSuccess) {
          try { onRegisterSuccess(kimiRes.agent_id, kimiRes.team) } catch { /* best-effort */ }
        } else if (fanout) {
          try { fanout.rebind(kimiRes.agent_id, kimiRes.team) } catch { /* best-effort */ }
        }
        // prior_snapshot and register_generation are register-internal
        // state; never expose them.
        const {
          prior_snapshot: _priorSnapshot,
          register_generation: _registerGeneration,
          ...publicKimiRes
        } = kimiRes
        return {
          ...publicKimiRes,
          session_id: args.session_id,
          base_url: kimiBaseUrl,
        }
      }
      return kimiRes
    }
    if (
      args.agent_type === 'claude-code' &&
      args.channel_session_id !== undefined &&
      args.ui_pid !== undefined &&
      autoBindChannelSvc
    ) {
      const effectiveDevice = resolveEffectiveDevice({
        requestedDevice: args.device,
        originInfo: getSessionOriginInfo?.(),
        localDevice: context?.localDevice ?? 'local',
      })
      if ('error' in effectiveDevice) return effectiveDevice
      const proxyLookup = autoBindChannelSvc.lookup({
        ui_pid: args.ui_pid,
        device: effectiveDevice.ok,
      })
      if (
        proxyLookup.ok &&
        proxyLookup.channel_session_id !== args.channel_session_id
      ) {
        return {
          error: 'channel_session_id_ui_pid_mismatch',
          detail: {
            ui_pid_matched_csid: proxyLookup.channel_session_id,
            supplied_csid: args.channel_session_id,
          },
        }
      }
    }
    const hasCodexTransportFields =
      args.thread_id !== undefined ||
      args.ws_url !== undefined ||
      args.auth_token_ref !== undefined
    const preUpsertSnapshot = captureCodexPreUpsertSnapshot(args)
    const res =
      args.agent_type === 'codex' &&
      args.delivery === undefined &&
      hasCodexTransportFields
        ? await registerCodexSelfSvc.register({
            connection_id: connectionId,
            device: args.device,
            name: args.name,
            model: args.model,
            role: args.role,
            team: args.team,
            project_dir: args.project_dir,
            thread_id: args.thread_id,
            ws_url: args.ws_url,
            auth_token_ref: args.auth_token_ref,
            identity_key: args.identity_key,
          })
        : registerSvc.register({
            connection_id: connectionId,
            agent_type: args.agent_type,
            agent_type_name: args.agent_type_name,
            model: args.model,
            device: args.device,
            name: args.name,
            role: args.role,
            team: args.team,
            project_dir: args.project_dir,
            delivery: args.delivery,
            claude_ui_pid: args.claude_ui_pid,
            runtime_ui_pid:
              args.agent_type === 'claude-code' ? args.ui_pid : undefined,
            identity_key: args.identity_key,
          })
    if ('thread_id' in res && 'agent_id' in res) {
      nativeDeliveryBound = true
    }
    if ('agent_id' in res) {
      // CAS leg 2: the persist transaction returned the row's ACTUAL prior
      // state.  prior_snapshot and register_generation are register-internal
      // — strip them from every client-facing envelope below.
      const {
        prior_snapshot: actualPriorSnapshot,
        register_generation: registerGeneration,
        ...publicRes
      } = res
      if (onRegisterSuccess) {
        try { onRegisterSuccess(res.agent_id, res.team) } catch { /* best-effort */ }
      } else if (fanout) {
        try { fanout.rebind(res.agent_id, res.team) } catch { /* best-effort */ }
      }
      if (args.agent_type === 'claude-code' && args.channel_session_id !== undefined) {
        const channelBind = bindChannelSvc
          ? bindChannelSvc.bind({
              callerAgentId: res.agent_id,
              channel_session_id: args.channel_session_id,
            })
          : { error: 'unknown_channel_session' as const }
        if ('ok' in channelBind && channelBind.ok) {
          nativeDeliveryBound = true
        } else {
          return channelBind
        }
      }
      if (
        args.agent_type === 'claude-code' &&
        args.channel_session_id === undefined &&
        args.ui_pid !== undefined &&
        autoBindChannelSvc
      ) {
        const callerRow = agents.findById(res.agent_id)
        const autoBind = autoBindChannelSvc.run({
          callerAgentId: res.agent_id,
          ui_pid: args.ui_pid,
          device: callerRow?.device,
        })
        if (autoBind.ok) {
          autoBoundChannelCsid = autoBind.channel_session_id
          nativeDeliveryBound = true
        }
      }
      // CAS/version check: a codex registration whose row changed between
      // the pre-probe capture and the persist transaction was raced by a
      // concurrent same-(device, team, name) registration.  Fail the runtime
      // auto-bind closed: no caller-row evidence, no pre-reg scan, no global
      // detection, no runtime bind — register still succeeds unbound.
      // The success result must carry the generation the upsert minted as a
      // positive safe integer; a malformed internal result (an injected
      // register service that lost or corrupted the field — NaN/Infinity/
      // negatives make every conditional write silently change zero rows)
      // must not degrade the conditional final writes below into
      // unconditional or no-op ones — fail the runtime auto-bind closed.
      const registerGenerationValid =
        typeof registerGeneration === 'number' &&
        Number.isSafeInteger(registerGeneration) &&
        registerGeneration >= 1
      if (!registerGenerationValid) {
        log?.(
          `register invariant error: register result carries no valid ` +
          `register_generation agent=${res.agent_id}; runtime auto-bind ` +
          `fails closed`
        )
      }
      // The prior snapshot is the CAS input; a codex result missing the
      // FIELD (not a null prior — fresh rows legitimately have none) would
      // fake a CAS match against a null pre-upsert capture.  Treat the
      // missing field as drift so the auto-bind never proceeds on it.
      const priorSnapshotMissing =
        args.agent_type === 'codex' && actualPriorSnapshot === undefined
      if (priorSnapshotMissing) {
        log?.(
          `register invariant error: codex register result carries no ` +
          `prior_snapshot field agent=${res.agent_id}; treated as CAS drift`
        )
      }
      const casDrift =
        args.agent_type === 'codex' &&
        (priorSnapshotMissing ||
          !sameIdentityRowSnapshot(
            preUpsertSnapshot ?? null,
            actualPriorSnapshot ?? null
          ))
      if (casDrift) {
        logSameThreadDecision({
          callerAgentId: res.agent_id,
          outcome: 'cas_drift',
          rowCount: 0,
          seatCount: 0,
          agentIds: [...new Set([
            ...(preUpsertSnapshot ? [preUpsertSnapshot.agent_id] : []),
            ...(actualPriorSnapshot ? [actualPriorSnapshot.agent_id] : []),
          ])],
          reason: 'row_changed_during_register_probe',
        })
        // The upsert COALESCE-preserved whatever seat the raced row carried,
        // leaving "this registration's thread + the raced session's seat" —
        // reachable via the tmux fallback.  Clear it, conditional on THIS
        // registration's generation so an even newer registration's freshly
        // bound seat is never touched.
        if (registerGenerationValid) {
          const cleared = agents.clearRuntimeBinding(res.agent_id, {
            expected_register_generation: registerGeneration,
          })
          log?.(
            `cas drift runtime clear (debug): agent=${res.agent_id} ` +
            `changes=${cleared.changes}` +
            (cleared.changes === 0 ? ' reason=generation_advanced' : '')
          )
        } else {
          // Without a valid minted generation the residue cannot be cleared
          // safely (an unconditional clear could wipe a newer registration's
          // seat) — say so instead of silently claiming the unbound end
          // state was reached.
          log?.(
            `cas drift runtime clear skipped: agent=${res.agent_id} ` +
            `reason=invalid_register_generation; residual seat may remain`
          )
        }
      }
      // On a CAS match the TRANSACTION-returned prior thread (not the early
      // capture) is the trustworthy caller-row evidence input.
      const priorCodexThreadId =
        args.agent_type === 'codex'
          ? actualPriorSnapshot?.codex_thread_id ?? undefined
          : undefined
      const autoBound = casDrift || !registerGenerationValid
        ? false
        : await autoBindRuntimeIdentity(
            args,
            res.agent_id,
            priorCodexThreadId,
            registerGeneration
          )
      const envelope = autoBoundChannelCsid !== undefined
        ? { ...publicRes, channel_session_id: autoBoundChannelCsid }
        : publicRes
      if (autoBound) return envelope
      if (casDrift && !registerGenerationValid) {
        // The residue of the raced session's seat could NOT be cleared (no
        // valid minted generation), so the standard no-pane hint would be a
        // lie — a stale tmux binding may still be attached to this row.
        return {
          ...envelope,
          hint: 'Runtime auto-bind failed closed on a registration ' +
            'invariant error (invalid register_generation) after a ' +
            'concurrent-registration conflict; a residual tmux pane ' +
            'binding from the raced session may remain on this row. Call ' +
            '`bind_runtime_identity(...)` to repair the binding explicitly.',
        }
      }
      if (!nativeDeliveryBound) {
        return {
          ...envelope,
          hint: "No usable tmux_pane_id is bound yet — automatic runtime binding did not converge for this session, so cross-agent poke delivery via tmux is still off. Call `bind_runtime_identity(...)` to bind explicitly, or use `detect_tmux_pane(...)` for debugging. Claude Code users who loaded the cross-agent-teams-mcp channel plugin can also route pokes via channel_session_id — that path does not require tmux binding."
        }
      }
      return envelope
    }
    return res
  }

  function releaseRegisteredState(agentId: string): void {
    const connectionId = getSessionId?.()
    if (connectionId) registerSvc.releaseConnection(agentId, connectionId)
    if (onUnregisterSuccess) {
      try { onUnregisterSuccess(agentId) } catch { /* best-effort */ }
      return
    }
    if (fanout) {
      try { fanout.detach(agentId) } catch { /* best-effort */ }
    }
  }

  // pre_register_codex_pane — callable by launchers before any agent row exists
  server.registerTool(
    'pre_register_codex_pane',
    {
      title: 'Pre-register codex tmux pane',
      description: [
        'Pre-register a pending tmux-pane claim so the launcher can claim a tmux pane before starting codex.',
        'LAUNCHER-ONLY. Call it from the pane shell BEFORE `exec codex`, with that shell\'s own `$TMUX_PANE` and a freshly generated UUID, then `exec codex --remote ... -c xats.agent_id="\\"<uuid>\\""`.',
        'If you are a codex agent rather than a launcher, do NOT call this: under `--remote` your tools run in a shared app-server, so the `$TMUX_PANE` you can read belongs to whatever pane started that app-server, not to you — calling with it targets somebody else\'s pane.',
        'A pane whose pending row carries an `identity_key` and whose original codex process is still running is only replaceable by a call supplying THAT SAME key; anything else is refused with `pane_claimed` and the existing row is left untouched. Once that process is gone the pane is free again, so a tmux restart never leaves panes locked.',
        'When the codex agent later calls `register_agent({agent_type:"codex"})` without `ui_pid`, the daemon uses the pending row to resolve the correct UI pid and auto-bind the pane.',
        'Callable without a prior `register_agent` — launchers have no agent identity yet.',
        'Optional `identity_key` is the launcher-minted restart-stable identity handle. It MUST NEVER appear on any process argv and never in model context; the CLI reads the launcher-exported environment variable and forwards it only over the authenticated HTTP channel.',
        'When the key matches a known identity whose runtime process is dead, the daemon schedules a recovery poke: once a codex `--remote` process with the pre-registered uuid appears on the pane, it guides the agent to re-register under the recovered (team, name). The poke text never contains the key.',
        'TTL defaults to 120 seconds and is capped at 600; pending rows are garbage-collected opportunistically.',
      ].join(' '),
      inputSchema: preRegisterCodexPaneInputSchema,
    },
    async (args: unknown) => run(async () => preRegisterCodexPaneSvc.register(args))
  )

  // register_agent — bootstrap: callable before an agents row exists for this session
  server.registerTool(
    'detect_tmux_pane',
    {
      title: 'Detect tmux pane',
      description: [
        'Detect the tmux pane that is actually hosting a coding agent UI, even when the shell calling tools lives in a different pane.',
        'The detector scans tmux panes globally, maps each pane to its tty, then inspects real tty processes instead of trusting `$TMUX_PANE` or tmux focus state alone.',
        'Use `agent` to pick a built-in matcher for Codex, Claude Code, or opencode.',
        'Optional `cwd`, `tty`, and `title_contains` narrow the search and make cross-directory multi-agent sessions much more reliable.',
        'Returns either a single best pane, or an ambiguity/not-found result with candidates for debugging.'
      ].join(' '),
      inputSchema: detectTmuxPaneSchema,
    },
    async (args: {
      agent: 'codex' | 'claude-code' | 'opencode' | 'custom'
      cwd?: string
      tty?: string
      title_contains?: string
      process_pattern?: string
    }) => run(async () => {
      const parsed = detectTmuxPaneArgsSchema.safeParse(args)
      if (!parsed.success) {
        return {
          error: 'invalid_arguments' as const,
          detail: parsed.error.issues.map(issue => issue.message).join('; '),
        }
      }
      return detectTmuxPane({
        agent: parsed.data.agent,
        cwd: parsed.data.cwd,
        tty: parsed.data.tty,
        title_contains: parsed.data.title_contains,
        process_pattern: parsed.data.process_pattern,
      })
    })
  )

  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description: [
        'Register this session as an agent in a team. This is the unified registration entry point.',
        'DETECTION (run these probes BEFORE choosing `agent_type=`, in order; first match wins):',
        '1. `printenv KIMI_XATS_BASE_URL` non-empty → `agent_type="kimi-code"`; pass that value as `base_url`, and pass `session_id` from `printenv KIMI_XATS_SESSION_ID`. The `xats-kimi` launcher pre-creates the session via the kimi server REST API and exports BOTH variables, so the session id is exact — do NOT derive it from `~/.kimi-code/session_index.jsonl` (its last `workDir`-matching entry can belong to a DIFFERENT kimi session in the same directory; pokes bound that way are delivered to the wrong session). `session_id` is REQUIRED for kimi-code — the daemon does NOT auto-resolve it. These env vars are set ONLY by the `xats-kimi` launcher, so their presence is itself the runtime assertion that the caller is kimi-code.',
        '2. `printenv OPENCODE_XATS_BASE_URL` non-empty → `agent_type="opencode"`; pass that value as `base_url`. Do NOT pass `session_id` — the daemon auto-resolves it as the most recently updated session on that base_url. The env var is set ONLY by the `free-xats-opencode` launcher, so its presence is itself the runtime assertion that the caller is opencode.',
        '3. `printenv CODEX_THREAD_ID` non-empty (Codex CLI or Mac Codex App) → `agent_type="codex"`; pass that value as `thread_id` (REQUIRED for codex per the schema). For Codex CLI, do NOT pass `ui_pid` because the launcher\'s `pre_register_codex_pane` flow handles tmux binding and an explicit pid disables that path. Mac Codex App has no tmux launcher flow; omit `ui_pid` because an App or app-server pid is not conversation-scoped, and reconnect identity is `thread_id` only.',
        '4. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type="claude-code"`; pass `$PPID` as `ui_pid` to enable channel auto-bind.',
        '5. None of the above → `agent_type="custom"` with `agent_type_name="<the harness you are running under, e.g. cursor, opencode, ...>"` (`agent_type_name` is required when `agent_type="custom"`). Detect the harness name from your runtime environment if you can — e.g. `printenv CURSOR_TRACE_ID` non-empty means cursor — but do NOT guess from system-wide signals like "binary X exists on PATH": such probes detect what the user has installed, not what runtime you are inside, and pick the wrong agent type. When unsure, prefer `agent_type_name="unknown"` over a wrong guess.',
        'Calling this tool again with the same `(device, team, name)` identity reuses the existing `agent_id` and refreshes `tmux_pane_id` and `model`; no duplicate row is created.',
        'IDENTITY KEY (not part of the DETECTION sequence above — it says nothing about which runtime you are, and applies to every `agent_type`): run `printenv XATS_IDENTITY_KEY`; when it is non-empty, pass that value as `identity_key` on EVERY `register_agent` call, including the very first one. The key is the launcher-minted, restart-stable handle that later lets `reconnect({identity_key})` recover this identity after the pane is restarted — a restart changes `ui_pid`, `thread_id`, and the session id, so no other lookup can. Omitting it on the first registration silently disables recovery for this pane: nothing fails, every later recovery just returns `need_register`. When the key is already held by another live pane the call is rejected with `identity_key_conflict` naming that pane\'s team and name, and no row is written.',
        'Use `agent_type="custom"` for unsupported agent harnesses; provide `agent_type_name` for observability.',
        'opencode sessions: pass `agent_type="opencode"` and `base_url` (from `$OPENCODE_XATS_BASE_URL`, set by the `free-xats-opencode` launcher). Omit `session_id` — the daemon auto-resolves it via `<base_url>/session` (most recently updated). `auth_token_ref` is optional; set only when `OPENCODE_SERVER_PASSWORD` is configured on the opencode server. The schema REQUIRES `base_url` (parseable `http://` or `https://` URL) when `agent_type="opencode"`; missing/malformed `base_url` is rejected before any HTTP probe runs.',
        'kimi-code sessions: pass `agent_type="kimi-code"`, `base_url` (from `$KIMI_XATS_BASE_URL`, set by the `xats-kimi` launcher), and `session_id` (REQUIRED — from `$KIMI_XATS_SESSION_ID`, which the launcher exports after pre-creating the session via the kimi server REST API; the daemon does NOT auto-resolve it and does NOT health-check the server at register time. Do NOT fall back to `~/.kimi-code/session_index.jsonl` guessing: with several kimi sessions in one directory its last `workDir` match can be a different session, and pokes then wake that wrong session while reporting delivered). `auth_token_ref` is optional; when omitted the daemon reads the bearer token from `~/.kimi-code/server.token` at poke time. The schema REQUIRES `base_url` (parseable `http://` or `https://` URL) and a non-empty `session_id` when `agent_type="kimi-code"`; missing/malformed values are rejected before any row is written.',
        'Claude Code sessions: pass `agent_type="claude-code"` and PREFERRED: pass only `ui_pid` (from `$PPID`) so the daemon auto-binds channel delivery — do not pass `channel_session_id` explicitly. When BOTH `ui_pid` AND `channel_session_id` are supplied, the daemon runs a consistency check against the caller `ui_pid`\'s live channel proxy; if the proxy\'s csid does not match the supplied `channel_session_id`, the call is rejected with `channel_session_id_ui_pid_mismatch` before any agent row is written. To re-establish a prior identity on a fresh/resumed session where you no longer remember your (team, name) (changed csid, unchanged $PPID), prefer `reconnect({ ui_pid })` over the bind_channel→register fallback; `bind_channel` only rebinds a session already bound to your agent. If instead you still remember your (team, name) after a restart + resume (changed $PPID), call register_agent directly with that remembered (team, name) and the current $PPID rather than reconnect.',
        'Codex CLI and Mac Codex App sessions: pass `agent_type="codex"` and `thread_id` (from `$CODEX_THREAD_ID`) to register Codex app-server delivery. The schema REQUIRES `thread_id` when `agent_type="codex"`; missing or empty `thread_id` is rejected before any handshake runs. Codex CLI launcher callers without `thread_id` should use `pre_register_codex_pane`; Mac Codex App does not use that tmux launcher path. Endpoint precedence is explicit `ws_url`, legacy `CROSS_AGENT_TEAMS_CODEX_WS_URL`, JSON array `CROSS_AGENT_TEAMS_CODEX_WS_URLS`, then `ws://127.0.0.1:8799`. With multiple configured endpoints, the daemon probes `thread_id` and registers only a unique match. `model` defaults to `gpt` when omitted. For `agent_type="claude-code"` callers, `model` defaults to a Claude-specific value derived from MCP session client info when omitted.',
        '`model` is OPTIONAL for any agent_type: omit it when you do not have an authoritative model identifier; the daemon stores NULL in that case. Pass an explicit `model` only when you have a stable identifier you would like surfaced via `list_agents`.',
        'Requests such as "register to xats" or "register to cross-agent-teams" refer to this MCP service, not to the `team` field; do not set `team` to `xats` or `cross-agent-teams` from those phrases.',
        'Do not treat the bare word "register" as a request for this tool unless the current conversation is already about cross-agent-teams registration.',
        'If the user writes an identity in the shorthand `name(team)` (e.g. `skills-creator(default)` means name=`skills-creator`, team=`default`), split it into the separate `name` and `team` arguments. The daemon does NOT parse `name(team)`; passing the literal string as `name` registers a malformed identity (the parentheses are not rejected).',
        'When the end user has not explicitly specified `team`, callers should pass `project_dir` as the current working directory so the daemon derives a project-scoped default team from its basename; if omitted, it falls back to `default`.',
        'REPORTING RULE: on success the response carries the actual `team` the daemon assigned. When summarizing the registration to the user, surface that returned `team` value verbatim; NEVER derive or paraphrase the team from `project_dir`, cwd, or your own pre-call assumption. Failing to read the response masks the daemon\'s `default` fallback (e.g. when `project_dir` was forgotten) and produces misleading "team: X (from cwd basename)" reports that break later cross-team send_message diagnostics.',
        '`agent_type` must describe the runtime behind `ui_pid`, not merely the current MCP caller. For example, if `ui_pid` points at an external editor process, pass `agent_type="custom"` with `agent_type_name=<editor>` even when the registration request is issued from a different harness.',
        'STRONGLY RECOMMENDED: pass `ui_pid` unless it is truly unobtainable (codex and opencode callers excepted). Without it, automatic runtime binding usually fails to converge and tmux-based cross-agent poke delivery stays off until a separate `bind_runtime_identity(...)` call. From Claude Code, `$PPID` inside a Bash tool call is the `claude` CLI pid. With `ui_pid` the daemon binds via verified pid → tty → pane evidence in one shot.',
        'After registration, the daemon best-effort attempts runtime binding for recognized local clients so tmux-based poke delivery can come up without a second tool call.',
        'If automatic runtime binding does not converge, call `bind_runtime_identity(...)` explicitly so the daemon can verify and persist your pane binding.',
        '`detect_tmux_pane(...)` remains available as a debugging aid for ambiguous or missing matches, but it does not write registry state by itself.',
        'When registration still has no usable `tmux_pane_id`, tmux-based poke delivery stays unavailable until automatic or explicit runtime binding succeeds.'
      ].join(' '),
      inputSchema: registerAgentInputSchema
    },
    async (args: {
      agent_type: AgentType
      agent_type_name?: string
      device?: string
      model?: string; name: string; role?: string; team?: string;
      project_dir?: string;
      ui_pid?: number;
      channel_session_id?: string
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      base_url?: string
      session_id?: string
      claude_ui_pid?: number
      identity_key?: string
      delivery?: { kind: string; [key: string]: unknown }
    }) => {
      return run(async () => executeRegister(registerAgentArgsSchema.parse(args)))
    }
  )

  const reconnectInputSchema = z.object({
    identity_key: z.string().min(1).refine(v => v.trim().length > 0, {
      message: 'identity_key must not be empty',
    }).optional().describe(
      'Launcher-minted per-pane key from `$XATS_IDENTITY_KEY`. The only lookup that survives a pane restart. Combine it with `ui_pid` (claude-code) or `thread_id` (codex) in the same call: the key resolves the identity, the other value rebinds the live runtime.'
    ),
    ui_pid: z.number().int().positive().optional().describe(
      'Claude UI process id (`$PPID` inside Claude Code).'
    ),
    thread_id: z.string().uuid().optional().describe(
      'Codex CLI or Mac Codex App thread id from `$CODEX_THREAD_ID`.'
    ),
    ws_url: z.string().refine(isWebSocketUrl, {
      message: 'ws_url must be a valid ws:// or wss:// URL',
    }).optional(),
    auth_token_ref: z.string().min(1).optional(),
    base_url: z.string().min(1).refine(v => {
      try {
        const parsed = new URL(v)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    }, {
      message: 'base_url must be a parseable http:// or https:// URL',
    }).optional().describe(
      'opencode or kimi server base URL (`$OPENCODE_XATS_BASE_URL` / `$KIMI_XATS_BASE_URL`).'
    ),
    session_id: z.string().trim().min(1, {
      message: 'session_id must not be blank',
    }).optional().describe(
      'opencode or kimi session id. For opencode it may be omitted: the daemon resolves the most recently updated session from <base_url>/session before reverse-look-up (opencode ids must start with "ses"). For kimi-code it is REQUIRED (`$KIMI_XATS_SESSION_ID`) and only needs to be non-blank — registration never enforced a prefix, so reconnect must not either; kimi sessions are never auto-resolved.'
    ),
    agent_type: z.enum(['opencode', 'kimi-code']).optional().describe(
      'Runtime discriminator for the base_url arm. REQUIRED as "kimi-code" for kimi recovery: without it a kimi reconnect on a registry with no matching rows is routed to the opencode probe and returns opencode-flavored errors instead of need_register. Optional for opencode.'
    ),
  }).strict()

  const reconnectArgsSchema = reconnectInputSchema.superRefine((value, ctx) => {
    const keyCount = Number(value.ui_pid !== undefined)
      + Number(value.thread_id !== undefined)
      + Number(value.base_url !== undefined)
    // identity_key answers "which identity", the other three answer "which
    // live runtime", so it does not join their exclusion group — it only
    // relaxes the count to at-most-one.
    if (value.identity_key === undefined ? keyCount !== 1 : keyCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: value.identity_key === undefined
          ? 'provide exactly one of ui_pid, thread_id, or base_url'
          : 'identity_key combines with at most one of ui_pid or thread_id',
      })
    }
    // The base_url arms resolve identity from a revalidated live session,
    // which is a second identity lookup competing with the key.
    if (value.identity_key !== undefined && value.base_url !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'identity_key cannot be combined with base_url',
      })
    }
    if (value.thread_id === undefined && value.ws_url !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'ws_url requires thread_id',
      })
    }
    if (value.session_id !== undefined && value.base_url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_id requires base_url',
      })
    }
    if (
      value.auth_token_ref !== undefined
      && value.thread_id === undefined
      && value.base_url === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'auth_token_ref requires thread_id or base_url',
      })
    }
    if (value.agent_type !== undefined && value.base_url === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'agent_type requires base_url',
      })
    }
    if (value.agent_type === 'kimi-code' && value.session_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_id is required when agent_type="kimi-code"',
      })
    }
    if (value.agent_type === 'kimi-code' && value.base_url !== undefined) {
      const issue = kimiBaseUrlIssue(value.base_url)
      if (issue === 'query_or_fragment' || issue === 'userinfo') {
        // Same boundary rule as registration: kimi endpoint URLs are built
        // by appending /api/v1/... to base_url. Unparseable/non-http URLs
        // are already rejected by the base_url field schema.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'base_url must not carry a query, fragment, or userinfo when agent_type="kimi-code"',
        })
      }
    }
    // The "ses" prefix is an opencode contract; kimi registration only
    // requires a non-empty id, so an explicit kimi reconnect must accept
    // whatever was registrable. Legacy calls without agent_type keep the
    // historical opencode-arm validation.
    if (
      value.session_id !== undefined
      && value.agent_type !== 'kimi-code'
      && !value.session_id.startsWith('ses')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_id must start with "ses"',
      })
    }
  })

  function unresolvedReconnect(
    resolution: Exclude<ReconnectResolution, { kind: 'single' }>
  ): unknown {
    if (resolution.kind === 'need_register') {
      return { need_register: true, reason: resolution.reason }
    }
    return {
      ambiguous: true,
      candidates: resolution.candidates.map(candidate => ({
        agent_id: candidate.agent_id,
        name: candidate.name,
        team: candidate.team,
        device: candidate.device,
        role: candidate.role,
        last_seen_at: candidate.last_seen_at,
      })),
    }
  }

  async function executeClaudeReconnect(ui_pid: number): Promise<unknown> {
    const resolution = resolveReconnect(
      agents,
      ui_pid,
      context?.localDevice ?? 'local'
    )
    if (resolution.kind !== 'single') return unresolvedReconnect(resolution)
    return completeClaudeReconnect(resolution.match, ui_pid)
  }

  async function completeClaudeReconnect(
    match: ReconnectCandidate,
    ui_pid: number
  ): Promise<unknown> {
    const res = await executeRegister({
      agent_type: 'claude-code',
      name: match.name,
      team: match.team,
      device: match.device,
      role: match.role,
      ui_pid,
    })
    if (typeof res !== 'object' || res === null || !('agent_id' in res)) {
      return res
    }
    const envelope = res as {
      agent_id: string
      team: string
      channel_session_id?: string
    }
    return {
      ok: true,
      agent_id: envelope.agent_id,
      name: match.name,
      team: envelope.team,
      channel_session_id: envelope.channel_session_id ?? null,
      last_seen_at: match.last_seen_at,
    }
  }

  async function executeCodexReconnect(args: {
    thread_id: string
    ws_url?: string
    auth_token_ref?: string
  }): Promise<unknown> {
    const resolution = resolveCodexReconnect(
      agents,
      args.thread_id,
      context?.localDevice ?? 'local'
    )
    if (resolution.kind !== 'single') return unresolvedReconnect(resolution)
    return completeCodexReconnect(resolution.match, args)
  }

  async function completeCodexReconnect(
    match: ReconnectCandidate,
    args: { thread_id: string; ws_url?: string; auth_token_ref?: string }
  ): Promise<unknown> {
    const res = await executeRegister({
      agent_type: 'codex',
      name: match.name,
      team: match.team,
      device: match.device,
      role: match.role,
      thread_id: args.thread_id,
      ws_url: args.ws_url,
      auth_token_ref: args.auth_token_ref,
    })
    if (typeof res !== 'object' || res === null || !('agent_id' in res)) {
      return res
    }
    const envelope = res as {
      agent_id: string
      team: string
      thread_id: string
      ws_url: string
    }
    return {
      ok: true,
      agent_id: envelope.agent_id,
      name: match.name,
      team: envelope.team,
      thread_id: envelope.thread_id,
      ws_url: envelope.ws_url,
      last_seen_at: match.last_seen_at,
    }
  }

  /**
   * Identity comes from the key; the accompanying `ui_pid` / `thread_id` only
   * rebinds the live runtime. With neither, the stored agent_type is replayed
   * so re-registering does not blank it.
   */
  async function executeIdentityKeyReconnect(args: {
    identity_key: string
    ui_pid?: number
    thread_id?: string
    ws_url?: string
    auth_token_ref?: string
  }): Promise<unknown> {
    const resolution = resolveIdentityKeyReconnect(
      agents,
      args.identity_key,
      context?.localDevice ?? 'local'
    )
    if (resolution.kind !== 'single') return unresolvedReconnect(resolution)
    const match = resolution.match
    if (args.ui_pid !== undefined) {
      return completeClaudeReconnect(match, args.ui_pid)
    }
    if (args.thread_id !== undefined) {
      return completeCodexReconnect(match, {
        thread_id: args.thread_id,
        ws_url: args.ws_url,
        auth_token_ref: args.auth_token_ref,
      })
    }
    const stored = agents.findById(match.agent_id)
    const res = await executeRegister({
      agent_type: stored?.agent_type ?? undefined,
      agent_type_name: stored?.agent_type_name ?? undefined,
      name: match.name,
      team: match.team,
      device: match.device,
      role: match.role,
    })
    if (typeof res !== 'object' || res === null || !('agent_id' in res)) {
      return res
    }
    const envelope = res as { agent_id: string; team: string }
    return {
      ok: true,
      agent_id: envelope.agent_id,
      name: match.name,
      team: envelope.team,
      last_seen_at: match.last_seen_at,
    }
  }

  type RecoveredAuth =
    | { kind: 'ref'; ref: string }
    | { kind: 'none' }
    | { kind: 'ambiguous'; refs: string[] }

  function recoverOpencodeAuth(
    base_url: string,
    session_id: string | undefined,
    callerAuth: string | undefined,
    localDevice: string
  ): RecoveredAuth {
    if (callerAuth !== undefined) return { kind: 'ref', ref: callerAuth }
    const rows = session_id !== undefined
      ? agents.findByOpencodeSession(base_url, session_id, localDevice)
      : agents.findByOpencodeBaseUrl(base_url, localDevice)
    const refs = new Set<string>()
    let hasNoRef = false
    for (const row of rows) {
      const full = agents.findById(row.agent_id)
      const ref = full?.delivery.kind === 'opencode-server'
        ? full.delivery.auth_token_ref
        : undefined
      if (ref) refs.add(ref)
      else hasNoRef = true
    }
    const sortedRefs = Array.from(refs).sort()
    // Mixed auth state (some candidates carry a ref, others don't) can't be
    // auto-resolved: pre-validating with the shared ref would later 401 when
    // the precise match is a no-ref row. Surface auth_ambiguous instead.
    if (refs.size > 0 && hasNoRef) return { kind: 'ambiguous', refs: sortedRefs }
    if (refs.size === 1) return { kind: 'ref', ref: sortedRefs[0]! }
    if (refs.size > 1) return { kind: 'ambiguous', refs: sortedRefs }
    return { kind: 'none' }
  }

  function readStoredOpencodeAuth(agent_id: string): string | undefined {
    const existing = agents.findById(agent_id)
    if (
      existing
      && existing.delivery.kind === 'opencode-server'
      && existing.delivery.auth_token_ref
    ) {
      return existing.delivery.auth_token_ref
    }
    return undefined
  }

  async function executeOpencodeReconnect(args: {
    base_url: string
    session_id?: string
    auth_token_ref?: string
  }): Promise<unknown> {
    const localDevice = context?.localDevice ?? 'local'
    const recovered = recoverOpencodeAuth(
      args.base_url, args.session_id, args.auth_token_ref, localDevice
    )
    if (recovered.kind === 'ambiguous') {
      return { error: 'auth_ambiguous', detail: { refs: recovered.refs } }
    }
    const preAuth = recovered.kind === 'ref' ? recovered.ref : undefined
    const resolved = await registerOpencodeSelfSvc.resolveSessionId(
      args.base_url, preAuth, args.session_id
    )
    if ('error' in resolved) return resolved
    const sessionId = resolved.session_id

    const resolution = resolveOpencodeReconnect(
      agents, args.base_url, sessionId, localDevice
    )
    if (resolution.kind !== 'single') return unresolvedReconnect(resolution)
    const match = resolution.match

    const authTokenRef = args.auth_token_ref ?? readStoredOpencodeAuth(match.agent_id)
    const res = await executeRegister({
      agent_type: 'opencode',
      name: match.name,
      team: match.team,
      device: match.device,
      role: match.role,
      base_url: args.base_url,
      session_id: sessionId,
      auth_token_ref: authTokenRef,
    })
    if (typeof res !== 'object' || res === null || !('agent_id' in res)) return res
    const envelope = res as { agent_id: string; team: string }
    return {
      ok: true,
      agent_id: envelope.agent_id,
      name: match.name,
      team: envelope.team,
      session_id: sessionId,
      base_url: args.base_url,
      last_seen_at: match.last_seen_at,
    }
  }

  function readStoredKimiAuth(agent_id: string): string | undefined {
    const existing = agents.findById(agent_id)
    if (
      existing
      && existing.delivery.kind === 'kimi-server'
      && existing.delivery.auth_token_ref
    ) {
      return existing.delivery.auth_token_ref
    }
    return undefined
  }

  // The base_url arm is shared between opencode and kimi. A kimi recovery
  // requires an explicit session_id (never resolved by recency), and applies
  // when local kimi-server rows claim the pair — or the base_url hosts only
  // kimi rows, so a stale session_id still gets the kimi need_register answer.
  function kimiReconnectApplies(
    base_url: string,
    session_id: string,
    localDevice: string
  ): boolean {
    // kimi rows persist canonical base_urls; the opencode lookup keeps the
    // caller's spelling (opencode rows are not canonicalized).
    const kimiUrl = canonicalKimiBaseUrl(base_url)
    if (agents.findByKimiSession(kimiUrl, session_id, localDevice).length > 0) {
      return true
    }
    return agents.findByKimiBaseUrl(kimiUrl, localDevice).length > 0
      && agents.findByOpencodeBaseUrl(base_url, localDevice).length === 0
  }

  async function executeKimiReconnect(args: {
    base_url: string
    session_id: string
    auth_token_ref?: string
  }): Promise<unknown> {
    const localDevice = context?.localDevice ?? 'local'
    // Same canonicalizer as registration: equivalent URL spellings must find
    // the row that registration persisted.
    const base_url = canonicalKimiBaseUrl(args.base_url)
    const resolution = resolveKimiReconnect(
      agents, base_url, args.session_id, localDevice
    )
    if (resolution.kind !== 'single') return unresolvedReconnect(resolution)
    const match = resolution.match

    const authTokenRef = args.auth_token_ref ?? readStoredKimiAuth(match.agent_id)
    const probe = await validateKimiSession({
      base_url,
      session_id: args.session_id,
      auth_token_ref: authTokenRef,
    })
    if ('error' in probe) return probe

    // Registers with agent_type=kimi-code and the validated kimi-server
    // delivery, so the connection rebinds under the kimi runtime key
    // (base_url + session_id) and SHARES with live engine connections of
    // that session.
    const res = await executeRegister({
      agent_type: 'kimi-code',
      name: match.name,
      team: match.team,
      device: match.device,
      role: match.role,
      base_url,
      session_id: args.session_id,
      auth_token_ref: authTokenRef,
    })
    if (typeof res !== 'object' || res === null || !('agent_id' in res)) return res
    const envelope = res as { agent_id: string; team: string }
    return {
      ok: true,
      agent_id: envelope.agent_id,
      name: match.name,
      team: envelope.team,
      session_id: args.session_id,
      base_url,
      last_seen_at: match.last_seen_at,
    }
  }

  async function executeReconnect(args: {
    identity_key?: string
    ui_pid?: number
    thread_id?: string
    ws_url?: string
    auth_token_ref?: string
    base_url?: string
    session_id?: string
    agent_type?: 'opencode' | 'kimi-code'
  }): Promise<unknown> {
    // The key wins over any accompanying runtime lookup: after a restart the
    // new pid may already belong to an unrelated row.
    if (args.identity_key !== undefined) {
      return executeIdentityKeyReconnect({
        identity_key: args.identity_key,
        ui_pid: args.ui_pid,
        thread_id: args.thread_id,
        ws_url: args.ws_url,
        auth_token_ref: args.auth_token_ref,
      })
    }
    if (args.ui_pid !== undefined) {
      return executeClaudeReconnect(args.ui_pid)
    }
    if (args.thread_id !== undefined) {
      return executeCodexReconnect({
        thread_id: args.thread_id,
        ws_url: args.ws_url,
        auth_token_ref: args.auth_token_ref,
      })
    }
    // Explicit runtime discriminator wins: it keeps a kimi reconnect on an
    // empty/mixed registry deterministic (need_register, never an opencode
    // probe). The row-residency heuristic below survives only as a safety
    // net for base_url callers that predate agent_type.
    if (args.agent_type === 'kimi-code') {
      return executeKimiReconnect({
        base_url: args.base_url!,
        session_id: args.session_id!,
        auth_token_ref: args.auth_token_ref,
      })
    }
    if (args.agent_type === 'opencode') {
      return executeOpencodeReconnect({
        base_url: args.base_url!,
        session_id: args.session_id,
        auth_token_ref: args.auth_token_ref,
      })
    }
    if (
      args.session_id !== undefined &&
      kimiReconnectApplies(
        args.base_url!,
        args.session_id,
        context?.localDevice ?? 'local'
      )
    ) {
      return executeKimiReconnect({
        base_url: args.base_url!,
        session_id: args.session_id,
        auth_token_ref: args.auth_token_ref,
      })
    }
    return executeOpencodeReconnect({
      base_url: args.base_url!,
      session_id: args.session_id,
      auth_token_ref: args.auth_token_ref,
    })
  }

  server.registerTool(
    'reconnect',
    {
      title: 'Reconnect to xats',
      description: RECONNECT_DESC,
      inputSchema: reconnectInputSchema,
    },
    async (args: {
      identity_key?: string
      ui_pid?: number
      thread_id?: string
      ws_url?: string
      auth_token_ref?: string
      base_url?: string
      session_id?: string
      agent_type?: 'opencode' | 'kimi-code'
    }) => {
      return run(async () => executeReconnect(reconnectArgsSchema.parse(args)))
    }
  )

  server.registerTool(
    'unregister_self',
    {
      title: 'Unregister current agent',
      description: [
        'Remove the caller session\'s current agent registration.',
        'This tool only unregisters the currently bound agent identity; it does not delete other agents.',
        'On success it deletes the agent row and immediately releases the current MCP session back to an unregistered state.'
      ].join(' '),
      inputSchema: z.object({}).strict()
    },
    async () => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      const result = await wrapStorage(() => unregisterSelfSvc.unregister({ caller: who }))
      if (
        typeof result === 'object' &&
        result !== null &&
        'ok' in result &&
        result.ok === true &&
        'agent_id' in result &&
        typeof result.agent_id === 'string'
      ) {
        releaseRegisteredState(result.agent_id)
        return toText(result)
      }
      touchIfRegistered()
      return toText(result)
    }
  )

  // list_agents
  server.registerTool(
    'list_agents',
    {
      title: 'List agents',
      description: [
        'List agents in the caller\'s team across all devices. Scope is caller-team only: this tool CANNOT see cross-team agents and MUST NOT be used to verify whether a cross-team recipient exists.',
        'DO NOT call list_agents as a pre-flight / pre-verify / pre-check step before send_message — neither for same-team nor for cross-team sends. For cross-team targets the pre-check will always falsely report "missing" because list_agents is caller-team scoped; for same-team targets the pre-check is pure waste.',
        'The canonical miss signal is the unknown_recipient error returned by send_message itself. The correct pattern is "try send, then handle unknown_recipient" — never "list_agents first, then send".'
      ].join(' '),
      inputSchema: {}
    },
    async () => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      const row = agents.findById(who)!
      return run(() => listAgentsForTeam(db, row.team, context?.localDevice ?? 'local'))
    }
  )

  // send_message (by name)
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description: SEND_MESSAGE_DESC,
      inputSchema: z.object({
        to_agent_name: z.string().min(1),
        to_team: z.string().min(1).optional(),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional(),
        need_reply: z.boolean().optional()
      }).strict()
    },
    async (args: {
      to_agent_name: string
      to_team?: string
      subject?: string
      body: string
      auto_poke?: boolean
      need_reply?: boolean
    }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => sendSvc.send({ from: who, ...args }))
    }
  )

  // send_message_by_id (by UUID)
  server.registerTool(
    'send_message_by_id',
    {
      title: 'Send message by id',
      description: SEND_MESSAGE_BY_ID_DESC,
      inputSchema: z.object({
        to_agent_id: z.string().min(1),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional(),
        need_reply: z.boolean().optional()
      }).strict()
    },
    async (args: {
      to_agent_id: string
      subject?: string
      body: string
      auto_poke?: boolean
      need_reply?: boolean
    }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => sendSvc.send({ from: who, ...args }))
    }
  )

  // broadcast
  server.registerTool(
    'broadcast',
    {
      title: 'Broadcast message',
      description: BROADCAST_DESC,
      inputSchema: {
        subject: z.string().optional(),
        body: z.string(),
        auto_poke: z.boolean().optional()
      }
    },
    async (args: { subject?: string; body: string; auto_poke?: boolean }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => broadcastSvc.broadcast({ from: who, ...args }))
    }
  )

  // broadcast_to_role
  server.registerTool(
    'broadcast_to_role',
    {
      title: 'Broadcast to role',
      description: BROADCAST_TO_ROLE_DESC,
      inputSchema: z.object({
        to_role: z.string().min(1),
        subject: z.string().optional(),
        body: z.string().min(1),
        auto_poke: z.boolean().optional()
      }).strict()
    },
    async (args: { to_role: string; subject?: string; body: string; auto_poke?: boolean }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => broadcastToRoleSvc.broadcast({ from: who, ...args }))
    }
  )

  // get_inbox
  server.registerTool(
    'get_inbox',
    {
      title: 'Get inbox',
      description: [
        'Return messages addressed to the caller (by agent_id or matching role) within the caller team.',
        'Default behaviour (since_event_id omitted): the daemon reads the caller\'s server-side cursor (`agents.last_processed_event_id`), returns mail past it, and ADVANCES the cursor to the highest returned event_id in the same transaction. Subsequent default calls return only newer mail.',
        'Pagination via `limit` advances the cursor only to the last RETURNED event_id; the next default call resumes from there.',
        'Explicit `since_event_id` (any number, including 0) is read-only inspection: the daemon uses the supplied value as the lower bound and does NOT advance the stored cursor — useful for re-reading history or debugging without disturbing live read position.',
        'REPLY GUIDANCE: every returned message carries `from_agent_id`, `from_name`, and `from_device` for the sender. When replying via `send_message`, construct `to_agent_name` as `from_name + ":" + from_device` whenever `from_device !== <your own device>` — otherwise the daemon resolves the bare name on YOUR device, misses the cross-device sender, and returns `unknown_recipient`. Bare `from_name` is correct only when `from_device === <your own device>`. `send_message_by_id({to_agent_id: from_agent_id, ...})` always works regardless of device and is the safe fallback when device is unknown.',
        'Retention: messages older than 30 days are deleted by the cleanup routine regardless of read state. Agents that go offline for more than 30 days forfeit any unread mail in that window.'
      ].join(' '),
      inputSchema: {
        since_event_id: z.number().int().optional(),
        limit: z.number().int().optional()
      }
    },
    async (args: { since_event_id?: number; limit?: number }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => inboxSvc.get({ caller: who, ...args }))
    }
  )

  // get_delivery_status
  server.registerTool(
    'get_delivery_status',
    {
      title: 'Get delivery status',
      description: [
        'Return wake-hint delivery status for a message sent by caller.',
        'Status describes auto-poke delivery only; mailbox persistence is already complete.',
        'Only the original sender can read a message delivery status.'
      ].join(' '),
      inputSchema: {
        message_id: z.string()
      }
    },
    async (args: { message_id: string }) => {
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      return run(() => deliveryStatusSvc.get({ caller: who, ...args }))
    }
  )

  // bind_channel — self-binding: caller (Claude host) writes its own channel_session_id
  if (channelWakeFanout) {
    const bindSvc = new BindChannelService(db, channelWakeFanout)
    server.registerTool(
      'bind_channel',
      {
        title: 'Bind channel_session_id to caller',
        description: [
          'Low-level rebind tool for Claude channel delivery.',
          'Bind the caller session\'s agent row to a channel_session_id produced by the cross-agent-teams-mcp channel proxy.',
          'Most callers should prefer `register_agent({ agent_type: "claude-code", channel_session_id, ... })` on the unified registration path.',
          'Call this when you need to rebind an already-registered row after the proxy announces a new csid AND your current MCP session is already bound to your agent.',
          'On a fresh or resumed MCP session (e.g. after a context clear or resume) the daemon has not yet associated this session with your agent, so bind_channel returns unknown_agent — use reconnect({ ui_pid: $PPID }) instead, which recovers your identity by process id and rebinds the channel in one step.',
          'Rejects proxy callers (role=__channel_proxy__).',
          'Rejects unknown csid (no live proxy sink attached).'
        ].join(' '),
        inputSchema: {
          channel_session_id: z.string().min(1)
        }
      },
      async (args: { channel_session_id: string }) => {
        const who = requireAgent()
        if (typeof who !== 'string') return toText(who)
        return run(() => bindSvc.bind({
          callerAgentId: who,
          channel_session_id: args.channel_session_id
        }))
      }
    )
  }

  server.registerTool(
    'bind_runtime_identity',
    {
      title: 'Bind runtime identity to caller',
      description: [
        'Bind the caller session\'s agent row to a verified tmux runtime identity.',
        'Pass `agent` to choose the built-in process matcher (`codex`, `claude-code`, `opencode`), or use `custom` together with `process_pattern`.',
        'Prefer passing `ui_pid` for the visible agent UI process; the daemon verifies pid → tty → pane before persisting `tmux_pane_id`.',
        'If `ui_pid` is unavailable, pass `ui_tty` together with `tmux_pane_id` for a weaker but still verified binding path.',
        'This tool writes registry state; `detect_tmux_pane` is for debugging only.'
      ].join(' '),
      inputSchema: bindRuntimeIdentitySchema,
    },
    async (args: {
      agent: 'codex' | 'claude-code' | 'opencode' | 'custom'
      ui_pid?: number
      ui_tty?: string
      tmux_pane_id?: string
      process_pattern?: string
    }) => {
      const parsed = bindRuntimeIdentityArgsSchema.safeParse(args)
      if (!parsed.success) {
        return toText({
          error: 'invalid_arguments',
          detail: parsed.error.issues.map(issue => issue.message).join('; '),
        })
      }
      const who = requireAgent()
      if (typeof who !== 'string') return toText(who)
      // Explicit repair-rebind mode: the service captures the row's CURRENT
      // generation at call start, so registrations that completed before
      // this call never block an explicit repair rebind, while one landing
      // during the verification await fails it closed
      // (stale_registration_bind) instead of stomping the newer session's
      // seat.  Register-time paths pass their own minted generation via
      // autoBindRuntimeIdentity instead.
      return run(() => bindRuntimeIdentitySvc.bind({
        callerAgentId: who,
        agent: parsed.data.agent,
        ui_pid: parsed.data.ui_pid,
        ui_tty: parsed.data.ui_tty,
        tmux_pane_id: parsed.data.tmux_pane_id,
        process_pattern: parsed.data.process_pattern,
        captureCurrentGeneration: true,
      }))
    }
  )

  // subscribe_channel_wake — reserved for channel proxies (role=__channel_proxy__)
  if (channelWakeFanout) {
    const subscribeSvc = new SubscribeChannelWakeService(db, channelWakeFanout)
    server.registerTool(
      'subscribe_channel_wake',
      {
        title: 'Subscribe channel wake',
        description: [
          'Internal tool reserved for the cross-agent-teams-mcp channel proxy.',
          'Attaches the caller\'s MCP session notification sink to a channel_session_id so the',
          'daemon can emit notifications/channel_wake to it.  Requires role=__channel_proxy__.'
        ].join(' '),
        inputSchema: { channel_session_id: z.string().min(1) }
      },
      async (args: { channel_session_id: string }) => {
        const who = requireAgent()
        if (typeof who !== 'string') return toText(who)
        const sid = getSessionId?.()
        if (!sid) return toText({ error: 'unknown_session' })
        const sink = (payload: unknown) => {
          const t = getTransport?.()
          if (!t) return
          try {
            void Promise.resolve(t.send(payload as Record<string, unknown>)).catch(() => { /* best-effort */ })
          } catch { /* best-effort */ }
        }
        return run(() => subscribeSvc.subscribe({
          callerAgentId: who,
          channel_session_id: args.channel_session_id,
          sessionId: sid,
          sink
        }))
      }
    )
  }

}
