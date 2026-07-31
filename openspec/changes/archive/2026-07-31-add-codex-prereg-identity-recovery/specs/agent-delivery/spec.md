# agent-delivery Delta

## ADDED Requirements

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

### Requirement: Recovery poke first send is gated on codex process detection

The scheduled recovery poke MUST NOT be sent while the pre-registered pane may still be running a shell.  The daemon SHALL poll (bounded interval) the pane's tty using the same probing primitives as codex auto-bind (`tmux list-panes`, `ps -t <tty>`, codex `--remote` process recognition, argv containing `xats.agent_id="<stored uuid>"`), and SHALL send the first poke only after a matching codex process is detected; a candidate line whose STAT contains `T`, `t`, or `Z` (stopped, traced, or zombie) SHALL NOT count as a detection — the shell owns the tty again — and the auto-bind candidate filter that shares these primitives SHALL apply the full foreground-carrier acceptance (STAT, command with stored uuid, and `pgid == tpgid`; see the agent-registry auto-bind requirement).  A wrapper-launched codex produces MULTIPLE matching lines on one tty (for example a `node .../bin/codex --remote` process-group leader plus its native child); detection SHALL collapse same-process-group matches exactly like auto-bind: all matches sharing one pgid whose group is the tty's foreground group (`pgid == tpgid` on every matching line) count as ONE detection whose pid is the group leader (`pid == pgid`) — wrapper plus child is one candidate, leader pid wins.  A same-group set without a leader line detects nothing (fail-closed), and matches spanning DIFFERENT pgids remain ambiguous and detect nothing; a non-collapsing multi-line outcome SHALL be logged at debug level once per schedule generation per reason with the pane id, matching-line count, and distinct-pgid count — never argv contents, never the key value.  The write-time carrier proof evaluates the chosen (leader) pid's own ps line, which MAY be the wrapper form (`node ... codex --remote ...`); sibling group members on the same tty do not affect the per-pid classification.  A probe infrastructure exception (pane listing or tty process listing) SHALL be logged at debug level once per stage per schedule — naming the pane, the stage, and the error class, with the identity key value redacted from the message — so a broken probe is distinguishable from ordinary not-yet-detected polling; the key value SHALL never appear in any log line.  Each poll iteration SHALL first check row currency (full-snapshot, see the lifecycle requirement) and SHALL re-resolve the holder via `findByIdentityKey`, requiring the same `agent_id`, `team`, and `name` as at schedule time and a still-dead holder process (holder-side liveness keeps the conservative `process.kill(pid, 0)` semantics, EPERM reads as alive); on a miss, any change, or a holder back alive, the schedule SHALL be cancelled with a debug log that never contains the key value.  Every send attempt SHALL run the quiet guard FIRST; only after the guard passes SHALL the daemon re-probe the codex process (a vanished process or a changed pid cancels the send without pasting), re-check row currency, re-resolve the holder, and run pane-host verification.  The paste SHALL go through the shared tmux poke primitive carrying a composite synchronous confirm predicate — schedule generation not cancelled, row snapshot still current, holder tuple unchanged and still dead, and a TARGET-side foreground-carrier proof — which the primitive SHALL evaluate synchronously before anything is written (pre-capture), immediately before the paste, AND once more immediately before the Enter keypress: a failure before the paste aborts with nothing written, and a failure between paste and Enter aborts with a distinct `ownership_lost` error, leaving the pasted text unexecuted (pasted-but-unexecuted is acceptable; executing it is not).  The foreground-carrier proof SHALL demand positive evidence via a synchronous, bounded-timeout `ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=` probe: the detected codex pid present on the pane's tty with a STAT containing none of `T`/`t`/`Z`, its current command line still matching codex `--remote` with the stored `xats.agent_id="<uuid>"` (guarding against PID reuse), and its process group equal to the tty's foreground process group (`pgid == tpgid`).  Pid liveness alone (`process.kill(pid, 0)`) SHALL NOT satisfy the target-side predicate: a SIGSTOP-ed codex keeps the pid alive while the shell is foreground.  ANY probe error, timeout, EPERM, missing column, or otherwise unknown state SHALL read as not-safe: no paste, no Enter.  The poke content SHALL be built from the freshly resolved holder at send time.  Transient refusals SHALL NOT retire the schedule generation and SHALL NOT enter any long-backoff retry ladder.  Two refusals are transient: a quiet-guard failure on a send attempt (the common case right after a codex restart, while the TUI is still drawing its boot screen), and a write-checkpoint refusal with nothing yet written whose ONLY failing leg is the foreground-carrier proof observing a live-but-backgrounded codex (present on the tty, STAT free of `T`/`t`/`Z`, command still matching with the stored uuid, but `pgid != tpgid`).  Either refusal returns the pane's schedule to the detection polling loop with the SAME generation token (no new generation, exactly one live schedule entry per pane, so overwrite/consumption cancellation still targets it); every subsequent poll iteration repeats the FULL detect, guard, re-probe, re-verify, paste sequence, so the retry cadence is the probe interval, bounded by the pre-reg row lifecycle — polling continues until the row expires, is overwritten, or is consumed.  A refusal observed by a cancelled or superseded generation resumes nothing and MUST NOT touch a newer generation's schedule.  Recovery lifecycle logging SHALL carry an ISO timestamp on every line: scheduling (with the holder identity), the first detection of a codex pid (once per distinct pid per generation), each transient-resume transition (at most once per consecutive streak of one reason — the streak marker resets when that stage passes again, so a relapse logs anew), delivery, and terminal cancellations with their reason; no line ever contains the key value or argv contents.  All other send outcomes remain terminal for the generation as before: delivered, `ownership_lost` after the paste (even on a carrier refusal), a vanished or restarted codex process, a stale row, holder drift, a probe hard error, and cancellation.

