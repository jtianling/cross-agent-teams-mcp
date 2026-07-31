# agent-registry Delta

## ADDED Requirements

### Requirement: codex_pane_pre_registrations table includes identity_key column

The `codex_pane_pre_registrations` table SHALL include a nullable `identity_key` TEXT column, stored separately from `xats_agent_id` (the two values MUST NOT be merged or derived from each other).  Startup migration SHALL add the column idempotently; existing rows keep `identity_key = NULL`.  The identity key MUST NOT appear on any process command line (argv): it is delivered via the launcher-exported environment variable read by the `pre-register-codex-pane` CLI process itself, and from there travels only over the authenticated HTTP channel to the daemon.

#### Scenario: Migration adds the column idempotently
- **WHEN** the daemon starts against a database created before this change
- **THEN** the `identity_key` column is added to `codex_pane_pre_registrations`
- **AND** a second daemon start does not fail or duplicate the column

#### Scenario: Rows without identity_key behave as before
- **WHEN** a pre-reg row is written without `identity_key`
- **THEN** the stored row has `identity_key = NULL`
- **AND** every existing pre-reg / auto-bind path behaves exactly as before this change

### Requirement: Auto-bind attaches stored identity_key via the four-branch rule

When `register_agent` auto-bind consumes a pre-reg row that carries an `identity_key`, the daemon SHALL attach that key to the caller's agent row using the existing `planIdentityKeyBinding` four-branch rule (unbound leads to bind; same row is idempotent; held by a row whose process is dead migrates with the old row's key cleared).  A pending row whose key belongs to ANOTHER identity SHALL be excluded from the candidate set entirely — either because its `identity_key` DIFFERS from a non-null key the caller's row already holds, or because the key's holder is a DIFFERENT `(team, name)` that is not provably gone (which also covers a KEYLESS caller reaching another identity's row).  Such a row SHALL be excluded — not bound, not consumed, no key attached — and logged at debug level with the pane id and the distinguishing reason (`identity_key_contradiction` or `identity_key_live_holder_conflict`; never key values); the row remains pending for its rightful owner, and a registration left with no candidate takes the existing fail-closed path (no bind from this scan, `detect_tmux_pane` fallback as before).  The scan's only other correlation is "unique machine-wide candidate whose pane tty hosts a codex carrying the stored uuid", which proves the PANE's codex identity and never the CALLER's, so a positive key contradiction is the only available evidence that the row belongs to another identity: skipping just the attach while still binding the pane and consuming the row would strand the rightful owner unbound and keyless and point the caller's seat at a foreign pane.  Candidacy SHALL NOT be decided by `planIdentityKeyBinding`: that rule arbitrates a key AFTER the caller has proven pane ownership and therefore excludes conflicts against the caller's OWN `ui_pid`, while the scan has no caller pid at all — passing the CANDIDATE PANE's carrier pid makes the arbitration self-exclude precisely when the live foreign holder IS that pane's foreground codex (holder pid == candidate pid).  Candidacy SHALL instead take positive proof only: another identity's key is foreign unless that identity is provably gone (a positive recorded pid that is NOT running).  A holder of ANOTHER `(team, name)` whose row records NO positive `runtime_ui_pid` is liveness UNKNOWN, never dead — a tty/pane bind legitimately records no pid — so such a row SHALL also be excluded from candidacy (reason `identity_key_holder_liveness_unknown`), even though the post-consumption attach may still migrate that key once pane ownership has been proven.  A row carrying NO key contradicts nothing and stays consumable; a caller holding no key, or holding the same key, is unaffected.

The candidacy decision is taken BEFORE the runtime bind's asynchronous verification, so the rightful owner can acquire the key inside that window.  The daemon SHALL therefore split that bind into an ASYNCHRONOUS verification that persists nothing and a SYNCHRONOUS commit, and the commit SHALL run the claim re-arbitration, the runtime write, the conditional row consumption and the key attach inside ONE transaction.  Compensating afterwards is NOT sufficient: the runtime write evicts any incumbent agent holding the same pane (last-writer-wins), and clearing the caller's row afterwards cannot restore that eviction — the rightful owner would be left with its pane binding destroyed.  Any refusal (re-arbitration says foreign, stale generation) or any thrown error inside the commit SHALL therefore roll the whole transaction back, leaving NO runtime write, NO incumbent eviction, NO consumed row and NO attached key, and the outcome SHALL be logged (pane id, reason or redacted error, and a `post_verify` stage marker for the re-arbitration refusal).  A failing key attach SHALL take the row consumption down with it — a consumed row whose key was never attached destroys the recovery handle permanently.

The `detect_tmux_pane` fallback SHALL NOT bind a pane that still carries an UNEXPIRED pre-reg row, and that check SHALL be evaluated inside the SAME synchronous commit as the fallback's runtime write (both the pid-carrier shape and the tty/pane shape), because every fallback shape still awaits probes after any earlier check: a launcher announcing that pane inside the await window would otherwise be overruled by a bind with no caller correlation whatsoever.  A pending row means some launcher announced that pane for a codex that has not registered yet; had the caller been that codex, the scan above would have consumed the row under the uuid plus foreground-carrier proof.  Since the fallback scores panes machine-wide with NO caller correlation whatsoever, letting it bind such a pane re-creates by heuristic exactly the claim the scan just refused by evidence.  The refusal SHALL be logged at debug level (pane id, `pane_has_pending_prereg`, caller id) and the registration SHALL take the existing fail-closed path.  When a row IS consumed, the daemon SHALL NOT overwrite a different key on the caller's row: the attach step re-reads the caller row inside the commit and REFUSES on any of caller row missing, caller holding a different key, or the planner reporting a live foreign holder.  Every such refusal SHALL roll the whole transaction back — returning "attached nothing" while reporting success would commit the exact state this requirement forbids: incumbent evicted, recovery row consumed, key attached nowhere, and that row is the key's only carrier.  The refusal reason SHALL be logged (never key values).  Row consumption SHALL be conditional on the full row snapshot auto-bind matched (`pane_id`, `xats_agent_id`, `identity_key`, `expires_at`): auto-bind SHALL re-read and compare the row immediately before binding, and consume via a conditional delete on the full snapshot after binding; when the row was overwritten mid-flight, the daemon SHALL NOT delete the new row, SHALL NOT attach any key to the caller, SHALL NOT cancel the new row's recovery schedule, SHALL NOT run the seat-follow hook (a stale outcome must not move any seat-held key onto the caller, bypassing the full-snapshot consume protection), and SHALL log a structured warning (pane id and reason, never the key value) while the already-persisted pane binding remains.  Any failure in the attach step SHALL obey the existing "auto-bind failure does not corrupt register_agent result" requirement.

#### Scenario: Recovery registration attaches the key to the recovered row
- **GIVEN** a pre-reg row for pane `%1972` with `xats_agent_id="U1"` and
  `identity_key="K1"`, where `K1` was previously bound to agent row `aoe-codex(aoe)`
  whose runtime process is dead
- **WHEN** codex calls `register_agent({agent_type:"codex", name:"aoe-codex",
  team:"aoe", thread_id:"t-new"})` and auto-bind matches pane `%1972`
- **THEN** the `(device, team, name)` upsert reuses the `aoe-codex(aoe)` row
- **AND** the row keeps (idempotently re-binds) `identity_key="K1"`
- **AND** the pre-reg row is consumed

#### Scenario: First launch binds the key to a fresh row
- **GIVEN** a pre-reg row with `identity_key="K9"` where `K9` matches no agent row
- **WHEN** codex registers and auto-bind consumes the row
- **THEN** the caller's agent row now holds `identity_key="K9"`
- **AND** a later pane restart can recover this identity via `K9`

#### Scenario: A contradicting key disqualifies the row (foreign-row incident shape)
- **GIVEN** a pre-reg row for pane `%71` carrying `identity_key="K2"`, whose tty hosts a foreground codex with that row's stored uuid (another identity's pane)
- **AND** the registering caller's `(device, team, name)` row already holds `identity_key="K1"` with `K1 != K2`, has NO same-thread evidence, and its own pre-reg row has expired
- **WHEN** the caller's registration reaches the pre-reg scan
- **THEN** the `%71` row is excluded from the candidate set: no bind, no consumption, no key attach, and the exclusion is logged at debug level with the pane id and the contradiction reason (never key values)
- **AND** the `%71` row is still pending with `identity_key="K2"`, so its rightful owner can consume it and receive `K2`
- **AND** the caller's registration takes the existing fail-closed path and the `register_agent` envelope is not turned into an error

