# Tasks: surface-prereg-write-destination

## 1. Daemon-side reporting

- [x] 1.1 Success result reports the field names actually received (omitted optionals absent)
- [x] 1.2 Success result reports whether `pane_id` is visible on the daemon's own tmux server.  `defaultPaneVisibleSync` is bare `tmux list-panes -a`, so a private socket's pane is simply absent.  **Supplied only by `runDaemon`** and threaded `ServerOpts` -> `DaemonContext` -> the service (revised after review W2 — it was originally defaulted on in `tools.ts`, which made every in-process server probe the host's tmux).  Unset reports unknown, so no unit test can reach the machine's tmux by accident
- [x] 1.3 Visibility probe failure reports "unknown", never blocks and never throws — the write path must not acquire a new way to fail
- [x] 1.4 Reported, never enforced: no code path refuses on visibility.  The probe runs AFTER the upsert and the onAccepted hook, in the return expression

## 2. CLI-side reporting

- [x] 2.1 `runPreRegisterCodexPane` prints the resolved `host:port` alongside the daemon's response
- [x] 2.2 No token, no token length, no token hash in any output (handover 6.1: one leak already exists, do not add a second)
- [x] 2.3 The error paths report the endpoint too — a connection refused against the wrong endpoint is the same diagnosis problem

## 3. Tests

- [x] 3.1 Received-field echo: all three fields present; optional omitted → absent
- [x] 3.2 Invisible pane → row still written, flag reports not visible
- [x] 3.3 Probe throwing → result reports unknown, call still succeeds
- [x] 3.4 CLI output contains host:port and no token material
- [x] 3.5 Mutation: making visibility enforce (refuse) turns 3.2 red.  Verified by hand — an early `if (pane_visible === false) return pane_claimed` turned exactly that one test red and left the other 27 in the file green; restored immediately

## 4. The withdrawn predicate change

- [x] 4.1 A test asserts the EXISTING behaviour: an unexpired row for a pane whose codex has not started yet still blocks the fallback bind.  This is the case the withdrawn narrowing would have broken, and nothing currently asserts it directly.
- [x] 4.2 Mutation: narrowing the predicate to require the uuid on the carrier turns 4.1 red.  Verified by hand — `paneHasPendingPreReg` extended with `&& defaultCarrierAlive(paneId, pending.xats_agent_id)` turned 4.1 red on its "the bind was never reached" assertion; it also turns LAB S1 and both DURING-verification shapes red, so the narrowing is not merely untested-but-safe.  The test seeds a bind that would SUCCEED if reached, so the mutation fails on the pane assertion rather than on an unrelated crash

## 4b. Review findings (round 1, PASS_WITH_WARNINGS — fixed rather than recorded)

- [x] 4b.1 W1 `src/cli.ts` — the `invalid_ttl` exit dropped the endpoint while the comment above it claimed every outcome carried one.  Every exit past endpoint resolution now goes through one `succeed`/`fail` pair, so the claim stays true as branches are added.  Regression test added; a second test covers the daemon-refusal branch (S1)
- [x] 4b.2 W2 — the visibility probe defaulted ON in `tools.ts`, so every test that builds a server in-process shelled out to bare `tmux list-panes -a` against the operator's real tmux server on each successful pre-registration.  Default inverted: `paneVisibleProbe` now travels `ServerOpts` → `DaemonContext` → the service, and is supplied ONLY by `runDaemon`.  Unset means `'unknown'`, which the service already meant.  The CLI test now asserts `'unknown'` instead of accepting whatever the machine had
- [x] 4b.3 S2 — `PreRegisterCodexPaneService` took six positional parameters and reaching the last meant passing an explicit `undefined` past a defaulted probe.  Now a named options object; that is also what made 4b.2's seam clean

## 5. Regression

- [~] 5.1 `npm run typecheck` clean.  Final run after the review fixes: 12 files — the 4 touched (`pre-register-codex-pane-service`, `register-agent-codex-pre-reg`, `pre-register-cli-endpoint-report`, `pre-register-cli-identity-key`) plus every other file exercising the pre-reg path (`register-agent-collapse-self-tools`, `register-agent-prereg-overwrite-race`, `pre-register-recovery-wiring`, `register-agent-recovery-nonce`, `codex-bind-is-not-a-seed`, `codex-seeding-poke`, `codex-recovery-poke`, `auto-bind-codex-pane`) — **155 tests, all green**.  The FULL suite was deliberately not run here: this machine hosts the operator's live tmux sessions
- [x] 5.2 No behavioural change to binding, scanning, or refusal — diff review, not just green tests.  `refuseReason`, the upsert, `deleteExpired`, the hook order and `paneHasPendingPreReg` are byte-identical.  Beyond the two report fields and the CLI endpoint field, the review round added: the `paneVisibleProbe` seam through `ServerOpts`/`DaemonContext`, the service's positional-to-named constructor, and the CLI's single `succeed`/`fail` exit pair.  None of the three changes what the daemon decides — they change who supplies a probe, how it is passed, and where output is formatted

## 6. Left open (recorded)

- [>] 6.1 Cross-server `pane_id` collision.  Needs socket + server generation as a scope key; revisit criterion is an OBSERVED foreign overwrite of a legitimate row during the pre-`exec` window.
- [>] 6.2 Fixture isolation (`CROSS_AGENT_TEAMS_MCP_HOME` unset in the e2e lab) is the actual cause of lab-writes-production and belongs to the fixture owner.  This change only makes it visible.
