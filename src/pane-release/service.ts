import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { AgentsRepo } from '../storage/agents-repo.js'
import { removeAgentRow } from '../mcp/unregister-self.js'
import { managedIdentityExists } from '../managed/guard.js'
import { defaultPaneProbes, PaneProbeError, type PaneProbes }
  from '../pane-lookup/probes.js'
import { describeRedactedError } from '../mcp/log-redact.js'
import { cancelCodexRecoverySchedule } from '../mcp/codex-recovery-poke.js'
import { cancelCodexSeedingSchedule } from '../mcp/codex-seeding-poke.js'
import { cancelOpencodeRecoveryPrompt } from '../mcp/opencode-runtime-recovery.js'
import { parseDeliveryRow } from '../lib/delivery-spec.js'
import { sameRuntimeAddress } from '../managed/coordinates.js'
import { ReleaseSnapshots, identical } from './snapshot.js'
import { ReleaseConflict } from './carrier.js'
import { PaneReleaseProofs, unlocatedOwner, type ReleaseProof } from './proof.js'
import { releaseFailure, type PaneReleaseInput, type ReleaseFailure } from './schema.js'

export interface PaneReleaseDeps {
  probes?: PaneProbes
  log: (message: string) => void
  onReleased?: (agentIds: string[]) => void
}

export class PaneReleaseService {
  private readonly snapshots: ReleaseSnapshots
  private readonly proofs: PaneReleaseProofs

  constructor(private readonly db: Database.Database, private readonly device: string,
    private readonly deps: PaneReleaseDeps, channels?: ChannelWakeFanout,
  ) {
    this.snapshots = new ReleaseSnapshots(db, device)
    this.proofs = new PaneReleaseProofs(db, device,
      deps.probes ?? defaultPaneProbes, channels)
  }

  async release(input: PaneReleaseInput) {
    const keys = input.targets.flatMap(target =>
      target.identity_key === undefined ? [] : [target.identity_key])
      .sort((a, b) => b.length - a.length)
    const first = await Promise.all(input.targets.map((target, index) =>
      this.capture(target, index, keys)))
    const failed = first.find(value => !value.ok)
    if (failed && !failed.ok) return failed.error
    const initial = first.map(value => {
      if (!value.ok) throw new Error('Unexpected release verification failure')
      return value.proof
    })
    const repeated = await Promise.all(input.targets.map((target, index) =>
      this.capture(target, index, keys)))
    const repeatedFailure = repeated.find(value => !value.ok)
    if (repeatedFailure && !repeatedFailure.ok) return repeatedFailure.error
    for (const [index, value] of repeated.entries()) {
      if (!value.ok || !identical(initial[index], value.proof)) {
        return releaseFailure('stale_binding', 'pane_or_registration_changed', index)
      }
    }
    const result = this.db.transaction(() => this.remove(input, initial)).immediate()
    if (result.ok) {
      const ids = initial.flatMap(proof => proof.row ? [proof.row.agent_id] : [])
      for (const proof of initial) this.retire(proof)
      this.deps.onReleased?.(ids)
    }
    return result
  }

  private async capture(target: PaneReleaseInput['targets'][number], index: number,
    keys: string[],
  ):
    Promise<{ ok: true; proof: ReleaseProof } | { ok: false; error: ReleaseFailure }> {
    try {
      return { ok: true, proof: await this.proofs.capture(target) }
    } catch (error) {
      if (error instanceof ReleaseConflict) {
        return { ok: false, error: releaseFailure(error.code, error.detail, index) }
      }
      const cause = error instanceof Error ? error.cause : undefined
      const detail = keys.reduce((message, key) => message.replaceAll(key, '[redacted]'),
        describeRedactedError(cause ?? error))
      this.deps.log(`pane release target=${index} failed: `
        + `${error instanceof PaneProbeError ? error.reason : 'internal_error'}: ${detail}`)
      return { ok: false, error: releaseFailure(
        error instanceof PaneProbeError ? 'probe_failed' : 'internal_error',
        error instanceof PaneProbeError ? error.reason : 'See daemon log',
        error instanceof PaneProbeError ? index : null, error instanceof PaneProbeError) }
    }
  }

  private remove(input: PaneReleaseInput, proofs: ReleaseProof[]) {
    const ids = proofs.flatMap(proof => proof.row ? [proof.row.agent_id] : [])
    const panes = proofs.map(proof => JSON.stringify({
      socket: proof.scope.socket.path, server: proof.scope.pane.server_pid,
      started: proof.scope.pane.server_started_at, pane: proof.scope.pane.pane_id,
    }))
    if (new Set(ids).size !== ids.length || new Set(panes).size !== panes.length) {
      return releaseFailure('ambiguous_identity', 'identity_matches_multiple_targets')
    }
    for (const [index, proof] of proofs.entries()) {
      const failed = this.validateSnapshot(input.targets[index], proof, index)
      if (failed) return failed
    }
    const results = proofs.map((proof, index) => this.removeVerified(proof, index))
    return { ok: true as const, protocol_version: 1 as const, results }
  }

