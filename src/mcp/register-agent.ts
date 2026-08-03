import type Database from 'better-sqlite3'
import {
  validateDeliveryForWrite,
  type DeliverySpec,
  type DeliveryValidationReason,
} from '../lib/delivery-spec.js'
import type { AgentType } from '../lib/agent-type.js'
import { deriveDefaultTeam } from '../lib/default-team.js'
import { canonicalKimiBaseUrl } from './kimi-session-state.js'
import { canonicalOpencodeBaseUrl } from '../lib/opencode-url.js'
import {
  isGenerationAwareOpencodeRow,
  resolveAgentType,
} from '../lib/agent-runtime.js'
import {
  AgentsRepo,
  type IdentityKeyMatch,
  type IdentityRowSnapshot,
} from '../storage/agents-repo.js'
import type { SessionOriginInfo } from '../daemon/network-origin.js'
import { isAlive } from '../daemon/pid.js'

export { deriveDefaultTeam } from '../lib/default-team.js'

export interface RegisterInput {
  connection_id: string
  agent_type?: AgentType
  agent_type_name?: string
  model?: string
  device?: string
  name: string
  role?: string
  team?: string
  project_dir?: string
  tmux_pane_id?: string
  delivery?: unknown
  claude_ui_pid?: number
  runtime_ui_pid?: number
  identity_key?: string
  opencode_runtime_generation?: number
}

export type IdentityKeyConflict = {
  error: 'identity_key_conflict'
  detail: { team: string; name: string }
}

type BaseRegisterResult =
  // prior_snapshot is the caller row's ACTUAL pre-upsert state, read inside
  // the same transaction as the upsert (CAS input for the codex same-thread
  // evidence path).  register_generation is the counter that upsert minted;
  // register-time runtime binds condition their final write on it.  Both are
  // internal only: the MCP tool layer strips them from every client-facing
  // envelope.
  | {
      agent_id: string
      team: string
      prior_snapshot: IdentityRowSnapshot | null
      register_generation: number
    }
  | { error: 'agent_id_collision' }
  | { error: 'invalid_delivery'; reason: DeliveryValidationReason }
  | { error: 'claude_ui_pid_requires_channel_proxy' }
  | { error: 'device_spoofing_from_loopback' }
  | { error: 'device_required_from_remote' }
  | { error: 'device_spoofing_local_label_from_remote' }
  | { error: 'invalid_device_label' }
  | { error: 'invalid_name_label' }
  | { error: 'invalid_team_label' }
  | IdentityKeyConflict

export type RegisterResult =
  | BaseRegisterResult
  | { error: 'agent_type_conflict' }
  | { error: 'stale_runtime_generation' }
  | { error: 'runtime_generation_not_reserved' }
  | { error: 'runtime_generation_conflict' }
  | { error: 'runtime_delivery_conflict'; conflicting_agent_id: string }
  | { error: 'opencode_runtime_coordinates_required' }

export type IdentityKeyPlan =
  | { kind: 'bind' }
  | { kind: 'migrate'; from_agent_id: string }
  | IdentityKeyConflict

/**
 * Decide what registering under `target` does to an identity key that some row
 * may already hold. The rename case is the reason a holder on another row is
 * not simply an error: the identity index is `(device, team, name)`, so a
 * rename inserts a new row and the key has to move off the abandoned one.
 * Only a holder whose pane is still running is a real conflict.
 */
export function planIdentityKeyBinding(args: {
  holder: IdentityKeyMatch | undefined
  target: { team: string; name: string }
  ui_pid?: number
  isProcessAlive?: (pid: number) => boolean
}): IdentityKeyPlan {
  const holder = args.holder
  if (holder === undefined) return { kind: 'bind' }
  if (holder.team === args.target.team && holder.name === args.target.name) {
    return { kind: 'bind' }
  }
  const alive = args.isProcessAlive ?? isAlive
  const pid = holder.runtime_ui_pid
  if (pid !== null && pid > 0 && pid !== args.ui_pid && alive(pid)) {
    return {
      error: 'identity_key_conflict',
      detail: { team: holder.team, name: holder.name },
    }
  }
  return { kind: 'migrate', from_agent_id: holder.agent_id }
}

