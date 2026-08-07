import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  parseDeliveryRow,
  serializeDelivery,
  type DeliverySpec,
  type DeliveryRow,
} from '../lib/delivery-spec.js'
import type { AgentType } from '../lib/agent-type.js'
import { canonicalKimiBaseUrl } from '../lib/kimi-url.js'
import { tryCanonicalOpencodeBaseUrl } from '../lib/opencode-url.js'
import { isAlive } from '../daemon/pid.js'
import { isGenerationAwareOpencodeRow } from '../lib/agent-runtime.js'

export interface RegisterInput {
  agent_type?: AgentType
  agent_type_name?: string
  device?: string
  model?: string
  name: string
  role?: string
  team?: string
  tmux_pane_id?: string
  delivery?: DeliverySpec
  claude_ui_pid?: number
  runtime_ui_pid?: number
  remote_addr?: string | null
  identity_key?: string
  opencode_runtime_generation?: number
}

export interface AgentRow {
  agent_id: string
  agent_type: AgentType | null
  agent_type_name: string | null
  device: string
  team: string
  role: string
  name: string
  model: string | null
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  delivery: DeliverySpec
  channel_session_id: string | null
  identity_key: string | null
  opencode_runtime_generation?: number
  last_seen_at: string
}

export interface OpencodeRuntimeRow extends AgentRow {
  opencode_runtime_generation: number
  delivery_kind: string
  delivery_payload: string | null
  registered_at: string
  last_processed_event_id: number
  register_generation: number
}

export interface AgentListRow extends AgentRow {
  online: boolean
}

export interface RuntimeUiPidMatch {
  agent_id: string
  device: string
  team: string
  name: string
  role: string
  last_seen_at: string
}

export type CodexThreadMatch = RuntimeUiPidMatch

export type OpencodeSessionMatch = RuntimeUiPidMatch

export type KimiSessionMatch = RuntimeUiPidMatch

/** Adds the pid the register-time four-branch rule arbitrates on. */
export interface IdentityKeyMatch extends RuntimeUiPidMatch {
  runtime_ui_pid: number | null
}

/** Same-thread evidence row: carries every surviving physical-seat field
 *  (pid / tty / pane) plus runtime_bound_at so rows left behind by a rename
 *  chain can collapse to the last-writer-wins owner of one seat. */
export interface ThreadRuntimeRow extends IdentityKeyMatch {
  runtime_tty: string | null
  tmux_pane_id: string | null
  runtime_bound_at: string | null
}

/** CAS snapshot of a (device, team, name) row: the stored codex-appserver
 *  thread plus every physical-seat field.  Captured once before the async
 *  register probe and again ATOMICALLY inside the upsert transaction; a
 *  mismatch proves a concurrent registration rewrote the row during the
 *  probe window.  Deliberately excludes identity_key so the snapshot can
 *  never leak a key into logs. */
export interface IdentityRowSnapshot {
  agent_id: string
  codex_thread_id: string | null
  runtime_ui_pid: number | null
  runtime_tty: string | null
  tmux_pane_id: string | null
  runtime_bound_at: string | null
}

export function sameIdentityRowSnapshot(
  a: IdentityRowSnapshot | null,
  b: IdentityRowSnapshot | null
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.agent_id === b.agent_id &&
    a.codex_thread_id === b.codex_thread_id &&
    a.runtime_ui_pid === b.runtime_ui_pid &&
    a.runtime_tty === b.runtime_tty &&
    a.tmux_pane_id === b.tmux_pane_id &&
    a.runtime_bound_at === b.runtime_bound_at
  )
}

/** Seat-follow holder row: carries the key value itself because the caller
 *  row must be bound to exactly the key the holder is giving up, and the
 *  holder's codex-appserver thread id because thread equality is the only
 *  authorization that lets an ALIVE holder lose its key. */
export interface SeatKeyHolder extends IdentityKeyMatch {
  identity_key: string
  codex_thread_id: string | null
}

export const REACHABLE_MS = 4 * 24 * 60 * 60 * 1000

type DbAgentRow = {
  agent_id: string
  agent_type: AgentType | null
  agent_type_name: string | null
  device: string
  team: string
  role: string
  name: string
  model: string | null
  tmux_pane_id: string | null
  runtime_ui_pid: number | null
  identity_key: string | null
  opencode_runtime_generation: number | null
  last_seen_at: string
} & DeliveryRow

