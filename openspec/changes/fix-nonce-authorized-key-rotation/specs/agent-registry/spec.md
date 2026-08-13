## ADDED Requirements

### Requirement: A nonce-targeted pre-reg row authorises rotating the caller's identity key

When the pre-reg row under consideration was selected by a recovery nonce the daemon itself minted, wrote into one known pane, and has now consumed, a caller row already holding a DIFFERENT `identity_key` SHALL NOT disqualify that row.  The daemon SHALL instead ROTATE the caller row's key to the row's key, replacing the stale one.

The authority for this is permission parity, not the nonce being "stronger evidence" than a key.  The same nonce already authorises the heavier act: taking that pane's runtime binding, which evicts whatever agent held it (last-writer-wins).  Having granted that, refusing the strictly lesser act of overwriting one column on the caller's OWN row is not a safety property — it is an inconsistency that makes the state machine unable to converge.  The rotation writes only to the caller's row; it SHALL NOT take a key away from any other live identity, which remains governed by the holder arbitration below.

The carve-out SHALL be scoped to the nonce-targeted path ONLY.  A row reached through the scan's unique-machine-wide-candidate inference SHALL keep the existing terminal refusal (`identity_key_contradiction`), because that inference proves the PANE's codex identity and never the CALLER's.  The distinguishing fact is one the daemon owns — which pane it sent the token to — rather than one it infers.

Rotation SHALL NOT weaken any other check.  The foreground-carrier proof, the holder arbitration for the incoming key, the full-snapshot re-read, the in-transaction re-arbitration and the single-transaction rollback all apply unchanged.  In particular, a row whose key is held by a DIFFERENT `(team, name)` that is not provably gone SHALL still be excluded even under a nonce: the caller may discard its own stale key, never take a live stranger's.

This requirement SHALL NOT be justified by, and SHALL NOT be implemented as, "the stale key's carrier process is dead".  The stale key's holder is the caller's own row (the `(device, identity_key)` index admits no second holder), whose `runtime_ui_pid` is necessarily dead in exactly the legitimate-restart case this requirement serves — such a condition would admit every case it is asked about and therefore decide nothing.  Worse, the one shape it WOULD refuse is a pane adopting another identity after that identity's carrier died, which is the failure `Seat identity for key migration is the pane, never the tty` already exists to prevent.  Liveness is not the gate; the nonce is.

#### Scenario: A restarted pane recovers despite holding a previous generation's key

- **GIVEN** a caller row holding `identity_key="K_old"` whose own runtime process is gone
- **AND** a pending pre-reg row for pane `%25` carrying `identity_key="K_new"` with `K_new != K_old`, whose tty hosts a foreground carrier with that row's stored uuid
- **AND** the caller presents a recovery nonce that resolves to `%25`
- **WHEN** the registration reaches the pre-reg scan
- **THEN** the row is NOT excluded for key contradiction
- **AND** the pane is bound, the row is consumed, and the caller row's `identity_key` is now `K_new`
- **AND** a later restart recovers this identity via `K_new`

#### Scenario: The same contradiction without a nonce is still terminal

- **GIVEN** the identical caller row and pending row as above
- **AND** the caller presents NO recovery nonce, so the row is reachable only by the unique-candidate inference
- **WHEN** the registration reaches the pre-reg scan
- **THEN** the row is excluded with reason `identity_key_contradiction`, exactly as before this change: no bind, no consumption, no key attach
- **AND** the row is still pending with its key

#### Scenario: A nonce does not authorise taking a live stranger's key

- **GIVEN** a caller presenting a nonce that resolves to pane `%25`
- **AND** that pane's pending row carries `identity_key="K1"` whose holder is a DIFFERENT `(team, name)` with a live `runtime_ui_pid`
- **WHEN** the registration reaches the pre-reg scan
- **THEN** the row is excluded with the live-holder reason: no bind, no consumption, no rotation
- **AND** the row is still pending with `identity_key="K1"`

#### Scenario: A nonce does not authorise taking a liveness-unknown holder's key

