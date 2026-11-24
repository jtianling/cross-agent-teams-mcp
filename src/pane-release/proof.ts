import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { PaneLookupService } from '../pane-lookup/service.js'
import type { PaneProbes, ProcessSnapshot } from '../pane-lookup/probes.js'
import { parseDeliveryRow } from '../lib/delivery-spec.js'
import { tryCanonicalOpencodeBaseUrl } from '../lib/opencode-url.js'
import { managedIdentityExists } from '../managed/guard.js'
import { DeadPaneProofs, type DeadReleaseProof } from './dead.js'
import type { PaneReleaseTarget } from './schema.js'
import { identical, ReleaseSnapshots, type ReleaseAgent } from './snapshot.js'
import { foregroundProcesses, inspectScope, ReleaseConflict, selectOpencode,
  carrierKinds, type PaneScope }
  from './carrier.js'

export class PaneReleaseProofs {
  private readonly snapshots: ReleaseSnapshots
  private readonly lookup: PaneLookupService
  private readonly dead: DeadPaneProofs

  constructor(private readonly db: Database.Database, private readonly device: string,
    private readonly probes: PaneProbes, channels?: ChannelWakeFanout,
  ) {
    this.snapshots = new ReleaseSnapshots(db, device)
    this.lookup = new PaneLookupService(db, device, channels, probes)
    this.dead = new DeadPaneProofs(db, device, probes)
  }

  async capture(target: PaneReleaseTarget): Promise<ReleaseProof> {
    if (target.allow_dead_if_identity_unclaimed) return this.dead.capture(target)
    if (target.identity_key !== undefined && managedIdentityExists(this.db, {
      device: this.device, identity_key: target.identity_key,
    })) {
      throw new ReleaseConflict('managed_control_required', 'use_fenced_managed_release')
    }
    const native = this.snapshots.native()
    const keyed = target.identity_key === undefined ? []
      : native.filter(row => row.identity_key === target.identity_key)
    if (keyed.length > 1) {
      throw new ReleaseConflict('ambiguous_identity', 'identity_key_ambiguous')
    }
    const claimed = keyed[0]
    if (claimed?.tmux_pane_id && claimed.tmux_pane_id !== target.tmux.pane_id) {
      throw new ReleaseConflict('identity_mismatch', 'identity_bound_to_another_pane')
    }
    const bindings = this.snapshots.bindings(target.tmux.pane_id)
    const scope = await inspectScope(target.tmux, this.probes)
    const lookup = await this.lookup.lookup({ protocol_version: 1, tmux: target.tmux })
    if (lookup.identity.status === 'verified' && lookup.identity.agent) {
      const row = native.find(row => row.agent_id === lookup.identity.agent!.agent_id)
      if (!row) throw new ReleaseConflict('stale_binding', 'registration_changed')
      this.checkTarget(target, row)
      if (row.delivery_kind !== 'opencode-server') {
        await this.stillScoped(target, scope)
        return { row, scope, bindings, carrier: null,
          pids: [row.runtime_ui_pid!], kinds: [] as string[],
          historical: [] as ReleaseAgent[], dead: null }
      }
    }
    if (lookup.identity.status === 'ambiguous') {
      throw new ReleaseConflict('ambiguous_identity', lookup.identity.reason)
    }
    if (lookup.identity.status === 'stale') {
      throw new ReleaseConflict('stale_binding', lookup.identity.reason)
    }
    return this.captureNative(target, native, claimed, scope, bindings)
  }

  private async captureNative(target: PaneReleaseTarget, native: ReleaseAgent[],
    claimed: ReleaseAgent | undefined, scope: PaneScope,
    bindings: ReturnType<ReleaseSnapshots['bindings']>,
  ) {
    const foreground = await foregroundProcesses(scope.pane, this.probes)
    const historical = await this.historicalClaims(target, native, claimed, scope)
    const attached = selectOpencode(foreground.processes)
    const kinds = carrierKinds(foreground.processes)
    if (target.opencode_session_id !== undefined
      && attached?.runtime.session_id !== target.opencode_session_id) {
      throw new ReleaseConflict('identity_mismatch', 'opencode_session_mismatch')
    }
    const row = this.attachOwner(native, attached)
    const paneRows = native.filter(item => item.tmux_pane_id === target.tmux.pane_id
      && !historical.some(old => old.agent_id === item.agent_id))
    if (row && attached) {
      this.checkTarget(target, row)
      if ((row.tmux_pane_id && row.tmux_pane_id !== target.tmux.pane_id)
        || (row.runtime_ui_pid && !foreground.processes.some(process =>
          process.pid === row.runtime_ui_pid))
        || paneRows.some(other => other.agent_id !== row.agent_id)) {
        throw new ReleaseConflict('identity_mismatch', 'runtime_binding_mismatch')
      }
    } else if (claimed || paneRows.length > 0 || native.some(item =>
      foreground.processes.some(process => process.pid === item.runtime_ui_pid)
      || unlocatedOwner(item, kinds, attached?.runtime))) {
      throw new ReleaseConflict('pane_unverifiable', 'no_verified_current_carrier')
    }
    await this.stillScoped(target, scope)
    if (attached && !identical(await this.probes.process(attached.process.pid),
      attached.process)) {
      throw new ReleaseConflict('stale_binding', 'opencode_carrier_changed')
    }
    return { row: row ?? null, scope, bindings, kinds, historical, dead: null,
      pids: foreground.processes.map(process => process.pid).sort((a, b) => a - b),
      carrier: attached ? { ...attached, root: foreground.root } : null }
  }