export function isAgentLive(
  agent: Pick<AgentRow, 'device' | 'runtime_ui_pid' | 'tmux_pane_id' | 'last_seen_at'>,
  args: { localDevice: string; livePanes: Set<string> | null }
): boolean {
  const local = agent.device === args.localDevice
  if (local && agent.runtime_ui_pid !== null && agent.runtime_ui_pid > 0) {
    return isAlive(agent.runtime_ui_pid)
  }
  if (local && agent.tmux_pane_id !== null && args.livePanes !== null) {
    return args.livePanes.has(agent.tmux_pane_id)
  }
  const lastSeenMs = new Date(agent.last_seen_at).getTime()
  if (!Number.isFinite(lastSeenMs)) return false
  return Date.now() - lastSeenMs <= REACHABLE_MS
}

function toAgentRow(row: DbAgentRow): AgentRow {
  const delivery = parseDeliveryRow(row)
  return {
    agent_id: row.agent_id,
    agent_type: row.agent_type,
    agent_type_name: row.agent_type_name,
    device: row.device,
    team: row.team,
    role: row.role,
    name: row.name,
    model: row.model,
    tmux_pane_id: row.tmux_pane_id,
    runtime_ui_pid: row.runtime_ui_pid,
    delivery,
    channel_session_id:
      delivery.kind === 'claude-channel' ? delivery.channel_session_id : null,
    identity_key: row.identity_key,
    opencode_runtime_generation: row.opencode_runtime_generation ?? 0,
    last_seen_at: row.last_seen_at,
  }
}

export class AgentsRepo {
  constructor(private db: Database.Database) {
    // Bind hot read-paths so callers can destructure or extract method
    // references without losing `this` binding. (Tests in particular extract
    // `repo.list` to a local for type-cast purposes.)
    this.list = this.list.bind(this)
  }

  private runGuardedLegacyWrite(agent_id: string, write: () => void): void {
    const tx = this.db.transaction(() => {
      if (isGenerationAwareOpencodeRow(this.findById(agent_id))) {
        throw new Error('opencode_runtime_coordinates_required')
      }
      write()
    })
    tx()
  }

  findByIdentity(args: { device: string; team: string; name: string }): { agent_id: string } | undefined {
    return this.db.prepare(
      `SELECT agent_id FROM agents WHERE device=? AND team=? AND name=?`
    ).get(args.device, args.team, args.name) as { agent_id: string } | undefined
  }

  /**
   * CAS snapshot read for the register flow.  The same query runs at the
   * pre-probe capture point and inside the upsert transaction so the two
   * snapshots are field-for-field comparable.
   */
  readIdentityRowSnapshot(args: {
    device: string
    team: string
    name: string
  }): IdentityRowSnapshot | undefined {
    return this.db.prepare(
      `SELECT agent_id,
              CASE
                WHEN delivery_kind = 'codex-appserver'
                 AND json_valid(delivery_payload)
                THEN json_extract(delivery_payload, '$.thread_id')
              END AS codex_thread_id,
              runtime_ui_pid, runtime_tty, tmux_pane_id, runtime_bound_at
       FROM agents WHERE device=? AND team=? AND name=?`
    ).get(args.device, args.team, args.name) as IdentityRowSnapshot | undefined
  }