#### Scenario: A contradicting row is filtered, leaving the caller's own row unique
- **GIVEN** two pending rows — `%10` carrying the caller's own `identity_key="K1"` and `%11` carrying `identity_key="K2"` — whose ttys each host a foreground codex matching their stored uuid
- **WHEN** a caller holding `identity_key="K1"` registers with no same-thread evidence
- **THEN** the `%11` row is excluded by contradiction, `%10` is the unique candidate and is bound and consumed
- **AND** without the exclusion both rows would qualify and the "exactly one candidate" rule would bind nothing

#### Scenario: A holder whose pid equals the candidate pane's carrier is still foreign
- **GIVEN** a pending row carrying `identity_key="K1"` whose live holder is a DIFFERENT `(team, name)` whose `runtime_ui_pid` EQUALS the candidate pane's foreground carrier pid, and a caller holding no key
- **WHEN** the caller's registration reaches the pre-reg scan
- **THEN** the row is excluded as foreign — the candidate pid identifies that pane's codex, never the caller, so it may not authorise a cross-identity migration
- **AND** no bind is attempted, the row is still pending, and no key moves

#### Scenario: A holder appearing during verification never lands a bind at all
- **GIVEN** a pending row carrying `identity_key="K1"` with no holder at candidacy time, and another agent already bound to that same pane
- **WHEN** the rightful owner acquires `K1` while the caller's runtime identity is still being verified
- **THEN** the commit's re-arbitration finds the row foreign and the transaction rolls back: no runtime write happens, so the incumbent agent KEEPS its pane binding, the row is not consumed and no key is attached
- **AND** the refusal is logged with the pane id, the reason and the `post_verify` stage marker

#### Scenario: A failing key attach rolls the consumption back
- **GIVEN** a pending row carrying an `identity_key` whose attach step throws
- **WHEN** auto-bind commits the claimed pane
- **THEN** the transaction rolls back: the row is STILL pending with its key, no runtime binding was written, and the rolled-back commit is logged with the error redacted of key values
- **AND** the row remains recoverable by its rightful owner (a consumed row with no attached key would destroy the recovery handle permanently)

#### Scenario: The detect fallback does not bind a pane with a pending pre-reg row
- **GIVEN** a pending pre-reg row for pane `%1972` announced by another identity's launcher, and a codex registration whose pre-reg scan found no candidate at all
- **AND** `detect_tmux_pane` would score `%1972` as the machine-wide best pane
- **WHEN** the registration reaches the fallback bind
- **THEN** no bind is attempted, the refusal is logged with the pane id and `pane_has_pending_prereg`, and the pre-reg row is still pending
- **AND** `register_agent` succeeds unbound via the standard no-pane-hint path

#### Scenario: A pid-less holder of another identity is liveness-unknown, not dead
- **GIVEN** a pending row carrying `identity_key="K1"` whose holder is a DIFFERENT `(team, name)` row with `runtime_ui_pid = NULL`, and a caller holding no key
- **WHEN** the caller's registration reaches the pre-reg scan and the pane probes as a valid carrier
- **THEN** the row is excluded with the `identity_key_holder_liveness_unknown` reason: no bind, no consumption, no key attach
- **AND** the row is still pending with `identity_key="K1"`

#### Scenario: A keyless caller cannot claim a row keyed to a live other identity
- **GIVEN** a pending row carrying `identity_key="K1"` whose holder is a DIFFERENT `(team, name)` with a live runtime process, and a caller whose own row holds no key
- **WHEN** the caller's registration reaches the pre-reg scan and the row's pane probes as a valid carrier
- **THEN** the four-branch arbitration returns `identity_key_conflict`, so the row is excluded: no bind, no consumption, no key attach, logged with the live-holder reason
- **AND** the row is still pending with `identity_key="K1"` for its rightful owner

#### Scenario: A keyless row contradicts nothing
- **GIVEN** a pending row carrying NO `identity_key`, and a caller whose row already holds `identity_key="K1"`
- **WHEN** auto-bind matches that row
- **THEN** the row is bound and consumed exactly as before this change (no contradiction evidence exists, so no exclusion applies)