function identityKey(device: string, team: string, name: string): string {
  return `${device}\u0000${team}\u0000${name}`
}

function sharedRuntimeKey(
  agentType: AgentType | undefined,
  delivery: DeliverySpec | undefined
): string | undefined {
  if (agentType === 'codex' && delivery?.kind === 'codex-appserver') {
    return delivery.thread_id
  }
  if (agentType === 'kimi-code' && delivery?.kind === 'kimi-server') {
    // kimi session ids are only unique per server: two connections share a
    // runtime identity only when BOTH the canonical base_url and the
    // session_id match; same session_id on another endpoint still takes over.
    return `${canonicalKimiBaseUrl(delivery.base_url)}\u0000${delivery.session_id}`
  }
  return undefined
}

export function validateNameLabel(name: string): { ok: string } | { error: 'invalid_name_label' } {
  if (name.includes(':') || name.includes('(') || name.includes(')')) {
    return { error: 'invalid_name_label' }
  }
  return { ok: name }
}

export function validateTeamLabel(team: string): { ok: string } | { error: 'invalid_team_label' } {
  if (team.includes('(') || team.includes(')')) {
    return { error: 'invalid_team_label' }
  }
  return { ok: team }
}

export function resolveEffectiveDevice(args: {
  requestedDevice?: string
  originInfo?: SessionOriginInfo
  localDevice: string
}):
  | { ok: string; remote_addr: string | null }
  | { error: 'device_spoofing_from_loopback' | 'device_required_from_remote' | 'device_spoofing_local_label_from_remote' | 'invalid_device_label' } {
  const origin = args.originInfo?.origin ?? 'local'
  const remote_addr = args.originInfo?.remote_addr ?? null
  const requestedDevice = args.requestedDevice?.trim()

  if (origin === 'local') {
    if (requestedDevice && requestedDevice !== args.localDevice) {
      return { error: 'device_spoofing_from_loopback' }
    }
    return { ok: args.localDevice, remote_addr: null }
  }

  if (!requestedDevice) {
    return { error: 'device_required_from_remote' }
  }
  if (requestedDevice.includes(':') || requestedDevice.length > 64) {
    return { error: 'invalid_device_label' }
  }
  // Normalize the remote-supplied label using the same rules the daemon and
  // channel-cli apply to locally-derived labels (lowercase, non-[a-z0-9_-]
  // replaced with '-'). Without this, the same physical host registers under
  // different labels depending on which path issued the register_agent call
  // (e.g. `MyMac.local` via direct register vs `mymac-local` via channel-cli).
  // requestedDevice is already trimmed and non-empty above, and `replace` (not
  // `remove`) maps every char to at least one output char, so the normalized
  // value is also non-empty.
  const normalizedDevice = requestedDevice
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
  if (normalizedDevice === args.localDevice) {
    return { error: 'device_spoofing_local_label_from_remote' }
  }
  return { ok: normalizedDevice, remote_addr }
}

export interface RegisterAgentDeps {
  /**
   * Called once for each conflicting connection during a cross-session
   * takeover. Returns true when the connection was found and close was issued.
   */
  closeSessionByConnectionId?: (connectionId: string) => boolean
  /** Optional debug log sink. */
  log?: (line: string) => void
  localDevice?: string
  getSessionOrigin?: (connectionId: string) => SessionOriginInfo | undefined
}

interface InitialOpencodeRuntimeContext {
  input: RegisterInput
  delivery: Extract<DeliverySpec, { kind: 'opencode-server' }>
  device: string
  remote_addr: string | null
  team: string
  role: string
}

export class RegisterAgentService {
  private readonly db: Database.Database
  private readonly repo: AgentsRepo
  private connections = new Map<
    string,
    Map<string, string | undefined>
  >()
  private readonly deps: RegisterAgentDeps

  constructor(db: Database.Database, deps: RegisterAgentDeps = {}) {
    this.db = db
    this.repo = new AgentsRepo(db)
    this.deps = deps
  }

