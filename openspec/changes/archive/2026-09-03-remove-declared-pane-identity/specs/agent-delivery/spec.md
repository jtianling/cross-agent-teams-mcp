## REMOVED Requirements

### Requirement: A declared-identity schedule re-resolves its holder by name, not by key
**Reason**: 声明来源的排程不再存在; 恢复通知只按 `identity_key` 持有者排程与重解析.
**Migration**: 无. key 来源的每轮重解析 (`findByIdentityKey`) 与活性判定原样保留.

#### Scenario: No schedule is ever created from a name
- **GIVEN** no agent row holds the supplied `identity_key`
- **WHEN** a pre-registration is accepted for pane `%25`
- **THEN** no recovery schedule exists for `%25`
- **AND** no lookup by `(device, team, name)` is performed on its behalf

## MODIFIED Requirements

### Requirement: Recovery poke is scheduled when an identity-key pre-registration hits a known identity

When a `pre_register_codex_pane` call carrying an `identity_key` is accepted, the daemon SHALL immediately look up the key via the existing device-scoped `findByIdentityKey`.  On a hit whose holder row's runtime process is dead (or unknown), the daemon SHALL schedule a recovery poke for that pane.  On a miss, or when the holder row's `runtime_ui_pid` process is still alive, the daemon SHALL NOT schedule a recovery poke (the alive case is logged at debug level).  Pre-registrations without `identity_key` SHALL never trigger recovery-poke scheduling.

#### Scenario: Known identity with dead holder schedules a poke
- **GIVEN** agent row `aoe-codex(aoe)` holds `identity_key="K1"` and its
  `runtime_ui_pid` process is no longer running
- **WHEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1"})` is accepted
- **THEN** the daemon schedules a recovery poke for pane `%1972` on behalf of `aoe-codex(aoe)`

#### Scenario: Unknown key schedules nothing
- **WHEN** a pre-reg arrives with `identity_key="K9"` matching no agent row
- **THEN** no recovery poke is scheduled
- **AND** the pre-reg row is stored normally for later auto-bind key attach

#### Scenario: Live holder skips scheduling
- **GIVEN** agent row `aoe-codex(aoe)` holds `identity_key="K1"` and its runtime process is alive
- **WHEN** a pre-reg arrives for another pane with `identity_key="K1"`
- **THEN** no recovery poke is scheduled
- **AND** the skip is logged at debug level


### Requirement: Recovery poke scheduling follows the pre-reg row lifecycle

Recovery-poke schedules SHALL be keyed by `pane_id` and cancelled when their pre-reg row leaves the pending state: consumption by auto-bind (the codex agent registered, poked or not) cancels the schedule; an overwriting `pre_register_codex_pane` call for the same pane cancels the old schedule and re-evaluates scheduling from the new row; expiry terminates polling.  Row currency SHALL be judged on the full row snapshot — `xats_agent_id`, `identity_key`, and `expires_at` equality — so a same-value overwrite with a refreshed expiry counts as a new generation and terminates the old one.  Each schedule generation SHALL carry a unique generation token (`codex-recovery:<pane_id>:<generation>`, never reused).  Cancellation SHALL be combined and generation-scoped: consumption, overwrite, and shutdown remove the pending probe schedule and retire exactly the CURRENT generation's token — an in-flight send observes the retirement at its next cancellation checkpoint (every await boundary re-checks it) and neither pastes nor resumes polling — while a superseded (stale) schedule or send MAY only retire its own generation and MUST NOT delete, mutate, or resume a newer generation's schedule.  On daemon shutdown, all recovery schedules SHALL be cancelled before the database closes, and an in-flight send SHALL abort at its next cancellation checkpoint.  Schedules are in-memory: they do not survive a daemon restart, and this is accepted (window bounded by the pre-reg TTL).

#### Scenario: Self-registration cancels the pending poke
- **GIVEN** a scheduled recovery poke for pane `%1972` not yet sent
- **WHEN** the codex agent in that pane registers successfully and auto-bind consumes the pre-reg row
- **THEN** the schedule for `%1972` is cancelled and no recovery poke is ever sent to `%1972`

#### Scenario: Overwrite re-evaluates scheduling
- **GIVEN** a scheduled recovery poke for pane `%1972` based on `identity_key="K1"`
- **WHEN** a new `pre_register_codex_pane` call for `%1972` arrives without `identity_key`
- **THEN** the `K1` schedule is cancelled
- **AND** no new schedule is created for the key-less row

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

#### Scenario: Wording carries identity but never the key
- **GIVEN** a recovery poke on behalf of `aoe-codex(aoe)` triggered by `identity_key="K1"`
- **WHEN** the poke content is composed
- **THEN** it names `aoe-codex` and team `aoe` and instructs a `register_agent` call with `thread_id` from `$CODEX_THREAD_ID`
- **AND** the string `K1` does not appear in the content
