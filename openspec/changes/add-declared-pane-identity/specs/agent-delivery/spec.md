## ADDED Requirements

### Requirement: A declared-identity schedule re-resolves its holder by name, not by key

A recovery schedule created from a declared identity SHALL re-resolve its holder on every poll iteration and immediately before every send, exactly as a key-derived schedule does, but by looking up `(device, team, name)` instead of by `identity_key`.

The schedule SHALL be cancelled when the declared identity's row has come back alive or when a row appears whose liveness cannot be proved.  It SHALL continue only while that row remains absent or has a positive recorded pid whose process is confirmed dead.  A positive recorded pid that is running counts as alive and EPERM reads as alive, exactly as on the key path; a pid-less row is `holder_liveness_unknown` and SHALL block the schedule rather than be treated as dead, which is the one place the declared path is deliberately STRICTER than the key path.

Re-resolution is what makes the delay between scheduling and sending safe: an agent that registered under that identity by itself during the polling window must not then be told to re-register.

#### Scenario: The declared identity coming back alive cancels the schedule
- **GIVEN** a schedule for pane `%25` created from declared identity `(monkeys, mvr-coder)`
- **WHEN** an agent registers as `(monkeys, mvr-coder)` with a live runtime process before the notice is sent
- **THEN** the schedule is cancelled with a logged reason and no notice reaches `%25`

#### Scenario: A still-absent declared identity keeps polling
- **GIVEN** a schedule for pane `%25` created from declared identity `(monkeys, mvr-coder)` with no such row on this device
- **WHEN** poll iterations elapse
- **THEN** the schedule survives and the send proceeds once the pane's codex is detected

#### Scenario: The declared row's liveness is re-read every iteration
- **GIVEN** a schedule created while `(monkeys, mvr-coder)` had a dead runtime process
- **WHEN** that row's process is alive at the next iteration
- **THEN** the schedule is cancelled rather than sending against the newly live holder

#### Scenario: A pid-less declared row cancels as liveness unknown
- **GIVEN** a declaration-derived schedule created while no row existed for `(monkeys, mvr-coder)`
- **WHEN** a row for that identity appears without a positive `runtime_ui_pid`
- **THEN** the schedule is cancelled with reason `holder_liveness_unknown`
- **AND** no notice is sent, because pid-less is not evidence that the holder is dead

## MODIFIED Requirements

### Requirement: Recovery poke is scheduled when an identity-key pre-registration hits a known identity

When a `pre_register_codex_pane` call carrying an `identity_key` is accepted, the daemon SHALL immediately look up the key via the existing device-scoped `findByIdentityKey`.  On a hit whose holder row's runtime process is dead (or unknown), the daemon SHALL schedule a recovery poke for that pane.  When the holder row's `runtime_ui_pid` process is still alive, the daemon SHALL NOT schedule a recovery poke (logged at debug level).

On a key MISS — including a pre-registration carrying no `identity_key` at all — the daemon SHALL fall back to the row's declared identity: when the row carries BOTH `team` and `agent_name`, the daemon SHALL schedule a recovery poke naming that identity, subject to the same holder rules stated below.  A key miss with no complete declaration SHALL schedule nothing, unchanged from before this change.  A partial declaration (only one of the two fields) SHALL schedule nothing and SHALL be logged at debug level: half an identity cannot address a registration, and silently inventing the other half from any other source would be exactly the inference this mechanism exists to avoid.

The key SHALL take precedence whenever it resolves.  A key hit SHALL be scheduled from the key's holder even when the row also carries a declaration, and a disagreement between the two SHALL be logged at debug level naming both identities (never the key value).  The precedence is not arbitrary: the key's holder is a runtime fact — some row demonstrably holds that key — whereas the declaration is a configuration intent that may have drifted since it was written.  Letting an edited configuration override a binding that is currently working would turn a typo into an eviction.

For a declaration-derived schedule the holder rules SHALL be evaluated against the declared `(device, team, name)`:

1. no row exists for that identity on this device — the daemon SHALL schedule, since this is a first assignment;
2. a row exists with a positive `runtime_ui_pid` naming a dead process — the daemon SHALL schedule, since this is a recovery case with affirmative death evidence;
3. a row exists whose positive `runtime_ui_pid` names a live process — the daemon SHALL NOT schedule, and SHALL log `holder_alive` naming the declaring pane, the declared identity, and the live holder;
4. a row exists without a positive `runtime_ui_pid` — the daemon SHALL NOT schedule, and SHALL log `holder_liveness_unknown` naming the declaring pane, the declared identity, and the existing holder.