  findByRuntimeUiPid(ui_pid: number, localDevice: string): RuntimeUiPidMatch[] {
    return this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND runtime_ui_pid IS NOT NULL
         AND runtime_ui_pid = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, ui_pid) as RuntimeUiPidMatch[]
  }

  /**
   * Reverse lookup by the launcher-minted identity key. Unlike the pid /
   * thread / session lookups this key survives a pane restart; the device
   * scope and the proxy-row exclusion are the same as theirs.
   */
  findByIdentityKey(
    identity_key: string,
    localDevice: string
  ): IdentityKeyMatch[] {
    return this.db.prepare(
      `SELECT agent_id, device, team, name, role, runtime_ui_pid, last_seen_at
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND identity_key = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, identity_key) as IdentityKeyMatch[]
  }

  findOpencodeRuntimeByIdentityKey(
    identity_key: string,
    localDevice: string
  ): OpencodeRuntimeRow | undefined {
    const row = this.db.prepare(
      `SELECT agent_id, agent_type, agent_type_name, device, team, role, name,
              model, tmux_pane_id, runtime_ui_pid, delivery_kind,
              delivery_payload, identity_key,
              COALESCE(opencode_runtime_generation, 0)
                AS opencode_runtime_generation,
              last_seen_at, registered_at, last_processed_event_id,
              register_generation
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND identity_key = ?`
    ).get(localDevice, identity_key) as (
      DbAgentRow & {
        registered_at: string
        last_processed_event_id: number
        register_generation: number
      }
    ) | undefined
    if (!row) return undefined
    return {
      ...toAgentRow(row),
      opencode_runtime_generation: row.opencode_runtime_generation ?? 0,
      delivery_kind: row.delivery_kind,
      delivery_payload: row.delivery_payload,
      registered_at: row.registered_at,
      last_processed_event_id: row.last_processed_event_id,
      register_generation: row.register_generation,
    }
  }

  compareAndSetOpencodeRuntimeGeneration(args: {
    agent_id: string
    device: string
    identity_key: string
    expected_generation: number
    expected_register_generation: number
    runtime_generation: number
  }): { changes: number } {
    const result = this.db.prepare(
      `UPDATE agents
       SET opencode_runtime_generation = ?
       WHERE agent_id = ?
         AND device = ?
         AND identity_key = ?
         AND COALESCE(opencode_runtime_generation, 0) = ?
         AND register_generation = ?
         AND (
           agent_type = 'opencode'
           OR (agent_type IS NULL AND delivery_kind = 'opencode-server')
         )`
    ).run(
      args.runtime_generation,
      args.agent_id,
      args.device,
      args.identity_key,
      args.expected_generation,
      args.expected_register_generation
    )
    return { changes: result.changes }
  }

  compareAndSetOpencodeDelivery(args: {
    agent_id: string
    device: string
    identity_key: string
    expected_generation: number
    expected_register_generation: number
    expected_delivery_kind: string
    expected_delivery_payload: string | null
    delivery: Extract<DeliverySpec, { kind: 'opencode-server' }>
  }): { changes: number; pair_conflict_agent_id?: string } {
    const serialized = serializeDelivery(args.delivery)
    const tx = this.db.transaction(() => {
      const collision = this.findByOpencodeSession(
        args.delivery.base_url,
        args.delivery.session_id,
        args.device
      ).find(row => row.agent_id !== args.agent_id)
      if (collision) {
        return { changes: 0, pair_conflict_agent_id: collision.agent_id }
      }
      const result = this.db.prepare(
        `UPDATE agents
         SET delivery_kind = ?, delivery_payload = ?
         WHERE agent_id = ?
           AND device = ?
           AND identity_key = ?
           AND COALESCE(opencode_runtime_generation, 0) = ?
           AND register_generation = ?
           AND (
             agent_type = 'opencode'
             OR (agent_type IS NULL AND delivery_kind = 'opencode-server')
           )
           AND delivery_kind = ?
           AND delivery_payload IS ?`
      ).run(
        serialized.delivery_kind,
        serialized.delivery_payload,
        args.agent_id,
        args.device,
        args.identity_key,
        args.expected_generation,
        args.expected_register_generation,
        args.expected_delivery_kind,
        args.expected_delivery_payload
      )
      return { changes: result.changes }
    })
    return tx()
  }

  clearIdentityKey(agent_id: string): void {
    this.runGuardedLegacyWrite(agent_id, () => {
      this.db.prepare(
        `UPDATE agents SET identity_key = NULL WHERE agent_id = ?`
      ).run(agent_id)
    })
  }

  bindIdentityKey(agent_id: string, identity_key: string): void {
    this.runGuardedLegacyWrite(agent_id, () => {
      this.db.prepare(
        `UPDATE agents SET identity_key = ? WHERE agent_id = ?`
      ).run(identity_key, agent_id)
    })
  }

  /**
   * Seat-follow holder lookup: OTHER rows on the caller's device that still
   * hold an identity_key and whose runtime binding places them on the seat
   * the caller just bound.  After a same-pane rebind the incumbent row's
   * tmux_pane_id is already cleared (last-writer-wins pane binding), so the
   * match runs on runtime_ui_pid and on prev_tmux_pane_id — the pane the
   * clear took away, which is what "the caller took over this row's pane"
   * actually means and which also covers binds that record no pid.
   *
   * runtime_tty is deliberately NOT a leg: a tty number is drawn from a pool
   * and reused as soon as a pane closes, so it proves nothing about the seat.
   * It once moved a live key onto an unrelated brand-new pane, and a recycled
   * tty equally produces spurious candidates that suppress legitimate follows
   * through the caller-side `holders.length !== 1` guard.
   */
  findKeyHoldersBySeat(
    caller_agent_id: string,
    localDevice: string
  ): SeatKeyHolder[] {
    return this.db.prepare(
      `SELECT h.agent_id, h.device, h.team, h.name, h.role,
              h.runtime_ui_pid, h.identity_key, h.last_seen_at,
              CASE
                WHEN h.delivery_kind = 'codex-appserver'
                 AND json_valid(h.delivery_payload)
                THEN json_extract(h.delivery_payload, '$.thread_id')
              END AS codex_thread_id
       FROM agents h
       JOIN agents c ON c.agent_id = ?
       WHERE h.agent_id != c.agent_id
         AND h.device = c.device
         AND h.device = ?
         AND h.role != '__channel_proxy__'
         AND h.identity_key IS NOT NULL
         AND (
           (c.runtime_ui_pid IS NOT NULL
            AND h.runtime_ui_pid = c.runtime_ui_pid)
           OR (c.tmux_pane_id IS NOT NULL
               AND h.prev_tmux_pane_id = c.tmux_pane_id)
         )
       ORDER BY h.last_seen_at DESC`
    ).all(caller_agent_id, localDevice) as SeatKeyHolder[]
  }

  /**
   * Same-thread evidence lookup: rows on the caller's device whose
   * codex-appserver thread equals the caller's AND that still carry a bound
   * runtime (runtime_ui_pid or runtime_tty).  A codex registration with such
   * evidence is a same-conversation re-registration: it must inherit the
   * collapsed physical seat and never scan foreign pre-reg rows.
   * `excludeAgentId` is optional so the register flow can include the
   * caller's own upsert-reused row (its preserved runtime is same-session
   * evidence when its pre-upsert stored thread equals the registering one).
   */
  findRuntimeByThread(
    thread_id: string,
    localDevice: string,
    excludeAgentId?: string
  ): ThreadRuntimeRow[] {
    // '' is never a real agent_id, so an omitted exclusion excludes nothing.
    return this.db.prepare(
      `SELECT agent_id, device, team, name, role, runtime_ui_pid,
              runtime_tty, tmux_pane_id, runtime_bound_at, last_seen_at
       FROM agents
       WHERE device = ?
         AND agent_id != ?
         AND role != '__channel_proxy__'
         AND delivery_kind = 'codex-appserver'
         AND CASE
           WHEN json_valid(delivery_payload)
           THEN json_extract(delivery_payload, '$.thread_id')
         END = ?
         AND (runtime_ui_pid IS NOT NULL OR runtime_tty IS NOT NULL)
       ORDER BY last_seen_at DESC`
    ).all(localDevice, excludeAgentId ?? '', thread_id) as ThreadRuntimeRow[]
  }

  findByCodexThreadId(
    thread_id: string,
    localDevice: string
  ): CodexThreadMatch[] {
    return this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND delivery_kind = 'codex-appserver'
         AND CASE
           WHEN json_valid(delivery_payload)
           THEN json_extract(delivery_payload, '$.thread_id')
         END = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, thread_id) as CodexThreadMatch[]
  }

  /** Precise canonical OpenCode reverse lookup on the local device. */
  findByOpencodeSession(
    base_url: string,
    session_id: string,
    localDevice: string
  ): OpencodeSessionMatch[] {
    const canonicalBaseUrl = tryCanonicalOpencodeBaseUrl(base_url)
    if (canonicalBaseUrl === undefined) return []
    const rows = this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at,
              json_extract(delivery_payload, '$.base_url') AS base_url
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND delivery_kind = 'opencode-server'
         AND json_valid(delivery_payload)
         AND json_extract(delivery_payload, '$.session_id') = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, session_id) as Array<
      OpencodeSessionMatch & { base_url: unknown }
    >
    return rows.flatMap(({ base_url: storedBaseUrl, ...row }) =>
      tryCanonicalOpencodeBaseUrl(storedBaseUrl) === canonicalBaseUrl
        ? [row]
        : []
    )
  }

  /**
   * Broad base_url-only lookup for reconnect credential recovery.
   * Multi-row (ambiguous) results must be surfaced, not auto-picked.
   */
  findByOpencodeBaseUrl(
    base_url: string,
    localDevice: string
  ): OpencodeSessionMatch[] {
    const canonicalBaseUrl = tryCanonicalOpencodeBaseUrl(base_url)
    if (canonicalBaseUrl === undefined) return []
    const rows = this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at,
              json_extract(delivery_payload, '$.base_url') AS base_url
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND delivery_kind = 'opencode-server'
         AND json_valid(delivery_payload)
       ORDER BY last_seen_at DESC`
    ).all(localDevice) as Array<
      OpencodeSessionMatch & { base_url: unknown }
    >
    return rows.flatMap(({ base_url: storedBaseUrl, ...row }) =>
      tryCanonicalOpencodeBaseUrl(storedBaseUrl) === canonicalBaseUrl
        ? [row]
        : []
    )
  }

  /**
   * Precise kimi reverse lookup. base_url compared via the shared kimi
   * canonicalizer in JS (not SQL rtrim) so rows persisted before URL
   * canonicalization — case/default-port/slash variants — still match;
   * scoped to localDevice (remote servers unreachable here).
   */
  findByKimiSession(
    base_url: string,
    session_id: string,
    localDevice: string
  ): KimiSessionMatch[] {
    const target = canonicalKimiBaseUrl(base_url)
    const rows = this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at,
         CASE
           WHEN json_valid(delivery_payload)
           THEN json_extract(delivery_payload, '$.base_url')
         END AS payload_base_url
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND delivery_kind = 'kimi-server'
         AND CASE
           WHEN json_valid(delivery_payload)
           THEN json_extract(delivery_payload, '$.session_id')
         END = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, session_id) as Array<
      KimiSessionMatch & { payload_base_url: string | null }
    >
    return rows
      .filter(row =>
        typeof row.payload_base_url === 'string'
        && canonicalKimiBaseUrl(row.payload_base_url) === target
      )
      .map(({ payload_base_url: _url, ...match }) => match)
  }

  /**
   * Session-id-only kimi reverse lookup, for handshake-level identity bind:
   * the X-Kimi-Base-Url header may be absent, in which case the unique local
   * row claiming the session id supplies the base_url to probe. The caller
   * fails closed on zero or multiple matches. Same scoping and canonical JS
   * comparison rules as findByKimiSession; rows without a payload base_url
   * cannot be probed and are dropped.
   */
  findKimiBySessionId(
    session_id: string,
    localDevice: string
  ): Array<KimiSessionMatch & { base_url: string }> {
    const rows = this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at,
         CASE
           WHEN json_valid(delivery_payload)
           THEN json_extract(delivery_payload, '$.base_url')
         END AS payload_base_url
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND delivery_kind = 'kimi-server'
         AND CASE
           WHEN json_valid(delivery_payload)
           THEN json_extract(delivery_payload, '$.session_id')
         END = ?
       ORDER BY last_seen_at DESC`
    ).all(localDevice, session_id) as Array<
      KimiSessionMatch & { payload_base_url: string | null }
    >
    return rows.flatMap(({ payload_base_url, ...match }) =>
      typeof payload_base_url === 'string' && payload_base_url.length > 0
        ? [{ ...match, base_url: payload_base_url }]
        : []
    )
  }

  /**
   * Broad base_url-only kimi lookup. Used to decide whether a reconnect
   * base_url targets a kimi server; never used to auto-pick a session.
   * Same canonical JS comparison as findByKimiSession.
   */
  findByKimiBaseUrl(
    base_url: string,
    localDevice: string
  ): KimiSessionMatch[] {
    const target = canonicalKimiBaseUrl(base_url)
    const rows = this.db.prepare(
      `SELECT agent_id, device, team, name, role, last_seen_at,
         CASE
           WHEN json_valid(delivery_payload)
           THEN json_extract(delivery_payload, '$.base_url')
         END AS payload_base_url
       FROM agents
       WHERE device = ?
         AND role != '__channel_proxy__'
         AND delivery_kind = 'kimi-server'
       ORDER BY last_seen_at DESC`
    ).all(localDevice) as Array<
      KimiSessionMatch & { payload_base_url: string | null }
    >
    return rows
      .filter(row =>
        typeof row.payload_base_url === 'string'
        && canonicalKimiBaseUrl(row.payload_base_url) === target
      )
      .map(({ payload_base_url: _url, ...match }) => match)
  }

  register(input: RegisterInput): {
    agent_id: string
    team: string
    prior_snapshot: IdentityRowSnapshot | null
    register_generation: number
  } {
    const team = input.team ?? 'default'
    const device = input.device ?? 'local'
    const role = input.role ?? 'default'
    const name = input.name
    const now = new Date().toISOString()
    const newId = randomUUID()
    const delivery = input.delivery ?? { kind: 'none' }
    const serialized = serializeDelivery(delivery)
    const preserveExistingDelivery = input.delivery === undefined ? 1 : 0
    // SELECT prior → upsert inside ONE synchronous transaction: the returned
    // prior state is the row's ACTUAL pre-write content, immune to the async
    // probe window that makes any earlier capture potentially stale.  The
    // register_generation the upsert minted is read inside the same
    // transaction so a register-time bind can make its final write
    // conditional on exactly this registration.
    let priorSnapshot: IdentityRowSnapshot | null = null
    const tx = this.db.transaction(() => {
      priorSnapshot =
        this.readIdentityRowSnapshot({ device, team, name }) ?? null
      this.writeAgentRow({
        newId,
        input,
        team,
        device,
        role,
        name,
        now,
        serialized,
        preserveExistingDelivery,
      })
      const rebindCsid =
        role === '__channel_proxy__' &&
        input.claude_ui_pid !== undefined &&
        delivery.kind === 'claude-channel'
          ? delivery.channel_session_id
          : undefined
      if (rebindCsid !== undefined) {
        this.reactiveRebindHosts({
          proxy_device: device,
          team,
          claude_ui_pid: input.claude_ui_pid!,
          new_csid: rebindCsid,
        })
      }
      const written = this.db.prepare(
        `SELECT agent_id, register_generation
         FROM agents WHERE device=? AND team=? AND name=?`
      ).get(device, team, name) as {
        agent_id: string
        register_generation: number
      }
      if (input.tmux_pane_id) {
        this.clearPaneBinding(device, input.tmux_pane_id, written.agent_id)
      }
      return written
    })
    const written = tx()
    return {
      agent_id: written.agent_id,
      team,
      prior_snapshot: priorSnapshot,
      register_generation: written.register_generation,
    }
  }

  private writeAgentRow(args: {
    newId: string
    input: RegisterInput
    team: string
    device: string
    role: string
    name: string
    now: string
    serialized: ReturnType<typeof serializeDelivery>
    preserveExistingDelivery: number
  }): void {
    const { newId, input, team, device, role, name, now, serialized, preserveExistingDelivery } = args
    // Fresh INSERT initialises last_processed_event_id to MAX(event_id) so
    // newly registered agents do not see historical mail. The MAX read happens
    // inside the same SQLite transaction as the INSERT (writeAgentRow is always
    // called from `register`'s db.transaction). Reuse path preserves the
    // existing cursor — the ON CONFLICT branch deliberately does not touch
    // last_processed_event_id.
    this.db.prepare(
      `INSERT INTO agents (
         agent_id, agent_type, agent_type_name, device, team, role, name, model, registered_at, last_seen_at,
         tmux_pane_id, claude_ui_pid, runtime_ui_pid, delivery_kind, delivery_payload, remote_addr,
         identity_key, register_generation, opencode_runtime_generation,
         last_processed_event_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?,
               COALESCE((SELECT MAX(event_id) FROM events), 0))
       ON CONFLICT (device, team, name) DO UPDATE SET
         agent_type = excluded.agent_type,
         agent_type_name = excluded.agent_type_name,
         role = excluded.role,
         model = excluded.model,
         last_seen_at = excluded.last_seen_at,
         tmux_pane_id = COALESCE(excluded.tmux_pane_id, tmux_pane_id),
         -- Second writer of a live pane, and it must forget the lost one for
         -- the same reason setRuntimeBinding does: prev_tmux_pane_id means
         -- "the pane this row lost AND has not replaced".  Cleared only when
         -- this upsert actually supplies a pane — a registration that carries
         -- none leaves the binding alone and must leave the memory alone too.
         prev_tmux_pane_id = CASE
           WHEN excluded.tmux_pane_id IS NOT NULL THEN NULL
           ELSE prev_tmux_pane_id
         END,
         claude_ui_pid = COALESCE(excluded.claude_ui_pid, claude_ui_pid),
         runtime_ui_pid = COALESCE(excluded.runtime_ui_pid, runtime_ui_pid),
         remote_addr = excluded.remote_addr,
         identity_key = COALESCE(excluded.identity_key, identity_key),
         register_generation = register_generation + 1,
         opencode_runtime_generation = CASE
           WHEN ? THEN COALESCE(opencode_runtime_generation, 0)
           ELSE excluded.opencode_runtime_generation
         END,
         delivery_kind = CASE
           WHEN ? THEN delivery_kind
           ELSE excluded.delivery_kind
         END,
         delivery_payload = CASE
           WHEN ? THEN delivery_payload
           ELSE excluded.delivery_payload
         END`
    ).run(
      newId,
      input.agent_type ?? null,
      input.agent_type_name ?? null,
      device,
      team,
      role,
      name,
      input.model ?? null,
      now,
      now,
      input.tmux_pane_id ?? null,
      input.claude_ui_pid ?? null,
      input.runtime_ui_pid ?? null,
      serialized.delivery_kind,
      serialized.delivery_payload,
      input.remote_addr ?? null,
      input.identity_key ?? null,
      input.opencode_runtime_generation ?? 0,
      input.opencode_runtime_generation === undefined ? 1 : 0,
      preserveExistingDelivery,
      preserveExistingDelivery,
    )
  }

  /**
   * A tmux pane hosts one agent UI at a time, so the newest binding evicts any
   * incumbent on the same (device, pane). Only the pane column is cleared —
   * the incumbent row, its cursor, mailbox and delivery stay intact.
   *
   * The evicted pane is remembered in prev_tmux_pane_id by the SAME statement
   * that clears it, so the two can never disagree: seat-follow's dead-holder
   * branch needs "the pane this row lost", and this is the only code that
   * knows it. prev_tmux_pane_id records a LOST pane and is never a binding.
   */
  private clearPaneBinding(device: string, pane: string, keepAgentId: string): void {
    this.db.prepare(
      `UPDATE agents
       SET tmux_pane_id=NULL,
           prev_tmux_pane_id=?
       WHERE device=? AND tmux_pane_id=? AND agent_id != ?`
    ).run(pane, device, pane, keepAgentId)
  }

  private reactiveRebindHosts(args: {
    proxy_device: string
    team: string
    claude_ui_pid: number
    new_csid: string
  }): void {
    this.db.prepare(
      `UPDATE agents
       SET delivery_kind = 'claude-channel',
           delivery_payload = json_object('channel_session_id', ?)
       WHERE role != '__channel_proxy__'
         AND device = ?
         AND runtime_ui_pid IS NOT NULL
         AND runtime_ui_pid = ?
         AND team = ?
         AND (
           delivery_kind = 'none'
           OR (delivery_kind = 'claude-channel'
               AND json_extract(delivery_payload,'$.channel_session_id') != ?)
         )
         AND NOT (
           agent_type = 'opencode'
           AND COALESCE(opencode_runtime_generation, 0) > 0
         )`
    ).run(args.new_csid, args.proxy_device, args.claude_ui_pid, args.team, args.new_csid)
  }

  setDelivery(agent_id: string, spec: DeliverySpec): void {
    const serialized = serializeDelivery(spec)
    this.runGuardedLegacyWrite(agent_id, () => {
      this.db.prepare(
        `UPDATE agents
         SET delivery_kind=?, delivery_payload=?
         WHERE agent_id=?`
      ).run(serialized.delivery_kind, serialized.delivery_payload, agent_id)
    })
  }

  setAgentType(agent_id: string, agent_type: AgentType, agent_type_name?: string | null): void {
    this.runGuardedLegacyWrite(agent_id, () => {
      this.db.prepare(
        `UPDATE agents
         SET agent_type=?,
             agent_type_name=?
         WHERE agent_id=?`
      ).run(agent_type, agent_type_name ?? null, agent_id)
    })
  }

  /**
   * Persists a runtime binding.  When `expected_register_generation` is set
   * (every register-time bind path passes the generation its OWN
   * registration minted), the UPDATE is conditional on the row still
   * carrying that generation: a bind whose verification await outlived a
   * newer same-(device, team, name) registration changes ZERO rows, and the
   * incumbent pane eviction is skipped too — a stale bind must not touch
   * any row.  Callers observe `changes === 0` and fail the bind closed.
   */
  setRuntimeBinding(
    agent_id: string,
    args: {
      tmux_pane_id: string
      runtime_ui_pid: number | null
      runtime_tty: string
      runtime_verification_mode: string
      runtime_bound_at?: string
      expected_register_generation?: number
    }
  ): { changes: number } {
    const tx = this.db.transaction(() => {
      const conditional = args.expected_register_generation !== undefined
      const result = this.db.prepare(
        // prev_tmux_pane_id is cleared here on purpose: it means "the pane
        // this row lost and has not replaced".  A row that lost %10, later
        // bound %20 and then died would otherwise still answer to %10, and
        // seat-follow's dead-holder branch would hand its key to whoever took
        // over %10 rather than %20 — a stale identifier authorising a key
        // move, which is the defect this column was added to remove.
        `UPDATE agents
         SET tmux_pane_id=?,
             prev_tmux_pane_id=NULL,
             runtime_ui_pid=?,
             runtime_tty=?,
             runtime_verification_mode=?,
             runtime_bound_at=?
         WHERE agent_id=?` +
        (conditional ? ` AND register_generation=?` : ``)
      ).run(
        args.tmux_pane_id,
        args.runtime_ui_pid,
        args.runtime_tty,
        args.runtime_verification_mode,
        args.runtime_bound_at ?? new Date().toISOString(),
        agent_id,
        ...(conditional ? [args.expected_register_generation] : [])
      )
      if (result.changes === 0) return { changes: 0 }
      const row = this.db.prepare(
        `SELECT device FROM agents WHERE agent_id=?`
      ).get(agent_id) as { device: string } | undefined
      if (row) this.clearPaneBinding(row.device, args.tmux_pane_id, agent_id)
      return { changes: result.changes }
    })
    return tx()
  }

  /**
   * Clears every runtime-seat field, conditional on the row still carrying
   * the given generation.  The register upsert preserves the prior seat via
   * COALESCE, so a CAS-drift registration must wipe the residue it inherited
   * — but only while its own registration is still the newest one; a later
   * registration's freshly bound seat changes ZERO rows here.
   */
  clearRuntimeBinding(
    agent_id: string,
    args: { expected_register_generation: number }
  ): { changes: number } {
    const result = this.db.prepare(
      `UPDATE agents
       SET tmux_pane_id=NULL,
           runtime_ui_pid=NULL,
           runtime_tty=NULL,
           runtime_verification_mode=NULL,
           runtime_bound_at=NULL
       WHERE agent_id=? AND register_generation=?`
    ).run(agent_id, args.expected_register_generation)
    return { changes: result.changes }
  }

  getRegisterGeneration(agent_id: string): number | undefined {
    const row = this.db.prepare(
      `SELECT register_generation FROM agents WHERE agent_id=?`
    ).get(agent_id) as { register_generation: number } | undefined
    return row?.register_generation
  }

  list(args: {
    team: string
    excludeRoles?: string[]
    localDevice?: string
    livePanes?: Set<string> | null
  }): AgentListRow[] {
    const exclude = args.excludeRoles ?? []
    const baseSelect =
      `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         device,
         team,
         role,
         name,
         model,
         tmux_pane_id,
         runtime_ui_pid,
         delivery_kind,
         delivery_payload,
         identity_key,
         opencode_runtime_generation,
         last_seen_at
       FROM agents
       WHERE team=?`
    const orderBy = ` ORDER BY registered_at ASC`
    let rows: DbAgentRow[]
    if (exclude.length > 0) {
      const placeholders = exclude.map(() => '?').join(',')
      rows = this.db.prepare(
        `${baseSelect} AND role NOT IN (${placeholders})${orderBy}`
      ).all(args.team, ...exclude) as DbAgentRow[]
    } else {
      rows = this.db.prepare(`${baseSelect}${orderBy}`).all(args.team) as DbAgentRow[]
    }
    const localDevice = args.localDevice ?? 'local'
    const livePanes = args.livePanes ?? null
    return rows.map((row) => {
      const agent = toAgentRow(row)
      return {
        ...agent,
        online: isAgentLive(agent, { localDevice, livePanes }),
      }
    })
  }

  touch(agent_id: string): void {
    this.db.prepare(`UPDATE agents SET last_seen_at=? WHERE agent_id=?`).run(new Date().toISOString(), agent_id)
  }

  deleteById(agent_id: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM agents
       WHERE agent_id=?`
    ).run(agent_id)
    return result.changes === 1
  }

  getById(agent_id: string): AgentRow | undefined {
    const row = this.db.prepare(
      `SELECT
         agent_id,
         agent_type,
         agent_type_name,
         device,
         team,
         role,
         name,
         model,
         tmux_pane_id,
         runtime_ui_pid,
         delivery_kind,
         delivery_payload,
         identity_key,
         opencode_runtime_generation,
         last_seen_at
       FROM agents
       WHERE agent_id=?`
    ).get(agent_id) as DbAgentRow | undefined
    if (!row) return undefined
    return toAgentRow(row)
  }

  findById(agent_id: string): AgentRow | undefined {
    return this.getById(agent_id)
  }
}