#### Scenario: No poke while the pane still runs a shell
- **GIVEN** a scheduled recovery poke for pane `%1972`
- **AND** the pane's tty shows no codex `--remote` process with the stored uuid on argv
- **WHEN** the poll interval elapses repeatedly
- **THEN** no paste reaches pane `%1972`

#### Scenario: Detection unlocks the first send
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **WHEN** a codex `--remote` process whose argv contains `xats.agent_id="U1"` appears on the pane's tty
- **THEN** the daemon runs the quiet guard, then re-probes the process, re-checks the row and holder, verifies the pane host, and pastes the recovery poke
- **AND** a quiet-guard failure returns the schedule to the polling loop instead of entering any retry ladder

#### Scenario: A wrapper+child pair detects the leader and delivers
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **AND** the pane's tty lists `39074 39074 39074 Ss+ node .../bin/codex --remote ... xats.agent_id="U1"` and `41846 39074 39074 S+ .../bin/codex --remote ... xats.agent_id="U1"` (both foreground, one process group), in either line order
- **WHEN** a poll iteration runs
- **THEN** detection collapses the pair to pid `39074` (the group leader)
- **AND** the send path verifies pane `%1972` against pid `39074` and pastes, with the write-time carrier proof accepting the wrapper-form leader line

#### Scenario: Matches in different process groups detect nothing
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **AND** the pane's tty lists two `codex --remote` processes carrying `xats.agent_id="U1"` in DIFFERENT process groups
- **WHEN** poll iterations run repeatedly
- **THEN** no detection occurs and nothing is pasted into `%1972`
- **AND** exactly one debug line per schedule generation names the pane, the matching-line count, and the distinct-pgid count (never argv contents or the key value)

#### Scenario: A leaderless same-group set is never a detection
- **GIVEN** the pane's tty lists two matching lines sharing one foreground pgid, neither of which has `pid == pgid`
- **WHEN** poll iterations run
- **THEN** detection fails closed and nothing is pasted

#### Scenario: Codex exit during the quiet guard cancels the send
- **GIVEN** a detected codex process for pane `%1972` and a passing quiet guard
- **WHEN** the codex process exits (or restarts under a new pid) before the post-guard re-probe
- **THEN** nothing is pasted into `%1972`
- **AND** the cancellation is logged without the key value

#### Scenario: Codex exit after the post-guard re-probe blocks the paste
- **GIVEN** a send attempt whose post-guard re-probe and pane-host verification passed
- **WHEN** the codex process exits before the primitive's pre-paste confirm runs
- **THEN** the composite confirm returns false and nothing is pasted into the pane

#### Scenario: Codex exit between paste and Enter aborts execution
- **GIVEN** a recovery poke whose content was already pasted into pane `%1972`
- **WHEN** the detected codex process exits during the paste settle window, before Enter is sent
- **THEN** the Enter keypress is not sent and the attempt reports `ownership_lost`
- **AND** the pasted-but-unexecuted text is never executed by the daemon

#### Scenario: A stopped codex with a foreground shell never receives a send
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **AND** the pane's tty lists `91131 1 T codex --remote ... xats.agent_id="U1"` and `555 1 S+ -zsh`
- **WHEN** poll iterations and any send attempt run
- **THEN** nothing is ever pasted into `%1972` (the stopped codex is not a detection, and the write-time carrier proof rejects it)