Branch 3 preserves the existing conservative holder invariant through a different lookup.  Branch 4 is NEW and applies to the declared path ONLY: the key path SHALL continue to read a pid-less holder as recoverable and schedule for it, unchanged.  That asymmetry is deliberate and SHALL NOT be "unified" in either direction.  A key's holder is provably of the same seat lineage as the pre-registration — it holds the very key this launcher minted for this pane — so scheduling against it is self-recovery.  A declared identity's holder merely shares a name: `(team, name)` is a globally addressable tuple that other runtimes hold as a matter of course, and a notice is an instruction to take over an identity.  The same missing pid therefore carries two different risks, and only the declared path needs the conservative reading.

Neither branch SHALL be weakened for the declared path: a configuration typo naming a busy or pid-less identity would otherwise talk a working agent out of its own seat — a strictly worse outcome than the failure this change repairs.  This intentionally gives up automatic recovery for a genuinely dead pid-less runtime, because its death cannot be distinguished from normal pid-less operation; and the loss is absorbing rather than one-off, since such an identity keeps meeting branch 4 on every later seat rebuild until it re-registers with a pid.

#### Scenario: Known identity with dead holder schedules a poke
- **GIVEN** agent row `aoe-codex(aoe)` holds `identity_key="K1"` and its
  `runtime_ui_pid` process is no longer running
- **WHEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1"})` is accepted
- **THEN** the daemon schedules a recovery poke for pane `%1972` on behalf of `aoe-codex(aoe)`

#### Scenario: Unknown key with a declaration schedules from the declaration
- **GIVEN** no agent row holds `identity_key="K9"`
- **AND** agent row `mvr-coder(monkeys)` exists with a dead `runtime_ui_pid`
- **WHEN** a pre-reg arrives with `identity_key="K9"`, `team="monkeys"`, `agent_name="mvr-coder"`
- **THEN** the daemon schedules a recovery poke for that pane on behalf of `mvr-coder(monkeys)`
- **AND** the pre-reg row is still stored normally for later auto-bind key attach

#### Scenario: Unknown key with a declaration naming nobody still schedules
- **GIVEN** no agent row holds the supplied key and no row exists for `(monkeys, fresh-coder)`
- **WHEN** a pre-reg arrives declaring that identity
- **THEN** a poke is scheduled naming `fresh-coder(monkeys)`, because a first assignment has no incumbent to protect

#### Scenario: Unknown key without a declaration schedules nothing
- **WHEN** a pre-reg arrives with `identity_key="K9"` matching no agent row and carrying no declaration
- **THEN** no recovery poke is scheduled
- **AND** the pre-reg row is stored normally for later auto-bind key attach

#### Scenario: A half declaration schedules nothing
- **WHEN** a pre-reg arrives on a key miss carrying `team="monkeys"` but no `agent_name`
- **THEN** no recovery poke is scheduled
- **AND** the incomplete declaration is logged at debug level

#### Scenario: A declaration naming a LIVE identity schedules nothing
- **GIVEN** agent row `mvr-coder(monkeys)` exists and its `runtime_ui_pid` process is alive
- **WHEN** a pre-reg on a key miss declares `(monkeys, mvr-coder)`
- **THEN** no recovery poke is scheduled
- **AND** the refusal is logged naming the declaring pane, the declared identity and the live holder

#### Scenario: A declaration naming a pid-less identity schedules nothing
- **GIVEN** agent row `mvr-coder(monkeys)` exists without a positive `runtime_ui_pid`
- **WHEN** a pre-reg on a key miss declares `(monkeys, mvr-coder)`
- **THEN** no recovery poke is scheduled
- **AND** the refusal is logged with reason `holder_liveness_unknown`

#### Scenario: A key hit wins over a disagreeing declaration
- **GIVEN** `identity_key="K1"` is held by `aoe-codex(aoe)` whose process is dead
- **WHEN** a pre-reg arrives with `identity_key="K1"` but declares `(monkeys, mvr-coder)`
- **THEN** the poke is scheduled on behalf of `aoe-codex(aoe)`, from the key
- **AND** the disagreement is logged at debug level naming both identities and no key value

#### Scenario: Live holder skips scheduling
- **GIVEN** agent row `aoe-codex(aoe)` holds `identity_key="K1"` and its runtime process is alive
- **WHEN** a pre-reg arrives for another pane with `identity_key="K1"`
- **THEN** no recovery poke is scheduled
- **AND** the skip is logged at debug level

#### Scenario: A pre-registration with neither key nor declaration schedules nothing
- **WHEN** a pre-reg arrives carrying no `identity_key` and no declaration
- **THEN** no recovery poke is scheduled, unchanged from before this change

### Requirement: Recovery poke scheduling follows the pre-reg row lifecycle