#### Scenario: Overwrite during bind is not consumed or attached
- **GIVEN** auto-bind matched a pre-reg row for pane `%1972` with `identity_key="K1"`
- **WHEN** a new `pre_register_codex_pane` call overwrites the row (new uuid and `identity_key="K2"`) while the pane bind is in flight
- **THEN** the new row is NOT deleted
- **AND** the caller row does NOT receive `K2`
- **AND** the new row's recovery schedule is NOT cancelled
- **AND** seat-follow does NOT run: every agent row's `identity_key` is exactly what it was before the registration (the old `K1` holder keeps `K1`, the caller row holds nothing)
- **AND** a structured warning naming the pane (never a key value) is logged

### Requirement: Same-seat codex re-registration migrates the identity key

Before the `detect_tmux_pane` fallback bind persists for a codex caller, the daemon SHALL probe the detected pane's tty with the same foreground-carrier primitives as codex auto-bind (`ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=`, STAT free of `T`/`t`/`Z`, `pgid == tpgid`, wrapper+child collapse to the process-group leader; no stored uuid exists on this path, so the codex `--remote` command-level match suffices).  When exactly one foreground carrier is found, the daemon SHALL include its pid in the runtime bind so the caller's row records a REAL `runtime_ui_pid` (`verified_pid_tty_pane`, used by liveness checks and poke carrier confirms); when no unique foreground carrier is found (probe failure included), the fallback SHALL bind tty/pane only and the caller stays pid-less.  When a carrier pid was found but its pid bind fails (for example `pid_not_found` or `pid_pane_tty_mismatch`), the daemon SHALL NOT degrade to a tty-only bind: exactly one bind attempt is made, no seat-follow hook runs, and no identity key moves.

After a codex registration's runtime binding settles (on the pre-reg auto-bind path AND on the `detect_tmux_pane` fallback path), when exactly ONE other agent row on the same device still holds an `identity_key` and its surviving runtime binding (`runtime_ui_pid`, or `runtime_tty` — the old row's `tmux_pane_id` is already cleared by the last-writer-wins pane rebind) places it on the caller's newly bound seat, the daemon SHALL arbitrate that row (holder) against the caller as follows.  The holder's liveness SHALL be classified from its recorded `runtime_ui_pid`: a POSITIVE recorded pid that a fresh liveness re-check at arbitration time confirms running means ALIVE; a positive recorded pid the re-check confirms NOT running means DEAD; NO recorded pid (or a non-positive value) means liveness UNKNOWN — a pid-less holder is a legitimate live state (a `verified_tty_pane` bind records no pid), so a missing pid MUST NOT be read as dead.  A holder that is ALIVE — and equally a holder whose liveness is UNKNOWN, which SHALL be treated exactly like an alive holder — migrates ONLY when the caller row's codex-appserver `thread_id` equals the holder row's codex-appserver `thread_id`: the thread id arrives on the `register_agent` call itself and is stored in both rows' delivery payloads, and a same-conversation rename re-registers with exactly the thread the holder row already carries — a verifiable caller-to-process association.  Pid and tty values are NEVER sufficient authorization against an alive or liveness-unknown holder: the pid the fallback bind records comes from a pane-scoped foreground-carrier heuristic (`detect_tmux_pane` scores ALL panes; the probe only proves "unique foreground codex on that tty") that is not tied to the registering caller, so an unrelated codex can be handed another agent's pane and pid — pid equality MUST NOT move the key, and seat (tty) equality is NOT same-process proof.  A missing codex-appserver `thread_id` on either row, or a thread mismatch, SHALL fail closed: no key moves and the refusal is logged at debug level with holder identity and reason only (`thread_missing` / `thread_mismatch`, plus `liveness_unknown` when the holder has no recorded pid; never the key value).  ONLY a holder classified DEAD — a positive recorded pid re-checked as not running — takes the dead-holder branch, which keeps the existing `planIdentityKeyBinding` four-branch migrate semantics: the key migrates with the old row's key cleared in the same transaction as the caller's bind (same-seat restart without a pre-reg row).  The daemon SHALL do nothing when the caller's row already holds a key (the seeding attach ran first) or when zero or multiple candidate holders match (debug log with the candidate count only), and SHALL catch any failure with a redacted structured log (never the key value) so the `register_agent` result is never corrupted.

