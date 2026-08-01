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
// Panes whose current nonce is known to have reached the pane.  Minting
// happens BEFORE the write, so "a nonce exists" and "a notice is sitting in
// the pane" are different facts and the second is the one callers care about.
const deliveredPanes = new Set<string>()

/**
 * Issue the pane's nonce, replacing any previous one.  A pane has at most one
 * live nonce: a newer recovery generation supersedes the older, and leaving the
 * old one valid would let a stale poke's token select a row the newer
 * generation has already moved past.
 *
 * The new nonce starts UNDELIVERED — it is minted so it can be written into
 * the notice, and the write may still fail.
 */
export function mintCodexRecoveryNonce(paneId: string): string {
  clearCodexRecoveryNoncesForPane(paneId)
  const nonce = randomUUID()
  paneByNonce.set(nonce, paneId)
  nonceByPane.set(paneId, nonce)
  return nonce
}

/**
 * Record that THIS nonce reached its pane.  Callers MUST have positive
 * evidence of a write (see `pokeWroteContent`).
 *
 * Keyed on the nonce, never on the pane.  A send is asynchronous, so one that
 * started under an earlier generation can return after the row was overwritten
 * and a new generation minted a replacement token.  Marking "whatever this
 * pane's current nonce is" would then flag the REPLACEMENT — which nothing has
 * written yet — as delivered, and the pane would be held out of every later
 * seeding round on the strength of a notice that does not exist.  A stale
 * nonce is no longer in the store, so it resolves to nothing and this is a
 * no-op, which is exactly the required outcome.
 */
export function markCodexRecoveryNonceDelivered(nonce: string): void {
  const paneId = paneByNonce.get(nonce)
  if (paneId === undefined) return
  if (nonceByPane.get(paneId) !== nonce) return
  deliveredPanes.add(paneId)
}

/**
 * Whether the pane holds a token that could still be quoted back.  Read by the
 * seeding trigger to decide which panes already have one.
 *
 * DELIVERY, not minting, is the test, and the asymmetry is deliberate.  A
 * notice that was never written cannot be quoted back, so treating a minted
 * nonce as held would hold that pane out of every later seeding round — which
 * is exactly the candidate-ambiguity deadlock seeding exists to remove.  The
 * opposite error is far cheaper: mint a second token while the first is really
 * in the pane, and a codex quoting the stale one is simply not recognised, so
 * the scan falls back the way it does with no token at all.  When in doubt,
 * therefore, NOT held.
 */
export function hasDeliveredCodexRecoveryNonce(paneId: string): boolean {
  return deliveredPanes.has(paneId)
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
  if (nonceByPane.get(paneId) === nonce) {
    nonceByPane.delete(paneId)
    deliveredPanes.delete(paneId)
  }
  return paneId
}

/** Drop the pane's nonce — its schedule was cancelled, replaced or expired. */
export function clearCodexRecoveryNoncesForPane(paneId: string): void {
  const existing = nonceByPane.get(paneId)
  if (existing === undefined) return
  paneByNonce.delete(existing)
  nonceByPane.delete(paneId)
  deliveredPanes.delete(paneId)
}

/** Daemon shutdown, and test isolation. */
export function clearAllCodexRecoveryNonces(): void {
  paneByNonce.clear()
  nonceByPane.clear()
  deliveredPanes.clear()
}