Recovery-poke schedules SHALL be keyed by `pane_id` and cancelled when their pre-reg row leaves the pending state: consumption by auto-bind (the codex agent registered, poked or not) cancels the schedule; an overwriting `pre_register_codex_pane` call for the same pane cancels the old schedule and re-evaluates scheduling from the new row; expiry terminates polling.  Row currency SHALL be judged on the full row snapshot — `xats_agent_id`, `identity_key`, and `expires_at` equality — so a same-value overwrite with a refreshed expiry counts as a new generation and terminates the old one.  Each schedule generation SHALL carry a unique generation token (`codex-recovery:<pane_id>:<generation>`, never reused).  Cancellation SHALL be combined and generation-scoped: consumption, overwrite, and shutdown remove the pending probe schedule and retire exactly the CURRENT generation's token — an in-flight send observes the retirement at its next cancellation checkpoint (every await boundary re-checks it) and neither pastes nor resumes polling — while a superseded (stale) schedule or send MAY only retire its own generation and MUST NOT delete, mutate, or resume a newer generation's schedule.  On daemon shutdown, all recovery schedules SHALL be cancelled before the database closes, and an in-flight send SHALL abort at its next cancellation checkpoint.  Schedules are in-memory: they do not survive a daemon restart, and this is accepted (window bounded by the pre-reg TTL).

#### Scenario: Self-registration cancels the pending poke
- **GIVEN** a scheduled recovery poke for pane `%1972` not yet sent
- **WHEN** the codex agent in that pane registers successfully and auto-bind consumes the pre-reg row
- **THEN** the schedule for `%1972` is cancelled and no recovery poke is ever sent to `%1972`

#### Scenario: Overwrite re-evaluates scheduling
- **GIVEN** a scheduled recovery poke for pane `%1972` based on `identity_key="K1"`
- **WHEN** a new `pre_register_codex_pane` call for `%1972` arrives without `identity_key` and without a complete declaration
- **THEN** the `K1` schedule is cancelled
- **AND** no new schedule is created for the key-less, declaration-less row

#### Scenario: Same-value overwrite with a fresh expiry is a new generation
- **GIVEN** a scheduled recovery poke for pane `%1972` with `xats_agent_id="U1"` and `identity_key="K1"`
- **WHEN** a new `pre_register_codex_pane` call for `%1972` arrives with the identical `U1`/`K1` but a refreshed `expires_at`
- **THEN** the old schedule is cancelled
- **AND** a fresh schedule is created from the new row
- **AND** the pane never receives a double send from both generations

#### Scenario: A stale suspended send cannot act on the new generation
- **GIVEN** an old-generation send for pane `%1972` suspended inside its quiet guard
- **AND** an overwriting pre-register that created a new-generation schedule for the same pane
- **WHEN** the old send resumes
- **THEN** it performs no paste and resumes no polling
- **AND** the new generation's schedule survives untouched

#### Scenario: Daemon shutdown cancels schedules and in-flight sends
- **GIVEN** a pending recovery probe timer and an in-flight recovery send for pane `%1972`
- **WHEN** the daemon shuts down
- **THEN** the probe timer and the pane's generation token are cancelled before the database closes
- **AND** the in-flight send aborts at its next checkpoint without pasting

### Requirement: Recovery poke wording guides re-registration with the recovered identity

The recovery poke content SHALL be a daemon-side fixed template that identifies itself as a cross-agent-teams recovery notice, states the recovered `(team, name)`, and instructs the codex agent to call `register_agent` with `agent_type="codex"`, that `name` and `team`, and `thread_id` read from `$CODEX_THREAD_ID`.  The template MUST NOT contain the `identity_key` value.

The template SHALL be identical whether the identity was resolved from the key's holder or from the row's declaration.  The notice tells an agent who it is; how the daemon learned that is not information the agent can act on, and two wordings would only invite an agent to trust one source more than the other.  The daemon's own logs SHALL record which source was used, so the distinction stays diagnosable where it matters.

#### Scenario: Wording carries identity but never the key
- **GIVEN** a recovery poke on behalf of `aoe-codex(aoe)` triggered by `identity_key="K1"`
- **WHEN** the poke content is composed
- **THEN** it names `aoe-codex` and team `aoe` and instructs a `register_agent` call with `thread_id` from `$CODEX_THREAD_ID`
- **AND** the string `K1` does not appear in the content

#### Scenario: A declaration-derived notice reads identically
- **GIVEN** a recovery poke scheduled from the declared identity `(monkeys, mvr-coder)` after a key miss
- **WHEN** the poke content is composed
- **THEN** it is the same template, naming `mvr-coder` and team `monkeys`
- **AND** the content carries no indication of which lookup produced it, while the schedule log records the source