  register(
    input: RegisterInput & {
      agent_type?: Exclude<AgentType, 'opencode'>
      opencode_runtime_generation?: undefined
    }
  ): BaseRegisterResult
  register(input: RegisterInput): RegisterResult
  register(input: RegisterInput): RegisterResult {
    const rawValidated =
      input.delivery === undefined
        ? undefined
        : validateDeliveryForWrite(input.delivery)
    if (rawValidated && 'error' in rawValidated) return rawValidated
    // Canonicalize at the persistence boundary, not only in the MCP tool
    // layer: the share key and the reconnect lookup compare canonical URLs,
    // so service-direct callers must persist the same form.
    let validated = rawValidated
    if (rawValidated?.ok.kind === 'kimi-server') {
      validated = {
        ok: {
          ...rawValidated.ok,
          base_url: canonicalKimiBaseUrl(rawValidated.ok.base_url),
        },
      }
    }
    if (
      rawValidated?.ok.kind === 'opencode-server'
      && input.opencode_runtime_generation !== undefined
    ) {
      try {
        validated = {
          ok: {
            ...rawValidated.ok,
            base_url: canonicalOpencodeBaseUrl(rawValidated.ok.base_url),
          },
        }
      } catch {
        return { error: 'invalid_delivery', reason: 'invalid_base_url' }
      }
    }

    const role = input.role ?? 'default'
    if (input.claude_ui_pid !== undefined && role !== '__channel_proxy__') {
      return { error: 'claude_ui_pid_requires_channel_proxy' }
    }
    const validName = validateNameLabel(input.name)
    if ('error' in validName) return validName
    if (input.team !== undefined) {
      const validTeam = validateTeamLabel(input.team)
      if ('error' in validTeam) return validTeam
    }
    const resolvedDevice = resolveEffectiveDevice({
      requestedDevice: input.device,
      originInfo: this.deps.getSessionOrigin?.(input.connection_id),
      localDevice: this.deps.localDevice ?? 'local',
    })
    if ('error' in resolvedDevice) return resolvedDevice

    const team = deriveDefaultTeam({
      team: input.team,
      project_dir: input.project_dir,
    })
    if (input.opencode_runtime_generation !== undefined) {
      return this.registerInitialOpencodeRuntime({
        input,
        delivery: validated?.ok,
        device: resolvedDevice.ok,
        remote_addr: resolvedDevice.remote_addr,
        team,
        role,
      })
    }
    // Resolved before any connection binding so a conflict leaves both the
    // registry and the in-memory session map untouched.
    const identityKeyPlan = input.identity_key === undefined
      ? undefined
      : planIdentityKeyBinding({
          holder: this.repo.findByIdentityKey(
            input.identity_key,
            resolvedDevice.ok
          )[0],
          target: { team, name: input.name },
          ui_pid: input.runtime_ui_pid,
        })
    if (identityKeyPlan !== undefined && 'error' in identityKeyPlan) {
      return identityKeyPlan
    }

    // One transaction: the old row must not lose the key unless the new row
    // gets it, and the unique index forbids both holding it at once.
    const write = this.db.transaction(() => {
      const target = this.repo.findByIdentity({
        device: resolvedDevice.ok,
        team,
        name: input.name,
      })
      const stored = target
        ? this.repo.findById(target.agent_id)
        : undefined
      const migratingHolder = identityKeyPlan?.kind === 'migrate'
        ? this.repo.findById(identityKeyPlan.from_agent_id)
        : undefined
      if (
        isGenerationAwareOpencodeRow(stored)
        || isGenerationAwareOpencodeRow(migratingHolder)
      ) {
        return { error: 'opencode_runtime_coordinates_required' as const }
      }
      if (identityKeyPlan?.kind === 'migrate') {
        this.repo.clearIdentityKey(identityKeyPlan.from_agent_id)
      }
      return this.repo.register({
        agent_type: input.agent_type,
        agent_type_name: input.agent_type_name,
        device: resolvedDevice.ok,
        model: input.model,
        name: input.name,
        role,
        team,
        tmux_pane_id: input.tmux_pane_id,
        delivery: validated?.ok,
        claude_ui_pid: input.claude_ui_pid,
        runtime_ui_pid: input.runtime_ui_pid,
        remote_addr: resolvedDevice.remote_addr,
        identity_key: input.identity_key,
        opencode_runtime_generation: input.opencode_runtime_generation,
      })
    })
    const result = write()
    if ('error' in result) return result
    this.bindConnection({
      key: identityKey(resolvedDevice.ok, team, input.name),
      connectionId: input.connection_id,
      runtimeKey: sharedRuntimeKey(input.agent_type, validated?.ok),
      device: resolvedDevice.ok,
      team,
      name: input.name,
    })
    return result
  }