#### Scenario: Renaming the same running conversation migrates the key
- **GIVEN** a codex pane registered as `X(aoe)` whose row holds `identity_key="K1"`, a codex-appserver delivery with `thread_id="T"`, and the seat bound (pane, tty, and the still-running codex pid)
- **WHEN** the SAME conversation re-registers as `register_agent({agent_type:"codex", name:"Y", team:"aoe", thread_id:"T"})` and the fallback bind settles on that seat (with or without a recorded carrier pid)
- **THEN** the caller row's thread equals the holder row's thread, and the `Y(aoe)` row now holds `identity_key="K1"`
- **AND** the `X(aoe)` row has `identity_key = NULL` (cleared in the same transaction as the caller's bind)
- **AND** a later pane restart resolves `K1` to `Y(aoe)`, so the recovery poke names `Y`, never `X`

#### Scenario: An unrelated codex never takes an alive holder's key, even handed its pane and pid
- **GIVEN** row `X` holds `identity_key="K1"` with an ALIVE `runtime_ui_pid` and codex-appserver `thread_id="T-X"`
- **WHEN** an UNRELATED codex registers with `thread_id="T-Y"` and the global pane heuristic plus the carrier probe hand the caller `X`'s pane and `X`'s very pid
- **THEN** every agent row's `identity_key` is exactly what it was before the registration (`X` keeps `K1`, the caller row holds nothing)
- **AND** the refusal is logged at debug level with holder identity and reason only (never the key value)
- **AND** the `register_agent` envelope is unchanged

#### Scenario: A missing thread on either side fails closed against an alive holder
- **GIVEN** row `X` holds `identity_key="K1"` with an ALIVE `runtime_ui_pid` on the caller's seat, and the caller row or the holder row carries no codex-appserver `thread_id`
- **WHEN** the caller's codex registration binds its seat
- **THEN** `K1` stays on `X`
- **AND** the refusal is logged at debug level (never the key value)
- **AND** the `register_agent` envelope is unchanged

#### Scenario: A pid-less holder is liveness-unknown and a different thread never takes its key
- **GIVEN** row `X` holds `identity_key="K1"` with `runtime_ui_pid = NULL` (its seat was bound `verified_tty_pane`, a legitimate live state) and codex-appserver `thread_id="T-X"`, its `runtime_tty` on the caller's seat
- **WHEN** an UNRELATED codex registers with `thread_id="T-Y"` and its fallback bind settles on that seat
- **THEN** every agent row's `identity_key` is exactly what it was before the registration (`X` keeps `K1`, the caller row holds nothing)
- **AND** the refusal is logged at debug level with `liveness_unknown` and the thread reason (never the key value)

#### Scenario: A pid-less holder migrates on codex thread equality
- **GIVEN** row `X(aoe)` holds `identity_key="K1"` with `runtime_ui_pid = NULL`, its `runtime_tty` recorded, and codex-appserver `thread_id="T"`
- **WHEN** the SAME conversation re-registers as `Y(aoe)` with `thread_id="T"` and the fallback bind settles on that seat
- **THEN** the `Y(aoe)` row now holds `identity_key="K1"`
- **AND** the `X(aoe)` row is keyless

#### Scenario: Dead holder on the same seat migrates without a pre-reg row
- **GIVEN** row `X(aoe)` holds `identity_key="K1"` with a POSITIVE recorded `runtime_ui_pid` whose process a fresh liveness re-check confirms NOT running, and the seat's tty recorded
- **WHEN** a new codex process on the same seat registers as `Y(aoe)` with no pending pre-reg row
- **THEN** `K1` migrates to the `Y(aoe)` row
- **AND** the `X(aoe)` row is keyless

#### Scenario: A failed carrier-pid bind never degrades to a tty fallback
- **GIVEN** the fallback carrier probe returned a pid for the detected pane's tty
- **WHEN** the pid bind fails (`pid_not_found` or `pid_pane_tty_mismatch`)
- **THEN** the daemon makes exactly one bind attempt and does NOT fall back to a tty-only bind
- **AND** the seat-follow hook does not run and no identity key moves

#### Scenario: Seeding attach stays idempotent
- **GIVEN** a registration whose pre-reg auto-bind already attached `identity_key="K1"` to the caller's row
- **WHEN** the seat-follow step runs after the bind
- **THEN** the caller's row still holds `K1`
- **AND** no other row loses or gains a key

#### Scenario: Zero or multiple seat candidates change nothing
- **WHEN** the seat-follow lookup finds zero, or more than one, other key-holding rows matching the caller's seat
- **THEN** no key moves
- **AND** a debug line records only the candidate count (never key values)

### Requirement: Register-time runtime binds are conditional on the registration generation

The `agents` table SHALL include a `register_generation` INTEGER NOT NULL DEFAULT 0 column, added by an idempotent startup migration (existing rows keep `0`).  Every register upsert SHALL increment the row's `register_generation` inside the SAME transaction as the upsert, and every successful register result SHALL carry the minted generation internally through the service layers to the MCP tool layer, which SHALL strip it (together with `prior_snapshot`) from every client-facing envelope.

The CAS check on the caller's own row (see the pre-upsert capture requirement below) closes the PROBE window, but not the BIND window: after the CAS passes, every register-time runtime bind still awaits an asynchronous runtime verification (pid/tty/pane probes) before its final persist, and a same-`(device, team, name)` registration reuses the same `agent_id` — so a registration A suspended in bind verification while a newer registration B persists its own thread and seat would, with an unconditional final write, stomp the row into a cross-session hybrid (B's thread with A's seat).  The takeover transport close issued for A's connection does NOT cancel A's already-running handler, so the late write must be stopped at the persist itself.

Every REGISTER-TIME runtime bind — the explicit `ui_pid` bind, the same-thread seat inherit, the pre-reg auto-bind consumption bind, and the `detect_tmux_pane` fallback bind — SHALL therefore pass the generation its OWN registration minted down to the runtime-binding persist, whose UPDATE SHALL be conditional: `WHERE agent_id = ? AND register_generation = ?`.  When the conditional UPDATE changes ZERO rows (a newer registration re-minted the generation during the verification await), the bind SHALL fail closed for that registration: no runtime fields are written, the incumbent-pane eviction is skipped, no seat-follow hook runs for that registration, and the failure is logged with a distinct reason (`stale_registration_bind`; agent ids and counts only, never key values).  `register_agent` itself still succeeds via the standard path.  A register result that reaches the runtime auto-bind WITHOUT the minted generation, or with a generation that is not a POSITIVE SAFE INTEGER (NaN/Infinity/negatives/decimals make every conditional write silently change zero rows), SHALL fail the runtime auto-bind closed with an invariant-error log line — the conditional final writes must never silently degrade into unconditional or no-op ones.  The register-time bind entry points SHALL require the generation at the type level (no optional parameter a future register-time caller could omit), and the shared runtime-binding service SHALL make the generation mode an EXPLICIT discriminated choice — a caller must pass either the minted generation or an explicit capture-at-call-start marker (`captureCurrentGeneration: true`); no caller can fall into the capture semantics by mere omission.  When the runtime auto-bind failed closed on an invalid-generation invariant AFTER a CAS drift, the register response SHALL carry a DEDICATED invariant hint stating that a residual pane binding may remain — never the standard "no usable tmux_pane_id is bound yet" hint, which would falsely claim the row is pane-free while the raced session's seat may still be attached.  The user-invoked `bind_runtime_identity` MCP tool is NOT a register-time bind and has no minted generation of its own; its final write SHALL instead be conditioned on the caller row's CURRENT `register_generation` captured at call start: registrations that completed BEFORE the call never block an explicit repair rebind, while a same-identity registration landing DURING the bind's verification await changes zero rows and fails the call closed with the same `stale_registration_bind` reason.

#### Scenario: A bind suspended in verification never stomps a newer same-name registration
- **GIVEN** registration A (same name, thread `T`) passed the CAS check, resolved its inherited seat `S1`, and is suspended in the bind verification await
- **WHEN** registration B completes for the same `(device, team, name)` with thread `U` and binds its own seat `S2`, and A's verification then resolves successfully
- **THEN** A's final write carries a stale `register_generation` and changes ZERO rows: the row keeps B's thread `U` AND B's seat `S2`
- **AND** A performed no runtime write and no seat-follow, and A's outcome is logged with the `stale_registration_bind` reason (never key values)
- **AND** A's `register_agent` still succeeded

#### Scenario: A stale-generation runtime write changes zero rows at the repository level
- **GIVEN** an agent row whose `register_generation` a newer registration has already incremented
- **WHEN** a runtime-binding persist runs with the older expected generation
- **THEN** zero rows change, the row's runtime fields are untouched, and no other row's pane binding is evicted

#### Scenario: The generation column migration is idempotent
- **WHEN** the daemon starts against a database created before this change
- **THEN** the `register_generation` column is added with existing rows at `0`
- **AND** a second daemon start does not fail or duplicate the column

#### Scenario: Pre-call registrations never block an explicit repair rebind
- **GIVEN** an agent row re-registered several times BEFORE the caller invokes the `bind_runtime_identity` MCP tool
- **WHEN** the caller invokes the tool and its verification resolves with no further registration in between
- **THEN** the verified binding persists — the call-start generation capture reflects the row's current generation, so history alone never blocks a repair

#### Scenario: A manual bind suspended in verification never stomps a newer registration
- **GIVEN** a caller invoked the `bind_runtime_identity` MCP tool and its bind is suspended in the verification await
- **WHEN** a same-identity registration B completes during the await and binds its own seat `S2`
- **THEN** the manual bind's conditional final write changes ZERO rows: the row keeps B's seat `S2`
- **AND** the call fails closed with `stale_registration_bind` and the outcome is logged (agent ids and counts only)

## MODIFIED Requirements

### Requirement: register_agent auto-binds codex pane via pending pre-reg

BEFORE any pre-reg scan, the daemon SHALL resolve SAME-THREAD SESSION EVIDENCE for the codex registration: agent rows on the same device whose codex-appserver `thread_id` equals the registering thread AND that still carry a bound runtime (`runtime_ui_pid` and/or `runtime_tty`).  The caller's own `(device, team, name)` upsert-reused row counts as evidence exactly when its PRE-UPSERT stored codex-appserver thread equals the effective registering thread — the upsert preserves the row's bound runtime but OVERWRITES its stored thread, so the daemon SHALL capture the pre-upsert thread before the register write; a same-name registration arriving with a NEW thread (restart recovery) contributes no evidence.  Once ANY same-thread evidence exists, the daemon SHALL NEVER scan foreign pre-reg rows and SHALL NEVER run unrestricted global pane detection (`detect_tmux_pane`) for this registration: the only correlation either has is "unique machine-wide candidate", which is no caller association at all, so reaching them can hand the caller an UNRELATED launcher's pending pane, pid, and seat key, or bind a foreign pane (runtime identity corruption).  The evidence rows SHALL be collapsed by PHYSICAL seat: rows sharing a positive `runtime_ui_pid` and/or a `runtime_tty` are ONE seat (a rename chain A→B→C leaves every abandoned row with its pid/tty intact — only the pane is cleared by the last-writer-wins rebind, so multiple same-thread rows are the NATURAL state, not an anomaly), and each seat folds to its last-writer-wins owner (latest `runtime_bound_at`; a still-set pane breaks ties).  A unique physical seat SHALL be inherited EXACTLY: an owner with a positive pid runs the existing `bind_runtime_identity(agent:"codex", ui_pid:<that pid>)` path (which re-verifies pid → tty → pane live); an owner without a positive pid but with a recorded tty AND pane binds EXACTLY that tty/pane via the existing tty/pane bind shape, with no detection substituting another seat.  Multiple DISTINCT physical seats, a failed inherit bind, or a seat with no bindable runtime info SHALL fail closed: no pre-reg scan, no global detection, no runtime bind — `register_agent` still succeeds and takes the standard no-pane-hint path.  After a successful inherit the existing seat-follow hook runs as usual: with the inherited seat it finds the key-holding row and thread equality migrates the key.  ONLY a registration with NO same-thread evidence (a genuinely new thread, e.g. post-restart recovery) proceeds to the pre-reg scan below and, failing that, to the `detect_tmux_pane` fallback.

The pre-upsert capture alone is NOT trustworthy: the codex register path awaits an asynchronous app-server probe between the capture and the register write, and a concurrent same-`(device, team, name)` registration can rewrite the row inside that window (making the capture stale in either direction — filtering out genuine caller-row evidence, or blessing another session's freshly-written seat as the caller's own).  The write transaction that persists the registration SHALL therefore atomically return the row's ACTUAL prior state — the prior stored codex-appserver thread plus the prior physical-seat fields (`runtime_ui_pid`, `runtime_tty`, `tmux_pane_id`, `runtime_bound_at`) — read inside the SAME transaction as the upsert.  The daemon SHALL compare (CAS) the pre-probe capture against this transaction-returned prior state: when they DIFFER, the row changed during the probe window and the runtime auto-bind for this registration SHALL fail closed — no caller-row evidence, no pre-reg scan, no global pane detection, no runtime bind; `register_agent` still succeeds unbound via the standard path.  "Unbound" SHALL be the row's ACTUAL end state, not merely the absence of a new bind: the register upsert COALESCE-preserves the raced row's seat fields, so leaving them would produce "this registration's thread + the raced session's seat" — a hybrid the tmux poke fallback would misdeliver to.  The drift registration SHALL therefore clear every runtime-seat field (`tmux_pane_id`, `runtime_ui_pid`, `runtime_tty`, `runtime_verification_mode`, `runtime_bound_at`) with an UPDATE conditional on its OWN minted `register_generation`; when an even newer registration has already advanced the generation, the clear changes ZERO rows and that registration's freshly bound seat is untouched.  The clear outcome (changes count) SHALL be logged at debug level alongside the CAS-drift decision; when no valid minted generation exists the clear SHALL be skipped AND logged as skipped — the daemon must never silently claim the unbound end state was reached.  The prior state is the CAS input and SHALL be a REQUIRED field of every internal register success result (null only as the legitimate no-prior value for a fresh row): a codex register result MISSING the field entirely would fake a CAS match against a null pre-upsert capture, so the daemon SHALL treat the missing field as CAS drift with an invariant-error log line.  When they MATCH, the transaction-returned prior thread (not the early capture) SHALL be the caller-row evidence input.  Evidence rows for OTHER same-thread rows are read after the write — they are not the raced row; the CAS concerns only the caller's own row.  The same-thread resolution SHALL log EVERY decision (no evidence / unique-seat inherit success / unique-seat inherit failure / ambiguous seats / CAS drift) at debug level through one decision point, each with the evidence row count, seat count, and involved agent ids — never key values; the CAS-drift fail-closed outcome carries its own distinct reason.

When `register_agent` is called with `agent_type="codex"`, no `ui_pid`, no `tmux_pane_id`, and no explicit `delivery`, the daemon SHALL scan active pending pre-regs and select the unique row whose `pane_id` maps (via tmux `list-panes`) to a tty whose process listing (`ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=`) contains exactly one LOGICAL candidate satisfying the FULL foreground-carrier proof: a `codex --remote` process whose full argv contains `xats.agent_id="<stored uuid>"` (the outer double-quotes are the ones codex writes when the launcher passes `-c xats.agent_id="\"$uuid\""`), whose STAT contains none of `T`/`t`/`Z`, and whose process group equals the tty's foreground process group (`pgid == tpgid`).  A candidate that is alive but not the tty's foreground carrier (for example a backgrounded codex while the shell owns the foreground group) SHALL NOT be accepted: no bind happens and the pre-reg row remains, exactly like any other non-match.  A ps line with missing or malformed columns SHALL be rejected (fail-closed).  A launcher that starts codex through a wrapper (for example aoe's `node .../bin/codex --remote ...`) produces MULTIPLE lines matching the codex+uuid+STAT+foreground criteria on one tty; when ALL matching lines share the same process group AND that group is the tty's foreground group (`pgid == tpgid`), the daemon SHALL collapse them into ONE logical candidate whose UI pid is the process-group leader (the line with `pid == pgid`) — wrapper plus native child counts as one candidate, leader pid wins.  When the matching lines share one pgid but none of them is the group leader, the daemon SHALL fail closed and skip the row.  Matching lines spanning DIFFERENT process groups remain genuinely ambiguous: no bind, the row remains.  A row skipped for a no-match or a non-collapsing process match SHALL be logged at debug level with the pane id, the matching-line count, and the distinct-pgid count — never argv contents and never any key value.  On a unique (possibly collapsed) match the daemon SHALL:

1. Extract the matched UI process pid from the pane's process table
2. Run the existing `bind_runtime_identity(agent:"codex", ui_pid:<pid>)` path to persist `tmux_pane_id`, `ui_tty`, and `runtime_ui_pid`
3. Delete the consumed pre-reg row
4. Return the normal `register_agent` success envelope without the "no usable tmux_pane_id" hint

#### Scenario: A same-thread rename never consumes a foreign pre-reg row (incident shape)
- **GIVEN** row `aoe-codex(aoe)` with codex-appserver `thread_id="T"`, a bound runtime (pane `%67`, positive pid), and `identity_key="K1"`
- **AND** an UNRELATED shell codex's pre-reg row is pending (pane `%99`, uuid `U_shell`, `identity_key="EECF3E35"`) and would be the unique machine-wide auto-bind candidate
- **WHEN** the SAME conversation re-registers as `register_agent({agent_type:"codex", name:"aoe-codex-r2", team:"aoe", thread_id:"T"})`
- **THEN** the foreign pre-reg row is untouched (still present with `U_shell` and `EECF3E35`)
- **AND** `aoe-codex-r2` inherits the old row's runtime via the pid bind (re-verified live), with no pane detection
- **AND** seat-follow migrates `K1` to `aoe-codex-r2` and the `aoe-codex` row is keyless; `EECF3E35` is attached to no agent row
- **AND** when the shell codex later registers with its own (different) thread, it consumes ITS row, binds its own pane/pid, and receives `EECF3E35`

#### Scenario: A restarted codex carries a new thread and still consumes its pre-reg row
- **GIVEN** the pre-restart row `aoe-codex(aoe)` still has a bound runtime and codex-appserver `thread_id="T-old"`, and the launcher pre-registered the restarted pane with the recovered identity's key
- **WHEN** the restarted codex registers as `aoe-codex(aoe)` with a NEW `thread_id="T-new"`
- **THEN** no same-thread evidence exists — the pre-upsert captured thread is `T-old`, not `T-new`, so the caller's own upsert-reused row (whose stored thread the upsert already overwrote) does not count
- **AND** the pre-reg scan proceeds and consumes the row exactly as before this change

#### Scenario: A rename chain collapses shared-seat rows to one inherited seat
- **GIVEN** rows `A(aoe)` and `B(aoe)` both carry codex-appserver `thread_id="T"` and the SAME physical seat (same positive pid and tty — the natural state after A renamed to B: only A's pane was cleared by last-writer-wins, `B` holds the pane and the latest `runtime_bound_at`), and an unrelated consumable pre-reg row is pending
- **WHEN** the same conversation re-registers as `C(aoe)` with `thread_id="T"`
- **THEN** the two evidence rows collapse to ONE physical seat owned by `B` (last writer), and `C` inherits it via the pid bind (re-verified live)
- **AND** the pre-reg row is untouched and no pane detection runs
- **AND** seat-follow migrates the key from `B` to `C`

#### Scenario: A same-name same-thread re-register re-binds its own preserved seat
- **GIVEN** row `aoe-codex(aoe)` with codex-appserver `thread_id="T"`, a bound runtime (pane, positive pid), and `identity_key="K1"`, and an unrelated consumable pre-reg row pending
- **WHEN** the SAME conversation re-registers as `register_agent({agent_type:"codex", name:"aoe-codex", team:"aoe", thread_id:"T"})` (the upsert reuses the caller's own row and preserves its runtime)
- **THEN** the caller's own preserved bound runtime counts as same-thread evidence (its pre-upsert stored thread equals `T`), the pre-reg scan is skipped, and the registration re-verifies and re-binds its OWN seat via the pid bind
- **AND** the pre-reg row is untouched, no pane detection runs, and the row keeps `K1`

#### Scenario: A pid-less same-thread seat is inherited exactly, with no detection
- **GIVEN** exactly one same-thread evidence row whose runtime binding records no positive pid (`verified_tty_pane`) but a recorded tty and pane, and an unrelated consumable pre-reg row pending
- **WHEN** the same conversation re-registers with that thread
- **THEN** the pre-reg scan is skipped and the registration binds EXACTLY the evidence row's recorded tty/pane via the tty/pane bind shape — `detect_tmux_pane` is never invoked
- **AND** the unrelated pre-reg row remains, and seat-follow still migrates the holder's key by thread equality

#### Scenario: Multiple distinct physical seats fail closed
- **GIVEN** two same-thread evidence rows on DISTINCT physical seats (different pids and ttys), and an unrelated consumable pre-reg row pending
- **WHEN** a codex registration arrives with that thread
- **THEN** the daemon fails closed: no pre-reg scan, no pane detection, and no runtime bind is attempted
- **AND** `register_agent` still succeeds via the standard no-pane-hint path, the pre-reg row remains, and the ambiguity is logged at debug level with row and seat counts only

#### Scenario: An inherit failure never falls back to foreign detection
- **GIVEN** same-thread evidence collapsing to one seat whose pid bind fails (`pid_not_found`), and global pane detection WOULD have returned an UNRELATED codex's pane
- **WHEN** the same conversation re-registers with that thread
- **THEN** exactly one bind attempt is made (the failed inherit); `detect_tmux_pane` is never invoked and the foreign pane is never bound
- **AND** the pre-reg row remains, every row's runtime binding and `identity_key` are exactly what they were before, and `register_agent` still succeeds unbound

#### Scenario: A concurrent registration rewriting the row mid-probe fails the late writer closed
- **GIVEN** row `aoe-codex(aoe)` stores thread `T-old`, and an UNRELATED consumable pre-reg row is pending
- **AND** registration A (`name:"aoe-codex"`, thread `T-new`) captured its pre-upsert snapshot and is awaiting the app-server probe
- **WHEN** a concurrent registration B (`name:"aoe-codex"`, thread `T-new`) persists and binds its own seat during A's probe window, and A then persists
- **THEN** A's transaction-returned prior state (thread `T-new` plus B's seat) differs from A's stale capture (thread `T-old` plus the old seat), and A's runtime auto-bind fails closed: no caller-row evidence, no foreign pre-reg consumption, no pane detection, no runtime bind
- **AND** the upsert-preserved residue of B's seat is cleared conditional on A's minted generation — the row ends with every runtime-seat field NULL, so the tmux poke fallback has no pane to misdeliver to
- **AND** A's `register_agent` still succeeds unbound, and the CAS drift and the clear outcome are logged with their own reasons (agent ids and counts only, never key values)

#### Scenario: A seat freshly written by a concurrent session is never inherited as the caller's own evidence
- **GIVEN** row `aoe-codex(aoe)` stores thread `T` with seat S1, and registration A (`name:"aoe-codex"`, thread `T`) is awaiting the probe after capturing thread `T` plus S1
- **WHEN** a concurrent registration B rewrites the row to thread `U` and binds its own seat `%20`/pid 202 during A's probe window, and A then persists (storing thread `T` again while the upsert preserves B's seat fields)
- **THEN** A's transaction-returned prior state (thread `U` plus seat `%20`/pid 202) differs from A's capture, and A fails closed — A does NOT inherit B's seat and makes no bind attempt of its own
- **AND** the upsert-preserved residue of B's seat (`%20`/pid 202) is cleared conditional on A's minted generation — the row must not end as "thread `T` + B's seat", which the tmux fallback would misdeliver to
- **AND** the unrelated pre-reg row remains and `register_agent` still succeeds unbound with every runtime-seat field NULL

#### Scenario: Single matching pre-reg auto-binds pane
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** tmux pane `%1972` has a foreground `codex --remote` process whose argv contains `xats.agent_id="U1"` with pid `91131`
- **WHEN** the codex agent calls `register_agent({agent_type:"codex", name:"new-gpt", model:"gpt-5", project_dir:"/p"})`
- **THEN** the daemon binds `tmux_pane_id="%1972"` with `runtime_ui_pid=91131`
- **AND** the pre-reg row for `%1972` is deleted
- **AND** the response does not include the `No usable tmux_pane_id is bound yet` hint

#### Scenario: A wrapper+child pair counts as one candidate and binds the leader pid
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** the pane's tty lists `39074 39074 39074 Ss+ node .../bin/codex --remote ... xats.agent_id="U1"` and `41846 39074 39074 S+ .../bin/codex --remote ... xats.agent_id="U1"` (the node wrapper leading the foreground group plus its native child, both matching the stored uuid), in either line order
- **WHEN** the codex agent calls `register_agent({agent_type:"codex", name:"n"})`
- **THEN** the daemon collapses the pair into one candidate and binds `tmux_pane_id="%1972"` with `runtime_ui_pid=39074` (the group leader)
- **AND** the pre-reg row is consumed and its `identity_key` attached when present

#### Scenario: Matches in different process groups stay ambiguous
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** the pane's tty lists two `codex --remote` processes carrying `xats.agent_id="U1"` in DIFFERENT process groups
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon does NOT auto-bind via this pre-reg and the row remains
- **AND** the skip is logged at debug level with the pane id, matching-line count, and distinct-pgid count (never argv contents)

#### Scenario: A leaderless same-group set fails closed
- **GIVEN** the pane's tty lists two matching lines sharing one foreground pgid, neither of which has `pid == pgid`
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon does NOT auto-bind via this pre-reg
- **AND** the pre-reg row remains until it expires or is overwritten

#### Scenario: A backgrounded codex never binds and never consumes the row
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** the pane's tty lists `12345 12345 555 S codex --remote ... xats.agent_id="U1"` and `555 555 555 S+ -zsh` (codex alive but backgrounded; the shell owns the foreground group)
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon does NOT auto-bind via this pre-reg
- **AND** the pre-reg row remains until it expires or is overwritten
- **AND** registration falls back to the existing no-pane hint path

#### Scenario: No matching pre-reg falls back to existing behavior
- **WHEN** `register_agent({agent_type:"codex", name:"n"})` arrives with no pending pre-regs
- **THEN** the daemon takes the existing no-`ui_pid` / no-pane code path (including the standard `detect_tmux_pane` fallback and the "no usable tmux_pane_id" hint when ambiguous)
- **AND** no new error is introduced

#### Scenario: Pre-reg present but argv UUID missing does not auto-bind
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** pane `%1972` runs a `codex --remote` process whose argv does NOT contain `xats.agent_id="U1"` (for example the launcher forgot the `-c` flag)
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon does not auto-bind via this pre-reg
- **AND** the pre-reg row remains until it expires or is overwritten
- **AND** registration falls back to the existing no-pane hint path

#### Scenario: Multiple matching pre-regs do not auto-bind
- **GIVEN** two pending pre-regs, one for `%1972` (UUID U1) and one for `%1970` (UUID U2)
- **AND** both panes run foreground `codex --remote` processes whose argv contains the respective stored UUID
- **WHEN** a single codex `register_agent` call arrives with no `ui_pid`
- **THEN** the daemon does NOT pick one arbitrarily — auto-bind is skipped to avoid cross-session misbinding
- **AND** registration falls back to the existing no-pane hint path
- **AND** both pre-reg rows remain until expiry or explicit re-claim

### Requirement: pre_register_codex_pane tool records pending tmux pane claim

The daemon SHALL expose an MCP tool `pre_register_codex_pane` that accepts `pane_id` (string, tmux pane identifier such as `%1972`), `xats_agent_id` (non-empty string, matches the UUID the launcher will place on the `codex --remote` command line via `-c xats.agent_id="<uuid>"`), optional `identity_key` (non-empty, non-whitespace string, the launcher-minted restart-stable identity handle, delivered only over this CLI/HTTP channel), and optional `ttl_seconds` (positive integer, default `120`, capped at `600`).  On success it SHALL persist a pending pre-registration row keyed by `pane_id` (including `identity_key` when supplied) and return `{ ok: true, expires_at: <ISO8601> }`.  If `pane_id` or `xats_agent_id` is missing or empty, or `identity_key` is supplied but empty or whitespace-only, the tool SHALL return `{ error: "invalid_arguments", detail: <message> }` without writing any state.

#### Scenario: Launcher pre-registers a pane successfully
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"4EF01740-DBAC-4F39-BD94-64A058815856"})`
- **THEN** the daemon writes a pending pre-reg row for `%1972` with the given UUID and a `ttl_seconds=120` default expiry
- **AND** returns `{ ok: true, expires_at: <now + 120s> }`

#### Scenario: Launcher pre-registers with an identity key
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1", ttl_seconds:300})`
- **THEN** the stored row carries `identity_key="K1"` alongside `xats_agent_id="U1"`
- **AND** returns `{ ok: true, expires_at: <now + 300s> }`