  validateDead(target: PaneReleaseTarget, proof: ReleaseProof, index: number) {
    if (proof.dead) return this.dead.validate(target, {
      dead: proof.dead, bindings: proof.bindings,
    }, index)
  }

  private async historicalClaims(target: PaneReleaseTarget, native: ReleaseAgent[],
    claimed: ReleaseAgent | undefined, scope: PaneScope,
  ): Promise<ReleaseAgent[]> {
    if (target.identity_key === undefined || claimed) return []
    const candidates = native.filter(row =>
      row.tmux_pane_id === target.tmux.pane_id
      && Boolean(row.identity_key?.trim()) && row.identity_key !== target.identity_key
      && row.runtime_verification_mode === 'verified_pid_tty_pane'
      && row.runtime_ui_pid !== null && row.runtime_ui_pid > 0
      && Boolean(row.runtime_tty?.trim())
      && row.runtime_bound_at !== null
      && Date.parse(row.runtime_bound_at) < scope.pane.server_started_at * 1000)
    const absent = await Promise.all(candidates.map(async row => {
      if (managedIdentityExists(this.db, { device: this.device,
        agent_id: row.agent_id, identity_key: row.identity_key!,
        name: row.name, team: row.team })) return null
      return await this.probes.process(row.runtime_ui_pid!) === undefined ? row : null
    }))
    return absent.filter((row): row is ReleaseAgent => row !== null)
  }

  private attachOwner(native: ReleaseAgent[], attached: ReturnType<typeof selectOpencode>) {
    const matches = attached ? native.filter(row => {
      const delivery = parseDeliveryRow(row)
      return (row.agent_type === 'opencode' || row.agent_type === null)
        && delivery.kind === 'opencode-server'
        && tryCanonicalOpencodeBaseUrl(delivery.base_url) === attached.runtime.base_url
        && delivery.session_id === attached.runtime.session_id
    }) : []
    if (matches.length > 1) {
      throw new ReleaseConflict('ambiguous_identity', 'opencode_runtime_ambiguous')
    }
    return matches[0]
  }

  private checkTarget(target: PaneReleaseTarget, row: ReleaseAgent): void {
    if (target.identity_key !== undefined && target.identity_key !== row.identity_key) {
      throw new ReleaseConflict('identity_mismatch', 'identity_key_mismatch')
    }
    if (managedIdentityExists(this.db, { device: this.device, agent_id: row.agent_id,
      identity_key: row.identity_key ?? undefined, name: row.name, team: row.team })) {
      throw new ReleaseConflict('managed_control_required', 'use_fenced_managed_release')
    }
    if (target.opencode_session_id !== undefined) {
      const delivery = parseDeliveryRow(row)
      if ((row.agent_type !== 'opencode' && row.agent_type !== null)
        || delivery.kind !== 'opencode-server'
        || delivery.session_id !== target.opencode_session_id) {
        throw new ReleaseConflict('identity_mismatch', 'opencode_session_mismatch')
      }
    }
  }

  private async stillScoped(target: PaneReleaseTarget,
    original: Awaited<ReturnType<typeof inspectScope>>,
  ) {
    if (!identical(original, await inspectScope(target.tmux, this.probes))) {
      throw new ReleaseConflict('stale_binding', 'pane_scope_changed')
    }
  }
}

export interface ReleaseProof {
  row: ReleaseAgent | null
  scope: PaneScope
  bindings: ReturnType<ReleaseSnapshots['bindings']>
  carrier: (NonNullable<ReturnType<typeof selectOpencode>>
    & { root: ProcessSnapshot }) | null
  pids: number[]
  kinds: string[]
  historical: ReleaseAgent[]
  dead: DeadReleaseProof['dead'] | null
}

const NATIVE_KIND: Readonly<Record<string, string>> = {
  'codex-appserver': 'codex', 'claude-channel': 'claude-code',
  'opencode-server': 'opencode',
}

export function unlocatedOwner(row: ReleaseAgent, kinds: string[],
  attached?: { base_url: string; session_id: string },
): boolean {
  if (row.tmux_pane_id !== null || row.runtime_ui_pid !== null) return false
  const inferred = row.agent_type ?? NATIVE_KIND[row.delivery_kind]
  if (!kinds.includes(inferred)) return false
  const delivery = parseDeliveryRow(row)
  if (inferred === 'opencode' && attached && delivery.kind === 'opencode-server') {
    return tryCanonicalOpencodeBaseUrl(delivery.base_url) === attached.base_url
      && delivery.session_id === attached.session_id
  }
  return true
}
