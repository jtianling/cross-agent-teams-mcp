import type { AgentsRepo, AgentRow } from '../storage/agents-repo.js'
import { canonicalKimiBaseUrl } from './kimi-session-state.js'
import type { ValidateKimiSessionResult } from './reconnect.js'
import {
  KIMI_RUNTIME_COMMIT_PROTOCOL_VERSION,
  type CommitKimiRuntimeRestInput,
} from './kimi-runtime-control-schema.js'

export { KIMI_RUNTIME_COMMIT_PROTOCOL_VERSION } from './kimi-runtime-control-schema.js'

export interface KimiRuntimeControlDeps {
  localDevice: string
  probeSession: (args: {
    base_url: string
    session_id: string
    auth_token_ref?: string
  }) => Promise<ValidateKimiSessionResult>
}

function isKimiRow(row: AgentRow): boolean {
  if (row.agent_type === 'kimi-code') return true
  return row.agent_type === null && row.delivery.kind === 'kimi-server'
}

/**
 * Launcher-facing coordinate refresh for a kimi pane.
 *
 * It exists because the agent cannot do this itself: kimi never scopes
 * `XATS_IDENTITY_KEY` per session, so under a server-hosted engine an agent
 * reading its own environment gets another pane's key. The launcher is the
 * only party that knows which key belongs to which pane, and this endpoint is
 * how it says so without the key ever entering the pane.
 *
 * Deliberately NOT a reserve/commit pair: there is no generation, no CAS, and
 * no recovery prompt. The absence of `runtime_generation` from every response
 * is the signal — callers must not infer a fence that is not here. The
 * launcher serializes pane teardown instead.
 *
 * It also never refreshes `last_seen_at`. That column is decision-bearing (the
 * poke retry path reads it as "the recipient was active"), and a launcher
 * action is not agent activity. Leaving it alone is what lets a caller use it
 * as a clean probe for "a bound session actually called a tool".
 */
export class KimiRuntimeControlService {
  constructor(
    private readonly repo: AgentsRepo,
    private readonly deps: KimiRuntimeControlDeps
  ) {}

  async commit(input: CommitKimiRuntimeRestInput): Promise<unknown> {
    if (input.protocol_version !== KIMI_RUNTIME_COMMIT_PROTOCOL_VERSION) {
      return {
        ok: false,
        error: 'protocol_version_mismatch',
        cli_protocol_version: input.protocol_version,
        daemon_protocol_version: KIMI_RUNTIME_COMMIT_PROTOCOL_VERSION,
      }
    }
    const device = this.deps.localDevice
    const base_url = canonicalKimiBaseUrl(input.base_url)
    const resolved = this.resolveTarget(input.identity_key, base_url, input.session_id, device)
    if ('error' in resolved || 'need_register' in resolved) return resolved

    const { row, adopt } = resolved
    if (!isKimiRow(row)) {
      return {
        ok: false,
        error: 'agent_type_conflict',
        expected: 'kimi-code',
        actual: row.agent_type ?? row.delivery.kind,
      }
    }
    // Always checked, including on the idempotent path: catching "someone else
    // already claims these coordinates" before the pane starts is the only
    // place the one-session-one-row rule can be enforced without locking a
    // pane out of registering.
    const collision = this.repo
      .findByKimiSession(base_url, input.session_id, device)
      .find(match => match.agent_id !== row.agent_id)
    if (collision) {
      return {
        ok: false,
        error: 'session_claimed_by_other_agent',
        conflicting_agent_id: collision.agent_id,
        name: collision.name,
        team: collision.team,
      }
    }

    const current = row.delivery
    const idempotent = current.kind === 'kimi-server'
      && canonicalKimiBaseUrl(current.base_url) === base_url
      && current.session_id === input.session_id
    if (!idempotent) {
      const auth_token_ref = current.kind === 'kimi-server'
        ? current.auth_token_ref
        : undefined
      const probe = await this.deps.probeSession({
        base_url,
        session_id: input.session_id,
        auth_token_ref,
      })
      if ('error' in probe) return { ok: false, ...probe }
      this.repo.setDelivery(row.agent_id, {
        kind: 'kimi-server',
        base_url,
        session_id: input.session_id,
        ...(auth_token_ref === undefined ? {} : { auth_token_ref }),
      })
    }
    // Adopting last: a key must not end up on a row whose coordinates the
    // probe just refused.
    if (adopt) this.repo.bindIdentityKey(row.agent_id, input.identity_key)

    return {
      ok: true,
      state: 'committed',
      changed: !idempotent,
      // False means the live session was NOT re-verified this call: the
      // coordinates already matched, so nothing was probed. It does not say
      // the session is alive.
      probed: !idempotent,
      agent_id: row.agent_id,
      name: row.name,
      team: row.team,
      base_url,
      session_id: input.session_id,
    }
  }

  /**
   * The key first, coordinates as the fallback. The fallback is what lets a
   * key reach a row at all: the agent registers itself (and must not carry a
   * key), so the first commit finds the row only by the coordinates it already
   * holds, and adopts the key onto it. Every later commit resolves by key and
   * therefore survives coordinates changing.
   */
  private resolveTarget(
    identity_key: string,
    base_url: string,
    session_id: string,
    device: string
  ):
    | { row: AgentRow; adopt: boolean }
    | { ok: true; need_register: true; state: string; reason: string }
    | { ok: false; error: string; [key: string]: unknown } {
    const keyed = this.repo.findByIdentityKey(identity_key, device)[0]
    if (keyed) {
      const row = this.repo.findById(keyed.agent_id)
      if (row) return { row, adopt: false }
    }
    const candidates = this.repo.findByKimiSession(base_url, session_id, device)
    if (candidates.length === 0) {
      return {
        ok: true,
        need_register: true,
        state: 'unregistered',
        reason: keyed ? 'identity_key_row_missing' : 'identity_key_not_found',
      }
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        error: 'session_claimed_by_other_agent',
        conflicting_agent_id: candidates[1].agent_id,
        name: candidates[1].name,
        team: candidates[1].team,
      }
    }
    const row = this.repo.findById(candidates[0].agent_id)
    if (!row) {
      return {
        ok: true,
        need_register: true,
        state: 'unregistered',
        reason: 'identity_key_not_found',
      }
    }
    return { row, adopt: true }
  }
}
