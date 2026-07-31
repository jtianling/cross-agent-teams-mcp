import { planIdentityKeyBinding } from './register-agent.js'
import type { SeatKeyHolder } from '../storage/agents-repo.js'
import { describeRedactedError } from './log-redact.js'
import { isAlive } from '../daemon/pid.js'

export interface SeatFollowDeps {
  findCaller: (agentId: string) => {
    team: string
    name: string
    identity_key: string | null
    codex_thread_id: string | null
  } | undefined
  findKeyHoldersBySeat: (callerAgentId: string) => SeatKeyHolder[]
  applyPlan: (
    plan: { kind: 'bind' } | { kind: 'migrate'; from_agent_id: string },
    callerAgentId: string,
    key: string
  ) => void
  isProcessAlive?: (pid: number) => boolean
  log?: (line: string) => void
}

/**
 * Thread-equality arbitration, for ALIVE holders AND holders whose liveness
 * is UNKNOWN (no positive recorded pid — a verified_tty_pane bind
 * legitimately records none, so a missing pid never proves death): the only
 * proof that the caller IS the holder's running conversation (a same-pane
 * rename) is codex-appserver thread equality.  The thread id arrives on the
 * register_agent call itself and is stored in both rows' delivery payloads;
 * a rename re-registers with exactly the thread the holder row already
 * carries.  The pid the fallback bind records comes from a GLOBAL pane
 * heuristic (detectTmuxPane scoring plus a foreground-carrier probe that
 * only proves "unique foreground codex on that tty") and is never tied to
 * THIS caller, so pid equality must not authorize taking an alive holder's
 * key — an unrelated codex can be handed another agent's pane and pid.
 * Missing thread on either side fails closed.
 */
function planThreadEqualityMigration(
  holder: SeatKeyHolder,
  callerThread: string | null
):
  | { kind: 'migrate'; from_agent_id: string }
  | { refusal: 'thread_missing' | 'thread_mismatch' } {
  if (callerThread === null || holder.codex_thread_id === null) {
    return { refusal: 'thread_missing' }
  }
  if (callerThread !== holder.codex_thread_id) {
    return { refusal: 'thread_mismatch' }
  }
  return { kind: 'migrate', from_agent_id: holder.agent_id }
}

type SeatCaller = NonNullable<ReturnType<SeatFollowDeps['findCaller']>>

/**
 * Positive-pid liveness classification: only a holder with a POSITIVE
 * recorded pid that a fresh liveness check confirms NOT running is DEAD.
 * A pid-less holder is a legitimate LIVE state (verified_tty_pane binds
 * without a pid), so a missing pid means liveness UNKNOWN, never death.
 */
function classifyHolderLiveness(
  holder: SeatKeyHolder,
  deps: SeatFollowDeps
): 'dead' | 'alive' | 'unknown' {
  const alive = deps.isProcessAlive ?? isAlive
  const pid = holder.runtime_ui_pid
  const hasPid = pid !== null && pid > 0
  if (!hasPid) return 'unknown'
  return alive(pid) ? 'alive' : 'dead'
}

/**
 * ALIVE holder, or NO positive recorded pid: a pid-less holder is a
 * legitimate LIVE state (verified_tty_pane binds without a pid), so
 * missing pid means liveness UNKNOWN — same authorization as alive:
 * only codex-appserver thread equality moves the key.
 */
function runThreadAuthorizedFollow(args: {
  holder: SeatKeyHolder
  caller: SeatCaller
  callerAgentId: string
  key: string
  liveness: 'alive' | 'unknown'
  deps: SeatFollowDeps
}): void {
  const { holder, caller, callerAgentId, key, liveness, deps } = args
  const decision = planThreadEqualityMigration(
    holder,
    caller.codex_thread_id
  )
  if ('refusal' in decision) {
    const livenessText =
      liveness === 'alive' ? 'is alive' : 'is liveness_unknown (no pid)'
    deps.log?.(
      `seat-follow conflict (debug): holder ` +
      `(${holder.team}, ${holder.name}) ${livenessText} and ` +
      `${decision.refusal}; key not moved to caller=${callerAgentId}`
    )
    return
  }
  deps.applyPlan(decision, callerAgentId, key)
  deps.log?.(
    `seat-follow migrated: identity key moved to ` +
    `(${caller.team}, ${caller.name}) caller=${callerAgentId}`
  )
}