- **GIVEN** a caller presenting a nonce that resolves to pane `%25`
- **AND** that pane's pending row carries `identity_key="K1"` whose holder is a DIFFERENT `(team, name)` with `runtime_ui_pid = NULL`
- **WHEN** the registration reaches the pre-reg scan
- **THEN** the row is excluded with the `identity_key_holder_liveness_unknown` reason, unchanged by the nonce

#### Scenario: The post-verify re-arbitration honours the same carve-out

- **GIVEN** a nonce-targeted row whose key contradicts the caller's stale key, admitted at candidacy time
- **WHEN** the commit's re-arbitration runs inside the transaction
- **THEN** it reaches the same rotation verdict as candidacy did, so the commit is not refused for a contradiction candidacy already allowed
- **AND** a holder acquiring the key during the verification window still refuses and rolls the whole transaction back

#### Scenario: The attach step does not re-refuse a rotation it was asked to perform

- **GIVEN** a nonce-targeted row consumed for a caller whose row holds a different key
- **WHEN** the key attach runs inside the same transaction
- **THEN** it applies the rotation instead of refusing with `caller_holds_different_key`
- **AND** the caller row ends the transaction holding exactly one key: the consumed row's

#### Scenario: Two panes restarted together each rotate to their own key

- **GIVEN** two panes whose agent rows both hold previous-generation keys, each with its own pending row carrying its own new key and its own foreground carrier
- **AND** each pane's codex presents the nonce it received
- **WHEN** both register
- **THEN** each consumes ITS OWN row and rotates to ITS OWN new key
- **AND** neither takes the other's key

### Requirement: Identity key rotation leaves an auditable trace

Whenever the daemon replaces a non-null `identity_key` on an agent row with a different one, it SHALL log the rotation at debug level naming the caller id, the pane, and the old and new keys TRUNCATED TO THEIR FIRST 8 CHARACTERS.  A silent rotation is indistinguishable from a silent refusal in the log, and this class of defect is otherwise diagnosable only by reading the live database by hand.

Truncation is what makes logging admissible at all: the existing rule that decision logs SHALL NOT carry key values protects a recovery credential, and an 8-character prefix identifies a key across log lines and DB rows without reconstructing it.

#### Scenario: A rotation is traceable without disclosing the key

- **WHEN** a nonce-authorised rotation replaces `identity_key` on a caller row
- **THEN** the log records the caller id, the pane id, and both keys truncated to 8 characters
- **AND** no full key value appears in any log line

#### Scenario: An idempotent re-bind is not reported as a rotation

- **WHEN** the attach step writes the key the caller row already holds
- **THEN** no rotation is logged, because nothing was replaced

## MODIFIED Requirements

### Requirement: register_agent tool description instructs callers to present XATS_IDENTITY_KEY

The `register_agent` MCP tool description SHALL instruct callers to read `XATS_IDENTITY_KEY` from their environment and pass it as `identity_key` on **every** registration, including the very first one.  The description MUST state that the key is what makes the identity recoverable after a restart, and that omitting it on the first registration silently disables recovery for that pane with no observable symptom.

This instruction is orthogonal to the existing `agent_type` DETECTION block: `XATS_IDENTITY_KEY` SHALL NOT be added as a first-match-wins `agent_type` probe, because it says nothing about which runtime the caller is.  It applies to every `agent_type`.

The description exists specifically to cover runtimes that have no channel proxy to inline the value for them — codex above all.

The description SHALL additionally warn codex callers that the value they can read is NOT their own.  A codex tool call executes inside a shared app-server process, so `XATS_IDENTITY_KEY` there resolves to whatever the shell that launched THAT SERVER exported — a value belonging to another pane or to nothing at all — while the correct per-pane key is present in the pane process's own environment where codex cannot reach it.  Codex callers SHALL therefore be told to omit `identity_key` and rely on the launcher's `pre_register_codex_pane` flow, which carries the pane's real key over a channel the caller does not have to read.  The existing kimi caveat states this same hazard for server-hosted kimi engines; the codex entry SHALL NOT be left stating only the `ui_pid` instruction, since a caller that reads the variable and passes it in good faith would claim a key that is not its own.