#### Scenario: A zombie codex process blocks the send
- **GIVEN** a send attempt whose foreground probe shows the detected pid with a STAT containing `Z`
- **WHEN** any of the primitive's synchronous confirms runs
- **THEN** the confirm fails and neither paste nor Enter is issued

#### Scenario: PID reuse is caught by the command-line re-check
- **GIVEN** a send attempt whose detected pid now maps to a different command line (no codex `--remote`, or a different `xats.agent_id`)
- **WHEN** any of the primitive's synchronous confirms runs
- **THEN** the confirm fails and neither paste nor Enter is issued

#### Scenario: A foreground-probe error blocks the send
- **GIVEN** a send attempt whose synchronous `ps` probe fails (error, timeout, or EPERM)
- **WHEN** any of the primitive's synchronous confirms runs
- **THEN** the unknown state reads as not-safe and neither paste nor Enter is issued

#### Scenario: Probe infrastructure errors are logged once and redacted
- **GIVEN** a scheduled recovery poke whose tty process listing keeps throwing an error message embedding the identity key value
- **WHEN** poll iterations continue
- **THEN** exactly one debug line for that stage is logged naming the pane, the stage, and the error class
- **AND** the identity key value is replaced by `[redacted]` and never appears in any log line

#### Scenario: Holder drift before send cancels the schedule
- **GIVEN** a scheduled recovery poke for pane `%1972` resolved to holder `aoe-codex(aoe)`
- **WHEN** before the send `identity_key="K1"` no longer resolves to the same agent row (moved, deleted, or renamed) or the holder process is alive again
- **THEN** the schedule is cancelled and no poke is sent
- **AND** the skip is logged without the key value

#### Scenario: A backgrounded codex at send time returns the schedule to polling
- **GIVEN** a send attempt for pane `%1972` whose write-time carrier proof refuses at a pre-write checkpoint because the detected codex is live on the tty but not the foreground group (`pgid != tpgid`)
- **AND** the pre-reg row is still current and the holder still resolves unchanged and dead
- **WHEN** the refusal aborts with nothing written
- **THEN** the schedule generation is not retired: the pane re-enters the polling loop with the same generation
- **AND** polling keeps retrying on the normal interval until the row expires, is overwritten, or is consumed

#### Scenario: Foregrounding within the TTL delivers on a later iteration
- **GIVEN** a recovery schedule returned to polling by a backgrounded-codex refusal
- **WHEN** the codex process becomes the tty's foreground group again before row expiry
- **THEN** a later poll iteration delivers the recovery poke exactly once

#### Scenario: Expiry while still backgrounded retires the schedule
- **GIVEN** a recovery schedule returned to polling by a backgrounded-codex refusal
- **WHEN** the pre-reg row expires before the codex returns to the foreground
- **THEN** polling stops, the generation is retired, and no poke is sent

#### Scenario: A quiet-guard failure resumes polling and delivers on the next iteration
- **GIVEN** a recovery poke for pane `%1972` whose first send fails the quiet guard because the codex TUI is still drawing its boot screen
- **WHEN** the refusal aborts with nothing written
- **THEN** the schedule returns to the detection polling loop with the same generation
- **AND** the next poll iteration (one probe interval later, not a 30s ladder rung) repeats the full guard, re-probe, re-verify, paste sequence and delivers exactly once when the pane is quiet

#### Scenario: Repeated guard failures poll until row expiry
- **GIVEN** a recovery schedule whose quiet guard keeps failing on every iteration
- **WHEN** the pre-reg row expires before the guard ever passes
- **THEN** polling stops, the generation is retired, and no poke is sent

#### Scenario: A transient refusal on a superseded generation resumes nothing
- **GIVEN** an old-generation send attempt whose quiet guard failed or whose carrier proof observed a backgrounded codex
- **WHEN** an overwriting pre-register retires that generation before the refusal unwinds
- **THEN** the old generation resumes no polling and pastes nothing
- **AND** the new generation's schedule survives untouched

#### Scenario: Polling-resumed attempts repeat the full send sequence
- **GIVEN** a recovery schedule returned to polling by a transient refusal
- **WHEN** a later poll iteration fires
- **THEN** the attempt runs detection, guard, codex process re-probe, row currency re-check, holder re-resolution, and pane-host verification before pasting
- **AND** a stale row, missing process, or drifted holder retires the generation instead of pasting

#### Scenario: Expiry terminates polling
- **GIVEN** a scheduled recovery poke whose pre-reg row has `expires_at` in the past
- **WHEN** the next poll iteration runs
- **THEN** polling stops and no poke is sent

### Requirement: Codex tmux fallback demands the foreground-carrier proof at every write checkpoint