/**
 * DEAD holder: a POSITIVE recorded pid the fresh classifyHolderLiveness
 * check confirmed NOT running.  Unchanged four-branch migrate semantics.
 * No caller pid is passed — it cannot prove anything for a dead holder,
 * and if the holder flips alive between that check and this plan (which
 * re-checks liveness inside planIdentityKeyBinding), the pid-less plan
 * reads it as a conflict and fails closed.
 */
function runDeadHolderFollow(args: {
  holder: SeatKeyHolder
  caller: SeatCaller
  callerAgentId: string
  key: string
  deps: SeatFollowDeps
}): void {
  const { holder, caller, callerAgentId, key, deps } = args
  const plan = planIdentityKeyBinding({
    holder,
    target: { team: caller.team, name: caller.name },
    isProcessAlive: deps.isProcessAlive,
  })
  if ('error' in plan) {
    deps.log?.(
      `seat-follow conflict (debug): holder ` +
      `(${plan.detail.team}, ${plan.detail.name}) is alive on another ` +
      `process; key not moved to caller=${callerAgentId}`
    )
    return
  }
  deps.applyPlan(plan, callerAgentId, key)
  deps.log?.(
    `seat-follow migrated: identity key moved to ` +
    `(${caller.team}, ${caller.name}) caller=${callerAgentId}`
  )
}

/**
 * SEAT-FOLLOW: after a codex registration's runtime binding settles, an
 * identity_key some OTHER row still holds for the caller's physical seat
 * must follow the seat onto the caller's row.  This covers re-registering
 * the same running pane under a new name: the pre-reg row was consumed at
 * seeding and the app-server env cannot carry the key, so without this hook
 * the key would stay on the abandoned row and recovery would poke the old
 * name.  An ALIVE holder migrates only on codex-appserver thread equality
 * (see planThreadEqualityMigration), and a holder with NO positive recorded
 * pid is liveness-UNKNOWN — treated exactly like an alive holder, never as
 * dead.  Only a holder with a POSITIVE recorded pid that a fresh liveness
 * check confirms NOT running takes the DEAD-holder branch, which keeps the
 * existing four-branch migrate semantics.  Best-effort by contract: every
 * failure is logged with the key value redacted and never reaches the
 * register_agent result.
 */
export function followSeatIdentityKey(args: {
  callerAgentId: string
  deps: SeatFollowDeps
}): void {
  const { callerAgentId, deps } = args
  let key: string | null = null
  try {
    const holders = deps.findKeyHoldersBySeat(callerAgentId)
    if (holders.length !== 1) {
      deps.log?.(
        `seat-follow skip (debug): caller=${callerAgentId} ` +
        `candidates=${holders.length}`
      )
      return
    }
    const holder = holders[0]
    key = holder.identity_key
    const caller = deps.findCaller(callerAgentId)
    if (!caller) return
    if (caller.identity_key !== null) {
      // The caller already carries a key (e.g. the pre-reg seeding attach
      // ran first); a seat-matched key must never overwrite it.
      deps.log?.(
        `seat-follow skip (debug): caller=${callerAgentId} ` +
        `already holds a key; seat key not moved`
      )
      return
    }
    const liveness = classifyHolderLiveness(holder, deps)
    if (liveness !== 'dead') {
      runThreadAuthorizedFollow(
        { holder, caller, callerAgentId, key, liveness, deps }
      )
      return
    }
    runDeadHolderFollow({ holder, caller, callerAgentId, key, deps })
  } catch (error) {
    deps.log?.(
      `seat-follow error: caller=${callerAgentId} ` +
      `error=${describeRedactedError(error, key)}`
    )
  }
}