#### Scenario: Empty identity_key is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", identity_key:""})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning identity_key> }`
- **AND** no state is written

#### Scenario: Whitespace-only identity_key is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", identity_key:"   "})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning identity_key> }`
- **AND** no state is written

#### Scenario: Missing pane_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({xats_agent_id:"abc"})` without `pane_id`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning pane_id> }`
- **AND** no state is written

#### Scenario: Empty xats_agent_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:""})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning xats_agent_id> }`
- **AND** no state is written

#### Scenario: ttl_seconds is capped at 600
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", ttl_seconds:9999})`
- **THEN** the daemon stores the row with `expires_at = now + 600s`
- **AND** the returned `expires_at` reflects the capped value

### Requirement: pre_register_codex_pane overwrites existing entry for same pane

When a pre-reg for the same `pane_id` already exists, the new call SHALL replace the stored `xats_agent_id`, `identity_key` (including replacing a present key with NULL when the new call omits it), and `expires_at` atomically.  The previous row SHALL NOT leak to subsequent register calls or to recovery-poke scheduling.

#### Scenario: Re-launching in the same pane overwrites
- **WHEN** pane `%1972` has a pending pre-reg with `xats_agent_id=A`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"B"})`
- **THEN** the row for `%1972` now stores `xats_agent_id=B` and a fresh `expires_at`
- **AND** any subsequent `register_agent` match uses `B`, never `A`

#### Scenario: Overwrite without identity_key clears the stored key
- **WHEN** pane `%1972` has a pending pre-reg with `identity_key="K1"`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"B"})` without `identity_key`
- **THEN** the row for `%1972` now has `identity_key = NULL`
- **AND** no recovery poke fires on behalf of `K1` for this pane

