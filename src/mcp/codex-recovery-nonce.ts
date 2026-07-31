import { randomUUID } from 'node:crypto'

/**
 * One-time tokens that let a re-registering codex say WHICH pane it is.
 *
 * The pre-reg scan's only correlation is "exactly one machine-wide candidate",
 * which fails closed whenever two panes' pre-registration windows overlap — and
 * that blocks the consume step, which is the ONLY way an identity key ever
 * reaches an agent row.  Everything the daemon could ask codex for was measured
 * and found unavailable, so this stops asking and uses a fact the daemon
 * already owns: the recovery poke is sent to ONE KNOWN pane, so a token issued
 * with it identifies that pane on the way back.
 *
 * In-memory on purpose.  A nonce is meaningless once the daemon that issued it
 * is gone (the schedule it belongs to is gone too), and persisting it would
 * outlive the pane state it names.
 */
const paneByNonce = new Map<string, string>()
const nonceByPane = new Map<string, string>()

/**
 * Issue the pane's nonce, replacing any previous one.  A pane has at most one
 * live nonce: a newer recovery generation supersedes the older, and leaving the
 * old one valid would let a stale poke's token select a row the newer
 * generation has already moved past.
 */
export function mintCodexRecoveryNonce(paneId: string): string {
  clearCodexRecoveryNoncesForPane(paneId)
  const nonce = randomUUID()
  paneByNonce.set(nonce, paneId)
  nonceByPane.set(paneId, nonce)
  return nonce
}

/** The pane a nonce names, without spending it. */
export function resolveCodexRecoveryNonce(nonce: string): string | undefined {
  return paneByNonce.get(nonce)
}

/**
 * Spend the nonce.  Single use: a token that stayed valid could re-target a
 * later registration at a pane whose row has already been consumed by someone
 * else.
 */
export function consumeCodexRecoveryNonce(nonce: string): string | undefined {
  const paneId = paneByNonce.get(nonce)
  if (paneId === undefined) return undefined
  paneByNonce.delete(nonce)
  if (nonceByPane.get(paneId) === nonce) nonceByPane.delete(paneId)
  return paneId
}

/** Drop the pane's nonce — its schedule was cancelled, replaced or expired. */
export function clearCodexRecoveryNoncesForPane(paneId: string): void {
  const existing = nonceByPane.get(paneId)
  if (existing === undefined) return
  paneByNonce.delete(existing)
  nonceByPane.delete(paneId)
}

/** Daemon shutdown, and test isolation. */
export function clearAllCodexRecoveryNonces(): void {
  paneByNonce.clear()
  nonceByPane.clear()
}
