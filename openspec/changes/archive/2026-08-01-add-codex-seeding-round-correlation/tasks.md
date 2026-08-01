# Tasks: add-codex-seeding-round-correlation

## 1. Ambiguity trigger

- [x] 1.1 On the pre-register write, count unexpired pending rows; the trigger is >= 2
- [x] 1.2 When it fires, every pending pane without a live token is scheduled — not only the pane that just wrote, because the earlier pane's codex may already be up
- [x] 1.3 A pane with a live recovery schedule keeps it and is not seeded (one live token per pane; recovery carries more).  Widened while implementing: a pane holding an already-DELIVERED token is held too — the recovery generation retires at delivery while its token stays outstanding, so "live schedule" alone would let seeding invalidate a token that is sitting in the pane
- [x] 1.4 Trigger evaluation logs its decision either way — a silent no-op is indistinguishable from a broken trigger, which is how the parent gap survived

## 2. Seeding send path (parallel to recovery, not threaded through it)

- [x] 2.1 New scheduler reusing `detectCodexProcess`, `classifyCodexCarrier`, `mintCodexRecoveryNonce`, `tmuxPoke`; recovery path untouched.  `detectCodexProcess` was private to the recovery module, so it moved to `src/mcp/codex-carrier-detect.ts` behind callback logging seams and both schedulers call it — a second copy would have to be fixed twice, and 5.1 is a known pending fix to exactly that code
- [x] 2.2 Guards carried: generation currency, row-snapshot currency, and the composite carrier confirm re-evaluated at EVERY write checkpoint inside the tmux primitive
- [x] 2.3 Guards deliberately absent and why, in code: `resolveCurrentHolder` and `verifyPaneHost` presuppose a prior identity that the seeding round does not have; the uuid carrier proof answers the same "is this the announced pane" question directly
- [x] 2.4 Notice body asserts no team, no name, no identity key
- [x] 2.5 Shares the per-pane nonce store and per-pane cancellation with recovery, so a pane never holds two live tokens
- [x] 2.6 Row consumed / replaced / expired cancels the seeding schedule and clears its token, same as recovery

## 3. Tests

- [x] 3.1 Two pending rows, no holder for either → both scheduled, each registration consumes its own row, neither refused for candidate count
- [x] 3.2 One pending row → nothing scheduled, nothing written into the pane, existing rule binds
- [x] 3.3 Row A registers before row B lands → nothing scheduled at any point
- [x] 3.4 Pane with a live recovery schedule → not seeded, recovery token intact (both shapes: schedule live before its send, and token live after it)
- [x] 3.5 Unknown token quoted → falls back, never fails.  Already asserted by `tests/register-agent-recovery-nonce.test.ts` ("a stale or invented nonce falls back instead of erroring"); the seeding token is the same store and the same parameter, so a second copy would assert the same code twice
- [x] 3.6 Carrier not foreground at a write checkpoint → nothing written
- [x] 3.7 Notice body contains no team, no name, no key
- [x] 3.8 Fallback-bound agent holds no `identity_key` (the "bind is not a seed" requirement, asserted rather than assumed)
- [x] 3.9 Mutation: removing the >= 2 trigger turns 3.2 red; removing the carrier confirm turns 3.6 red.  Both verified by hand: the first also turns 3.3 red, the second turns only 3.6 red
- [x] 3.10 Found in verify, fixed: "one live token per pane" depends on recovery being evaluated BEFORE seeding at the `tools.ts` call site, and only a comment protected it.  `register-agent-recovery-nonce.test.ts` now pins the order via `invocationCallOrder`.  Mutation verified: swapping the two calls turns four tests in that file red
- [x] 3.11 Found by review (CRITICAL), fixed: the nonce is minted BEFORE the write, so "a nonce exists" and "a notice is in the pane" are different facts.  `paneTokenHolder` read the first, and every terminal no-write path (`tmux_unavailable`, `pane_reassigned`, probe error) retired the generation without clearing the nonce — so a pane that received nothing was held out of every later seeding round, reinstating the deadlock this change removes.  The store now tracks DELIVERED separately; `ownership_lost` counts as delivered (pasted but unexecuted — the text is in the pane), everything else does not.  Recovery marks delivery too, which is what makes the 1.3 widening real rather than incidental.  Two regression tests added; mutation verified: reading minted-instead-of-delivered turns the no-write test red
- [x] 3.12 Found by review round 2 (CRITICAL), fixed: `markCodexRecoveryNonceDelivered` was keyed on the PANE, so a send that outlived its generation could return after a replacement token was minted and flag that replacement — never written — as delivered.  Now keyed on the nonce and a no-op once that nonce has left the store.  Test: an in-flight send released after its row is overwritten and a replacement minted leaves the pane undelivered; mutation verified (reverting to pane-keyed turns it red)
- [x] 3.13 Found by review round 2 (CRITICAL), fixed: `tmux_cmd_failed` thrown from a POST-paste stage (`send_keys`, `capture_after`) also leaves the token in the pane — `poke.ts:211` clears `bufferPending` right after the paste, so those throws carry `detail.stage` and nothing was cleaned up.  Classifying only `ok`/`ownership_lost` as delivered would mint a second token over a real one.  The write-state test now lives in `poke.ts` as `pokeWroteContent`, next to the only code that knows which stages are post-paste; both send paths ask it instead of matching error names.  `pane_dead` deliberately stays negative even post-paste — the pane holding the content is gone.  Tests: post-paste `send_keys` holds, pre-paste `load_buffer` does not; mutation verified

## 4. Regression

- [ ] 4.1 Full unit suite + typecheck.  Typecheck clean; the suite was run as targeted files only (recovery, seeding, pre-reg, auto-bind, register_agent, shutdown, tool-description — 216 tests, all passing).  The full run is deliberately NOT done from this session: this machine hosts dozens of the user's live tmux sessions and parts of the suite shell out to tmux
- [x] 4.2 Recovery-path tests unchanged and passing — the point of the parallel path is that they cannot regress
- [ ] 4.3 Nine pre-reg scenario fixtures re-run, only the targeted cells change.  Needs the `lab/` daemon and a real tmux server; not runnable from this session for the same reason as 4.1

## 5. Known-uncovered (inherited, not introduced here)

- [>] 5.1 The nine fixtures reproduce a manual / resume launch shape, not production's non-interactive `sh -c` + `exec` (`pid === pgid`).  Carried over from the parent change's task 5.3; this change touches the same carrier-selection path, so it inherits the gap rather than closing it.
- [>] 5.2 Real-agent verification that a seeded codex quotes the token back.  The parent verified this for recovery (task 5.5, three of three); seeding needs its own and it is not a unit test.