### Requirement: CLI pre-register-codex-pane forwards identity_key from the environment

The `cross-agent-teams-mcp pre-register-codex-pane` CLI subcommand SHALL accept an optional `--identity-key-env [VAR]` flag and SHALL NOT accept the identity key itself as an argv value (argv is process-visible; the key must never appear there).  When the flag is present, the CLI SHALL read the key from the named environment variable, defaulting `VAR` to `XATS_IDENTITY_KEY` when the flag is given without a value (end of argv, or a following token starting with `--`, means no value), and SHALL forward the value as the `identity_key` argument of the `pre_register_codex_pane` tool call.  When the flag is present but the environment variable is missing, empty, or whitespace-only, the CLI SHALL exit non-zero with an invalid-arguments JSON error without contacting the daemon.  When the flag is absent the CLI call SHALL be byte-identical in behavior to the pre-change CLI.

#### Scenario: CLI forwards the key from the environment
- **GIVEN** the pane shell exports `XATS_IDENTITY_KEY=K1`
- **WHEN** the launcher runs `pre-register-codex-pane --pane %1972 --agent-id U1 --identity-key-env`
- **THEN** the daemon receives `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1"})`
- **AND** the CLI exits 0 printing the `{ ok: true, ... }` envelope
- **AND** the key value appears on no process argv