  private registerInitialOpencodeRuntime(args: {
    input: RegisterInput
    delivery: DeliverySpec | undefined
    device: string
    remote_addr: string | null
    team: string
    role: string
  }): RegisterResult {
    const generation = args.input.opencode_runtime_generation!
    const delivery = args.delivery
    if (
      args.input.agent_type !== 'opencode'
      || args.input.identity_key === undefined
      || delivery?.kind !== 'opencode-server'
      || delivery.runtime_generation !== generation
    ) {
      return { error: 'invalid_delivery', reason: 'invalid_runtime_generation' }
    }
    const result = this.persistInitialOpencodeRuntime({
      ...args,
      delivery,
    })
    if ('error' in result) return result
    this.bindConnection({
      key: identityKey(args.device, args.team, args.input.name),
      connectionId: args.input.connection_id,
      runtimeKey: undefined,
      device: args.device,
      team: args.team,
      name: args.input.name,
    })
    return result
  }

  private persistInitialOpencodeRuntime(
    args: InitialOpencodeRuntimeContext
  ): RegisterResult {
    const write = this.db.transaction(() => {
      const target = this.repo.findByIdentity({
        device: args.device,
        team: args.team,
        name: args.input.name,
      })
      const holder = this.repo.findByIdentityKey(
        args.input.identity_key!,
        args.device
      )[0]
      if (target || holder) {
        return this.reuseInitialOpencodeRuntime({
          target_agent_id: target?.agent_id,
          holder,
          identity_key: args.input.identity_key!,
          generation: args.input.opencode_runtime_generation!,
          delivery: args.delivery,
          target: { team: args.team, name: args.input.name },
        })
      }
      const collision = this.repo.findByOpencodeSession(
        args.delivery.base_url,
        args.delivery.session_id,
        args.device
      )[0]
      if (collision) {
        return {
          error: 'runtime_delivery_conflict' as const,
          conflicting_agent_id: collision.agent_id,
        }
      }
      return this.repo.register({
        ...args.input,
        device: args.device,
        remote_addr: args.remote_addr,
        team: args.team,
        role: args.role,
        delivery: args.delivery,
      })
    })
    return write()
  }

  private reuseInitialOpencodeRuntime(args: {
    target_agent_id?: string
    holder: IdentityKeyMatch | undefined
    identity_key: string
    generation: number
    delivery: Extract<DeliverySpec, { kind: 'opencode-server' }>
    target: { team: string; name: string }
  }): RegisterResult {
    if (
      args.target_agent_id === undefined
      || args.holder?.agent_id !== args.target_agent_id
    ) {
      const conflict = args.holder ?? args.target
      return {
        error: 'identity_key_conflict',
        detail: { team: conflict.team, name: conflict.name },
      }
    }
    const row = this.repo.findOpencodeRuntimeByIdentityKey(
      args.identity_key,
      args.holder.device
    )!
    const actualType = resolveAgentType(row)
    if (actualType !== 'opencode') return { error: 'agent_type_conflict' }
    if (args.generation < row.opencode_runtime_generation) {
      return { error: 'stale_runtime_generation' }
    }
    if (args.generation > row.opencode_runtime_generation) {
      return { error: 'runtime_generation_not_reserved' }
    }
    if (
      row.delivery.kind !== 'opencode-server'
      || canonicalOpencodeBaseUrl(row.delivery.base_url)
        !== args.delivery.base_url
      || row.delivery.session_id !== args.delivery.session_id
      || row.delivery.auth_token_ref !== args.delivery.auth_token_ref
      || (row.delivery.runtime_generation ?? 0) !== args.generation
    ) {
      return { error: 'runtime_generation_conflict' }
    }
    return {
      agent_id: row.agent_id,
      team: row.team,
      prior_snapshot: null,
      register_generation: row.register_generation,
    }
  }

