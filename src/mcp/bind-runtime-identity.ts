import type Database from 'better-sqlite3'
import {
  bindRuntimeIdentity,
  type BindRuntimeIdentityInput,
  type BindRuntimeIdentityResult,
} from '../daemon/runtime-identity.js'
import { AgentsRepo } from '../storage/agents-repo.js'

/**
 * Every caller must pick a generation mode explicitly — there is no silent
 * default a future register-time caller could fall into by omission.
 * Register-time binds pass the register_generation their OWN registration
 * minted; the final write then persists only while the row still carries
 * that generation, so a bind whose verification await outlived a newer
 * same-(device, team, name) registration fails closed instead of stomping
 * the newer session's seat.  `captureCurrentGeneration` is the explicit
 * repair-rebind mode (the user-invoked bind_runtime_identity MCP tool):
 * the row's CURRENT generation is captured at call start, so registrations
 * that completed before the call never block it, while one landing during
 * the verification await fails it closed — every final write through this
 * service is conditional either way.
 */
export type BindGenerationMode =
  | { expectedRegisterGeneration: number; captureCurrentGeneration?: never }
  | { captureCurrentGeneration: true; expectedRegisterGeneration?: never }

export type BindRuntimeIdentityServiceInput =
  BindRuntimeIdentityInput & { callerAgentId: string } & BindGenerationMode

export type BindRuntimeIdentityServiceResult =
  | ({ ok: true } & Omit<Extract<BindRuntimeIdentityResult, { ok: true }>, 'ok'>)
  | Extract<BindRuntimeIdentityResult, { error: string }>
  | { error: 'unknown_agent' }
  | { error: 'stale_registration_bind' }

/** Verified runtime identity, not yet written anywhere. */
export type VerifiedRuntimeIdentity =
  Extract<BindRuntimeIdentityResult, { ok: true }> & {
    expectedRegisterGeneration: number
  }

export type VerifyRuntimeIdentityResult =
  | VerifiedRuntimeIdentity
  | Extract<BindRuntimeIdentityResult, { error: string }>
  | { error: 'unknown_agent' }

export class BindRuntimeIdentityService {
  private readonly repo: AgentsRepo

  constructor(
    db: Database.Database,
    private readonly log?: (line: string) => void
  ) {
    this.repo = new AgentsRepo(db)
  }

  /**
   * The ASYNC half: pid/tty/pane probes plus the generation the final write
   * must be conditional on.  Writes nothing, so a caller that needs the
   * persist to share a transaction with other decisions (claim arbitration,
   * pre-reg consumption, key attach) can call `commit` inside its own
   * transaction instead of letting this service write on its own.
   */
  async verify(
    input: BindRuntimeIdentityServiceInput
  ): Promise<VerifyRuntimeIdentityResult> {
    const caller = this.repo.getById(input.callerAgentId)
    if (!caller) return { error: 'unknown_agent' }
    // Capture-at-call-start: without an explicit generation the final write
    // is conditioned on the generation the row carries NOW, so the same
    // late-write race the register-time paths guard against cannot re-enter
    // through this caller either.  A row deleted between the two reads is
    // an unknown agent, not an unconditional write.
    const expectedGeneration =
      input.expectedRegisterGeneration
      ?? this.repo.getRegisterGeneration(input.callerAgentId)
    if (expectedGeneration === undefined) return { error: 'unknown_agent' }

    const result = await bindRuntimeIdentity(input)
    if (!('ok' in result) || !result.ok) {
      return result as Extract<BindRuntimeIdentityResult, { error: string }>
    }
    return { ...result, expectedRegisterGeneration: expectedGeneration }
  }

  /**
   * The SYNC half: the generation-conditional persist.  Safe to call inside a
   * caller-owned transaction — when that transaction rolls back, so does this
   * write AND the incumbent-pane eviction it performs, which a post-hoc
   * "clear the caller row" undo can never restore.
   */
  commit(
    callerAgentId: string,
    verified: VerifiedRuntimeIdentity
  ): { ok: true } | { error: 'stale_registration_bind' } {
    const written = this.repo.setRuntimeBinding(callerAgentId, {
      tmux_pane_id: verified.tmux_pane_id,
      runtime_ui_pid: verified.ui_pid ?? null,
      runtime_tty: verified.tty,
      runtime_verification_mode: verified.verification_mode,
      expected_register_generation: verified.expectedRegisterGeneration,
    })
    if (written.changes === 0) {
      // The row's generation moved past this registration while the bind
      // awaited verification: a newer registration owns the row now.  Fail
      // closed — nothing was written, and the caller must not run any
      // bind-derived follow-up (seat-follow) for this registration.
      this.log?.(
        `runtime bind stale (debug): agent=${callerAgentId} ` +
        `reason=stale_registration_bind ` +
        `expected_generation=${verified.expectedRegisterGeneration} changes=0`
      )
      return { error: 'stale_registration_bind' }
    }
    return { ok: true }
  }

  /** verify + commit for callers with nothing else to make atomic. */
  async bind(
    input: BindRuntimeIdentityServiceInput
  ): Promise<BindRuntimeIdentityServiceResult> {
    const verified = await this.verify(input)
    if ('error' in verified) return verified
    const written = this.commit(input.callerAgentId, verified)
    if ('error' in written) return written
    const { expectedRegisterGeneration: _generation, ...result } = verified
    return result
  }
}