#### Scenario: Custom variable name is honored
- **GIVEN** the pane shell exports `MY_XATS_KEY=K1`
- **WHEN** the launcher runs `pre-register-codex-pane --pane %1972 --agent-id U1 --identity-key-env MY_XATS_KEY`
- **THEN** the daemon receives `identity_key="K1"` read from `MY_XATS_KEY`

#### Scenario: A following flag is not consumed as the variable name
- **WHEN** the launcher runs `pre-register-codex-pane --pane %1972 --agent-id U1 --identity-key-env --ttl 300`
- **THEN** the CLI reads the key from `XATS_IDENTITY_KEY` and still honors `--ttl 300`

#### Scenario: Flag without a usable env value fails fast
- **GIVEN** `XATS_IDENTITY_KEY` is unset, empty, or whitespace-only
- **WHEN** the launcher runs `pre-register-codex-pane --pane %1972 --agent-id U1 --identity-key-env`
- **THEN** the CLI exits non-zero with an invalid-arguments error
- **AND** the daemon is not called

#### Scenario: Old-style invocation is unchanged
- **WHEN** the launcher runs `pre-register-codex-pane --pane %1972 --agent-id U1`
- **THEN** the tool call contains no `identity_key` field
- **AND** exit code and output format match the pre-change CLI