  releaseConnection(_agent_id: string, connection_id: string): void {
    const remaining = Array.from(this.connections.entries()).flatMap(
      ([key, bindings]): Array<[
        string,
        Map<string, string | undefined>
      ]> => {
        if (!bindings.has(connection_id)) return [[key, bindings]]
        const next = new Map(
          Array.from(bindings.entries()).filter(
            ([connectionId]) => connectionId !== connection_id
          )
        )
        return next.size === 0 ? [] : [[key, next]]
      }
    )
    this.connections = new Map(remaining)
  }

  bindExistingConnection(input: {
    connection_id: string
    agent_type: AgentType
    delivery: DeliverySpec
    device: string
    team: string
    name: string
  }): void {
    this.bindConnection({
      key: identityKey(input.device, input.team, input.name),
      connectionId: input.connection_id,
      runtimeKey: sharedRuntimeKey(input.agent_type, input.delivery),
      device: input.device,
      team: input.team,
      name: input.name,
    })
  }

  private bindConnection(input: {
    key: string
    connectionId: string
    runtimeKey: string | undefined
    device: string
    team: string
    name: string
  }): void {
    this.removeConnectionFromOtherIdentities(
      input.connectionId,
      input.key
    )
    const current = this.connections.get(input.key) ?? new Map()
    const prior = Array.from(current.entries()).filter(
      ([connectionId]) => connectionId !== input.connectionId
    )
    const canShare = input.runtimeKey !== undefined && prior.every(
      ([, runtimeKey]) => runtimeKey === input.runtimeKey
    )
    if (prior.length === 0 || canShare) {
      const next = new Map([
        ...current.entries(),
        [input.connectionId, input.runtimeKey] as const,
      ])
      this.storeBindings(input.key, next)
      return
    }
    const failed = prior.flatMap(([connectionId, runtimeKey]) => {
      const close = this.closeConnection(connectionId)
      this.log(
        `register_agent takeover: old=${connectionId} ` +
        `new=${input.connectionId} device=${input.device} ` +
        `team=${input.team} name=${input.name} closed=${close.closed}`
      )
      return close.keepBinding
        ? [[connectionId, runtimeKey] as const]
        : []
    })
    this.storeBindings(
      input.key,
      new Map([
        ...failed,
        [input.connectionId, input.runtimeKey] as const,
      ])
    )
  }

  private removeConnectionFromOtherIdentities(
    connectionId: string,
    targetKey: string
  ): void {
    this.connections = new Map(
      Array.from(this.connections.entries()).flatMap(([key, bindings]) => {
        if (key === targetKey || !bindings.has(connectionId)) {
          return [[key, bindings] as const]
        }
        const next = new Map(bindings)
        next.delete(connectionId)
        return next.size === 0 ? [] : [[key, next] as const]
      })
    )
  }

  private closeConnection(connectionId: string): {
    closed: boolean
    keepBinding: boolean
  } {
    try {
      return {
        closed: this.deps.closeSessionByConnectionId?.(connectionId) ?? false,
        keepBinding: false,
      }
    } catch (error) {
      const detail = error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
      this.log(
        `register_agent takeover close failed: old=${connectionId} ` +
        `cause=${detail}`,
        error
      )
      return { closed: false, keepBinding: true }
    }
  }

  private log(line: string, error?: unknown): void {
    try {
      this.deps.log?.(line)
    } catch (logError) {
      console.error('RegisterAgentService logger failed.', logError)
      if (error === undefined) console.error(line)
      else console.error(line, error)
      return
    }
    if (error !== undefined && this.deps.log === undefined) {
      console.error(line, error)
    }
  }

  private storeBindings(
    key: string,
    bindings: Map<string, string | undefined>
  ): void {
    const others = Array.from(this.connections.entries()).filter(
      ([existingKey]) => existingKey !== key
    )
    this.connections = new Map([...others, [key, bindings]])
  }
}
