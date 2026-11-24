import type Database from 'better-sqlite3'
import type { PaneProbes } from '../pane-lookup/probes.js'
import { managedIdentityExists } from '../managed/guard.js'
import { inspectDeadScope, ReleaseConflict } from './carrier.js'
import { identical, ReleaseSnapshots, type ReleaseAgent } from './snapshot.js'
import { releaseFailure, type PaneReleaseTarget } from './schema.js'

type Bindings = ReturnType<ReleaseSnapshots['bindings']>

export class DeadPaneProofs {
  private readonly snapshots: ReleaseSnapshots

  constructor(private readonly db: Database.Database, private readonly device: string,
    private readonly probes: PaneProbes,
  ) {
    this.snapshots = new ReleaseSnapshots(db, device)
  }

  async capture(target: PaneReleaseTarget) {
    const scope = await inspectDeadScope(target.tmux, this.probes)
    const bindings = this.snapshots.bindings(target.tmux.pane_id)
    const related = this.related(bindings)
    this.assertAbsent(target)
    this.assertBindings(target, bindings, related)
    const oldPid = bindings.codex?.runtime_ui_pid
    if (oldPid !== null && oldPid !== undefined
      && await this.probes.process(oldPid) !== undefined) {
      throw new ReleaseConflict('pane_unverifiable',
        'old_binding_process_still_present')
    }
    return { row: null, scope, bindings, carrier: null,
      pids: [] as number[], kinds: [] as string[], historical: [] as ReleaseAgent[],
      dead: { related } }
  }

  validate(target: PaneReleaseTarget,
    proof: Pick<DeadReleaseProof, 'dead' | 'bindings'>, index: number,
  ) {
    try {
      this.assertAbsent(target)
      const related = this.related(proof.bindings)
      if (!identical(related, proof.dead.related)) {
        return releaseFailure('stale_binding', 'related_registration_changed', index)
      }
      this.assertBindings(target, proof.bindings, related)
    } catch (error) {
      if (!(error instanceof ReleaseConflict)) throw error
      return releaseFailure(error.code, error.detail, index)
    }
  }

  private related(bindings: Bindings): ReleaseAgent | null {
    return bindings.codex?.agent_id
      ? this.snapshots.byId(bindings.codex.agent_id, true) ?? null : null
  }

  private assertAbsent(target: PaneReleaseTarget): void {
    if (managedIdentityExists(this.db, {
      device: this.device, identity_key: target.identity_key!,
    })) {
      throw new ReleaseConflict('managed_control_required',
        'use_fenced_managed_release')
    }
    if (this.snapshots.byKey(target.identity_key!, true).length > 0) {
      throw new ReleaseConflict('identity_mismatch', 'identity_key_has_holder')
    }
    if (this.snapshots.pane(target.tmux.pane_id, true).length > 0) {
      throw new ReleaseConflict('pane_unverifiable', 'stored_pane_identity_present')
    }
  }

  private assertBindings(target: PaneReleaseTarget, bindings: Bindings,
    related: ReleaseAgent | null,
  ): void {
    const pending = bindings.pending
    if (pending?.identity_key && managedIdentityExists(this.db, {
      device: this.device, identity_key: pending.identity_key,
    })) {
      throw new ReleaseConflict('managed_control_required',
        'use_fenced_managed_release')
    }
    if (pending && !(Date.parse(pending.expires_at) <= Date.now())) {
      throw new ReleaseConflict('stale_binding', 'pending_launch_present')
    }
    const binding = bindings.codex
    if (!binding) return
    if (binding.agent_id === null) {
      if (binding.thread_id !== null || binding.runtime_ui_pid !== null
        || binding.runtime_tty !== null) {
        throw new ReleaseConflict('pane_unverifiable', 'incomplete_binding_snapshot')
      }
      return
    }
    if (!related && managedIdentityExists(this.db, {
      device: this.device, agent_id: binding.agent_id,
    })) {
      throw new ReleaseConflict('managed_control_required',
        'use_fenced_managed_release')
    }
    if (related && (related.tmux_pane_id === null
      || related.tmux_pane_id === target.tmux.pane_id)) {
      throw new ReleaseConflict('pane_unverifiable', 'binding_owner_not_relocated')
    }
    if (!binding.thread_id?.trim() || !binding.runtime_tty?.trim()
      || !Number.isSafeInteger(binding.runtime_ui_pid)
      || binding.runtime_ui_pid! <= 0) {
      throw new ReleaseConflict('pane_unverifiable', 'incomplete_binding_snapshot')
    }
  }
}

export type DeadReleaseProof = Awaited<ReturnType<DeadPaneProofs['capture']>>