#### Scenario: Description names the environment variable

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description contains the literal substring `XATS_IDENTITY_KEY`
- **AND** it instructs passing that value as `identity_key`

#### Scenario: Description covers the first registration

- **WHEN** the `register_agent` description is inspected
- **THEN** it states that the key must be presented on the first registration, not only when recovering

#### Scenario: The key is not an agent_type probe

- **WHEN** the `register_agent` description is inspected
- **THEN** `XATS_IDENTITY_KEY` does not appear as a numbered branch of the first-match-wins `agent_type` DETECTION sequence
- **AND** the four existing `agent_type` probes are unchanged

#### Scenario: The codex entry warns the readable value is not the caller's

- **WHEN** the `register_agent` description's codex instructions are inspected
- **THEN** they state that the readable `XATS_IDENTITY_KEY` belongs to the app-server's launching shell rather than to the caller's pane
- **AND** they instruct codex to omit `identity_key` and rely on the launcher's pre-registration flow

### Requirement: Auto-bind attaches stored identity_key via the four-branch rule

When `register_agent` auto-bind consumes a pre-reg row that carries an `identity_key`, the daemon SHALL attach that key to the caller's agent row using the existing `planIdentityKeyBinding` four-branch rule (unbound leads to bind; same row is idempotent; held by a row whose process is dead migrates with the old row's key cleared).  A pending row whose key belongs to ANOTHER identity SHALL be excluded from the candidate set entirely — either because its `identity_key` DIFFERS from a non-null key the caller's row already holds, or because the key's holder is a DIFFERENT `(team, name)` that is not provably gone (which also covers a KEYLESS caller reaching another identity's row).  The FIRST of those two exclusions SHALL NOT apply when the row was selected by a consumed recovery nonce: a caller's own stale key is then rotated rather than treated as a contradiction, per `A nonce-targeted pre-reg row authorises rotating the caller's identity key`.  The SECOND is unconditional — no nonce authorises taking a key that a different live or liveness-unknown identity holds.  An excluded row SHALL be excluded entirely — not bound, not consumed, no key attached — and logged at debug level with the pane id and the distinguishing reason (`identity_key_contradiction` or `identity_key_live_holder_conflict`; never key values); the row remains pending for its rightful owner, and a registration left with no candidate takes the existing fail-closed path (no bind from this scan, `detect_tmux_pane` fallback as before).  Absent a nonce, the scan's only other correlation is "unique machine-wide candidate whose pane tty hosts a codex carrying the stored uuid", which proves the PANE's codex identity and never the CALLER's, so a positive key contradiction is the only available evidence that the row belongs to another identity: skipping just the attach while still binding the pane and consuming the row would strand the rightful owner unbound and keyless and point the caller's seat at a foreign pane.  Candidacy SHALL NOT be decided by `planIdentityKeyBinding`: that rule arbitrates a key AFTER the caller has proven pane ownership and therefore excludes conflicts against the caller's OWN `ui_pid`, while the scan has no caller pid at all — passing the CANDIDATE PANE's carrier pid makes the arbitration self-exclude precisely when the live foreign holder IS that pane's foreground codex (holder pid == candidate pid).  Candidacy SHALL instead take positive proof only: another identity's key is foreign unless that identity is provably gone (a positive recorded pid that is NOT running).  A holder of ANOTHER `(team, name)` whose row records NO positive `runtime_ui_pid` is liveness UNKNOWN, never dead — a tty/pane bind legitimately records no pid — so such a row SHALL also be excluded from candidacy (reason `identity_key_holder_liveness_unknown`), even though the post-consumption attach may still migrate that key once pane ownership has been proven.  A row carrying NO key contradicts nothing and stays consumable; a caller holding no key, or holding the same key, is unaffected.

The candidacy decision is taken BEFORE the runtime bind's asynchronous verification, so the rightful owner can acquire the key inside that window.  The daemon SHALL therefore split that bind into an ASYNCHRONOUS verification that persists nothing and a SYNCHRONOUS commit, and the commit SHALL run the claim re-arbitration, the runtime write, the conditional row consumption and the key attach inside ONE transaction.  The re-arbitration SHALL be given the SAME nonce-selection fact candidacy used, so a row admitted for rotation is not refused at commit for the contradiction candidacy already allowed; every other refusal ground is re-evaluated on fresh reads exactly as before.  Compensating afterwards is NOT sufficient: the runtime write evicts any incumbent agent holding the same pane (last-writer-wins), and clearing the caller's row afterwards cannot restore that eviction — the rightful owner would be left with its pane binding destroyed.  Any refusal (re-arbitration says foreign, stale generation) or any thrown error inside the commit SHALL therefore roll the whole transaction back, leaving NO runtime write, NO incumbent eviction, NO consumed row and NO attached key, and the outcome SHALL be logged (pane id, reason or redacted error, and a `post_verify` stage marker for the re-arbitration refusal).  A failing key attach SHALL take the row consumption down with it — a consumed row whose key was never attached destroys the recovery handle permanently.

The `detect_tmux_pane` fallback SHALL NOT bind a pane that still carries an UNEXPIRED pre-reg row, and that check SHALL be evaluated inside the SAME synchronous commit as the fallback's runtime write (both the pid-carrier shape and the tty/pane shape), because every fallback shape still awaits probes after any earlier check: a launcher announcing that pane inside the await window would otherwise be overruled by a bind with no caller correlation whatsoever.  A pending row means some launcher announced that pane for a codex that has not registered yet; had the caller been that codex, the scan above would have consumed the row under the uuid plus foreground-carrier proof.  Since the fallback scores panes machine-wide with NO caller correlation whatsoever, letting it bind such a pane re-creates by heuristic exactly the claim the scan just refused by evidence.  The refusal SHALL be logged at debug level (pane id, `pane_has_pending_prereg`, caller id) and the registration SHALL take the existing fail-closed path.  When a row IS consumed, the daemon SHALL NOT overwrite a different key on the caller's row EXCEPT under the nonce-authorised rotation above: the attach step re-reads the caller row inside the commit and REFUSES on any of caller row missing, caller holding a different key WITHOUT a nonce selection, or the planner reporting a live foreign holder.  Every such refusal SHALL roll the whole transaction back — returning "attached nothing" while reporting success would commit the exact state this requirement forbids: incumbent evicted, recovery row consumed, key attached nowhere, and that row is the key's only carrier.  The refusal reason SHALL be logged (never key values).  Row consumption SHALL be conditional on the full row snapshot auto-bind matched (`pane_id`, `xats_agent_id`, `identity_key`, `expires_at`): auto-bind SHALL re-read and compare the row immediately before binding, and consume via a conditional delete on the full snapshot after binding; when the row was overwritten mid-flight, the daemon SHALL NOT delete the new row, SHALL NOT attach any key to the caller, SHALL NOT cancel the new row's recovery schedule, SHALL NOT run the seat-follow hook (a stale outcome must not move any seat-held key onto the caller, bypassing the full-snapshot consume protection), and SHALL log a structured warning (pane id and reason, never the key value) while the already-persisted pane binding remains.  Any failure in the attach step SHALL obey the existing "auto-bind failure does not corrupt register_agent result" requirement.

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
- **AND** the caller presents NO recovery nonce, so `%71` is reachable only by the unique-candidate inference
- **WHEN** the caller's registration reaches the pre-reg scan
- **THEN** the `%71` row is excluded from the candidate set: no bind, no consumption, no key attach, and the exclusion is logged at debug level with the pane id and the contradiction reason (never key values)
- **AND** the `%71` row is still pending with `identity_key="K2"`, so its rightful owner can consume it and receive `K2`
- **AND** the caller's registration takes the existing fail-closed path and the `register_agent` envelope is not turned into an error

#### Scenario: A contradicting row is filtered, leaving the caller's own row unique
- **GIVEN** two pending rows — `%10` carrying the caller's own `identity_key="K1"` and `%11` carrying `identity_key="K2"` — whose ttys each host a foreground codex matching their stored uuid
- **WHEN** a caller holding `identity_key="K1"` registers with no same-thread evidence and no recovery nonce
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