  private validateSnapshot(target: PaneReleaseInput['targets'][number],
    proof: ReleaseProof, index: number,
  ): ReleaseFailure | undefined {
    const deadFailure = this.proofs.validateDead(target, proof, index)
    if (deadFailure) return deadFailure
    if (proof.historical.some(row =>
      !identical(row, this.snapshots.byId(row.agent_id)))) {
      return releaseFailure('stale_binding', 'historical_claim_changed', index)
    }
    if (proof.historical.some(row => managedIdentityExists(this.db, {
      device: this.device, agent_id: row.agent_id,
      identity_key: row.identity_key ?? undefined, name: row.name, team: row.team,
    }))) {
      return releaseFailure('managed_control_required', 'use_fenced_managed_release', index)
    }
    if (target.identity_key !== undefined && managedIdentityExists(this.db, {
      device: this.device, identity_key: target.identity_key,
    })) {
      return releaseFailure('managed_control_required', 'use_fenced_managed_release', index)
    }
    if (!this.uniqueOwner(proof)) {
      return releaseFailure('stale_binding', 'identity_ownership_changed', index)
    }
    if (!identical(proof.bindings, this.snapshots.bindings(target.tmux.pane_id))) {
      return releaseFailure('stale_binding', 'launch_binding_changed', index)
    }
    if (proof.row) {
      if (!identical(proof.row, this.snapshots.byId(proof.row.agent_id))) {
        return releaseFailure('stale_binding', 'registration_changed', index)
      }
      if (managedIdentityExists(this.db, { device: this.device,
        agent_id: proof.row.agent_id, identity_key: proof.row.identity_key ?? undefined,
        name: proof.row.name, team: proof.row.team })) {
        return releaseFailure('managed_control_required', 'use_fenced_managed_release', index)
      }
    } else if (this.snapshots.pane(target.tmux.pane_id).some(row =>
      !proof.historical.some(old => old.agent_id === row.agent_id))
      || (target.identity_key !== undefined
        && this.snapshots.byKey(target.identity_key).length > 0)) {
      return releaseFailure('stale_binding', 'identity_appeared', index)
    }
  }

  private removeVerified(proof: ReleaseProof, index: number) {
    if (proof.dead) return { index, state: 'dead_key_unclaimed' as const, agent: null }
    if (!proof.row) return { index, state: 'already_unregistered' as const, agent: null }
    const removed = removeAgentRow(this.db, new AgentsRepo(this.db), proof.row.agent_id)
    if ('error' in removed) throw new Error('Verified release row disappeared')
    this.db.prepare('DELETE FROM codex_pane_bindings WHERE agent_id=?')
      .run(proof.row.agent_id)
    const pending = proof.bindings.pending
    if (pending && proof.bindings.codex?.agent_id === proof.row.agent_id
      && pending.xats_agent_id === proof.bindings.codex.launch_id
      && pending.identity_key === proof.row.identity_key) {
      this.db.prepare(`DELETE FROM codex_pane_pre_registrations
        WHERE pane_id=? AND xats_agent_id=? AND identity_key IS ? AND expires_at=?`)
        .run(pending.pane_id, pending.xats_agent_id, pending.identity_key, pending.expires_at)
    }
    return { index, state: 'released' as const, agent: {
      agent_id: proof.row.agent_id, name: proof.row.name, team: proof.row.team,
      agent_type: proof.row.agent_type } }
  }

  private uniqueOwner(proof: ReleaseProof): boolean {
    const delivery = proof.row ? parseDeliveryRow(proof.row)
      : proof.carrier ? { kind: 'opencode-server' as const,
        ...proof.carrier.runtime } : undefined
    return this.snapshots.native().every(row => {
      if (row.agent_id === proof.row?.agent_id) return true
      if (!proof.row && unlocatedOwner(row, proof.kinds, proof.carrier?.runtime)) {
        return false
      }
      return (row.tmux_pane_id !== proof.scope.pane.pane_id
        || proof.historical.some(old => identical(old, row)))
        && (row.runtime_ui_pid === null || !proof.pids.includes(row.runtime_ui_pid))
        && (!delivery || !sameRuntimeAddress(parseDeliveryRow(row), delivery))
    })
  }

  private retire(proof: ReleaseProof): void {
    const row = proof.row
    if (!row) return
    cancelOpencodeRecoveryPrompt(row.agent_id)
    const pending = proof.bindings.pending
    if (pending && proof.bindings.codex?.agent_id === row.agent_id
      && pending.xats_agent_id === proof.bindings.codex.launch_id
      && pending.identity_key === row.identity_key) {
      cancelCodexRecoverySchedule(pending.pane_id)
      cancelCodexSeedingSchedule(pending.pane_id)
    }
  }
}