When a poke to a target whose EFFECTIVE agent type resolves to codex falls back to tmux injection and the target row has a bound `runtime_ui_pid`, the pre-write ownership confirm that the shared tmux poke primitive evaluates at ALL THREE write checkpoints (pre-capture, immediately before the paste, and immediately before the Enter keypress) SHALL — in addition to the DB ownership read — require the TARGET-side foreground-carrier proof for that `runtime_ui_pid` on the pane's tty: the pane tty resolved synchronously, then a synchronous bounded-timeout `ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=` probe showing the pid with a STAT containing none of `T`/`t`/`Z`, a current command still matching codex `--remote` (the stored pre-reg uuid is not available on this path; the command-level match suffices), and `pgid == tpgid`.  ANY probe error, timeout, or unresolvable pane tty SHALL read as not-safe: nothing is captured, pasted, or executed.  The effective agent type SHALL be resolved with the SAME semantics the transport dispatcher routes by: the stored `agent_type` when present, otherwise inferred from the delivery kind (`codex-appserver` implies codex) — so legacy rows with `agent_type=NULL` and a codex-appserver delivery are covered and cannot bypass the proof on their tmux fallback.  Targets whose effective type resolves to codex but without a bound `runtime_ui_pid`, and targets whose effective type is not codex, SHALL keep the existing DB-only confirm behavior (the analogous hazard for claude/other TUI targets is a known follow-up, out of scope for this change).

#### Scenario: A backgrounded codex with a foreground shell never receives a wake
- **GIVEN** a codex agent row bound to pane `%10` with `runtime_ui_pid=12345`
- **AND** the pane's tty lists `12345 12345 555 S codex --remote ...` and `555 555 555 S+ -zsh`
- **WHEN** an ordinary poke to that agent falls back to tmux injection
- **THEN** the wake is not pasted and no Enter is sent

#### Scenario: A codex backgrounded during the paste settle window loses the Enter
- **GIVEN** a codex tmux fallback whose pre-capture and pre-paste confirms passed
- **WHEN** the codex process is backgrounded (the shell takes the tty's foreground group) before the pre-Enter confirm
- **THEN** the Enter keypress is not sent and the attempt reports `ownership_lost`
- **AND** the pasted-but-unexecuted text is never executed by the daemon

#### Scenario: A foreground codex passes all three checkpoints
- **GIVEN** a codex agent row bound to a pane whose `runtime_ui_pid` is the pane tty's foreground `codex --remote` process
- **WHEN** an ordinary poke falls back to tmux injection
- **THEN** the carrier probe is evaluated at each of the three checkpoints
- **AND** the wake is pasted and executed normally

#### Scenario: A legacy NULL agent_type row with a codex-appserver delivery still demands the proof
- **GIVEN** a legacy agent row with `agent_type=NULL`, a `codex-appserver` delivery, a bound pane and `runtime_ui_pid=12345`
- **AND** the pane's tty lists the codex backgrounded (`12345 12345 555 S codex --remote ...`) with a foreground shell
- **WHEN** the app-server dispatch fails with an ordinary error and the poke falls back to tmux injection
- **THEN** the effective agent type resolves to codex and the carrier proof is required
- **AND** the wake is neither pasted nor executed

#### Scenario: A carrier-probe failure blocks the write
- **GIVEN** a codex tmux fallback whose synchronous tty resolution or ps probe fails (error, timeout, or missing tty)
- **WHEN** any of the primitive's confirms runs
- **THEN** the unknown state reads as not-safe and neither paste nor Enter is issued

#### Scenario: Non-codex targets keep the DB-only confirm
- **GIVEN** a claude-code agent row bound to a pane
- **WHEN** a poke falls back to tmux injection
- **THEN** the write checkpoints run the existing DB ownership confirm without consulting any carrier probe

### Requirement: Recovery poke wording guides re-registration with the recovered identity

The recovery poke content SHALL be a daemon-side fixed template that identifies itself as a cross-agent-teams recovery notice, states the recovered `(team, name)`, and instructs the codex agent to call `register_agent` with `agent_type="codex"`, that `name` and `team`, and `thread_id` read from `$CODEX_THREAD_ID`.  The template MUST NOT contain the `identity_key` value.

#### Scenario: Wording carries identity but never the key
- **GIVEN** a recovery poke on behalf of `aoe-codex(aoe)` triggered by `identity_key="K1"`
- **WHEN** the poke content is composed
- **THEN** it names `aoe-codex` and team `aoe` and instructs a `register_agent` call with `thread_id` from `$CODEX_THREAD_ID`
- **AND** the string `K1` does not appear in the content

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
