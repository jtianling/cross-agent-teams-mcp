## ADDED Requirements

### Requirement: Codex-targeted tmux injection demands positive evidence of an idle composer

A tmux injection aimed at a codex pane SHALL NOT be written unless the pane presents positive evidence that it is sitting at an idle codex composer.  The quiet guard is not that evidence: it establishes only that the pane tail did not change across `POKE_QUIET_MS`, and a blocking TUI menu awaiting a keypress is quieter than a live prompt.  Because the injection ends in an unconditional `Enter`, a pane that is quiet for any other reason receives that keypress as an answer to whatever it is actually asking.

The predicate SHALL be an allowlist over the pane's rendered tail — it recognises the codex composer — and SHALL NOT be a denylist of known-dangerous screens.  A denylist is bound to the wording of the specific screens enumerated and leaves every other blocking prompt (a package-manager confirmation, an ssh host-key prompt, a credential prompt) accepted by default.  The two error directions are not symmetric: an allowlist that wrongly refuses leaves the pane unrecovered, which is logged, retried, and bounded by the pre-registration row's expiry, whereas an acceptance that is wrong executes an irreversible keypress in a pane the daemon does not understand.

The predicate SHALL be supplied by the codex-side callers as an option on the shared tmux poke primitive, evaluated after the quiet guard and the pre-write ownership read, on the pane tail the primitive already captures before writing, and before the buffer is loaded.  A caller that supplies no predicate SHALL be unaffected: the shared quiet guard's own behaviour SHALL NOT change, because it also serves panes whose ready state is not a codex composer.

A refusal SHALL report a reason distinct from the quiet-guard failure, and SHALL leave the pane untouched — no buffer loaded, no paste, no `Enter`.  The distinction is required because this predicate has a failure mode the quiet guard does not: were the composer's rendering to change, every codex pane would be refused at once, and a shared reason would describe that outage as "the screen was still changing" and send diagnosis in the wrong direction.

Any error, timeout, or otherwise unreadable capture underlying the predicate SHALL read as not-ready, consistent with the fail-closed rule the write-checkpoint probes already follow.

#### Scenario: A blocking startup menu is refused

- **GIVEN** a codex-targeted injection for a pane whose tail shows a blocking startup menu awaiting a keypress
- **AND** the tail is unchanged across the quiet window, so the quiet guard passes
- **WHEN** the send attempt runs
- **THEN** the prompt-readiness predicate refuses and nothing is written into the pane — no buffer, no paste, no `Enter`
- **AND** the refusal is reported under its own reason, not the quiet-guard one

#### Scenario: An idle composer is accepted

- **GIVEN** a codex-targeted injection for a pane whose tail presents an idle codex composer
- **WHEN** the send attempt runs and every ownership and carrier check passes
- **THEN** the predicate accepts and the paste proceeds through the unchanged write sequence

#### Scenario: A caller supplying no predicate is unaffected

- **GIVEN** a tmux injection aimed at a non-codex pane, dispatched without a readiness predicate
- **WHEN** the send attempt runs
- **THEN** the primitive behaves exactly as before, gated by the quiet guard and the ownership reads alone

#### Scenario: An unreadable capture reads as not-ready

- **GIVEN** a codex-targeted injection whose pre-write pane capture errors or times out
- **WHEN** the send attempt runs
- **THEN** the state reads as not-ready and neither paste nor `Enter` is issued

## MODIFIED Requirements

### Requirement: Recovery poke first send is gated on codex process detection

The scheduled recovery poke MUST NOT be sent while the pre-registered pane may still be running a shell.  The daemon SHALL poll (bounded interval) the pane's tty using the same probing primitives as codex auto-bind (`tmux list-panes`, `ps -t <tty>`, codex `--remote` process recognition, argv containing `xats.agent_id="<stored uuid>"`), and SHALL send the first poke only after a matching codex process is detected; a candidate line whose STAT contains `T`, `t`, or `Z` (stopped, traced, or zombie) SHALL NOT count as a detection — the shell owns the tty again — and the auto-bind candidate filter that shares these primitives SHALL apply the full foreground-carrier acceptance (STAT, command with stored uuid, and `pgid == tpgid`; see the agent-registry auto-bind requirement).  A wrapper-launched codex produces MULTIPLE matching lines on one tty (for example a `node .../bin/codex --remote` process-group leader plus its native child); detection SHALL collapse same-process-group matches exactly like auto-bind: all matches sharing one pgid whose group is the tty's foreground group (`pgid == tpgid` on every matching line) count as ONE detection whose pid is the group leader (`pid == pgid`) — wrapper plus child is one candidate, leader pid wins.  A same-group set without a leader line detects nothing (fail-closed), and matches spanning DIFFERENT pgids remain ambiguous and detect nothing; a non-collapsing multi-line outcome SHALL be logged at debug level once per schedule generation per reason with the pane id, matching-line count, and distinct-pgid count — never argv contents, never the key value.  The write-time carrier proof evaluates the chosen (leader) pid's own ps line, which MAY be the wrapper form (`node ... codex --remote ...`); sibling group members on the same tty do not affect the per-pid classification.  A probe infrastructure exception (pane listing or tty process listing) SHALL be logged at debug level once per stage per schedule — naming the pane, the stage, and the error class, with the identity key value redacted from the message — so a broken probe is distinguishable from ordinary not-yet-detected polling; the key value SHALL never appear in any log line.  Each poll iteration SHALL first check row currency (full-snapshot, see the lifecycle requirement) and SHALL re-resolve the holder via `findByIdentityKey`, requiring the same `agent_id`, `team`, and `name` as at schedule time and a still-dead holder process (holder-side liveness keeps the conservative `process.kill(pid, 0)` semantics, EPERM reads as alive); on a miss, any change, or a holder back alive, the schedule SHALL be cancelled with a debug log that never contains the key value.  Every send attempt SHALL run the quiet guard FIRST; only after the guard passes SHALL the daemon re-probe the codex process (a vanished process or a changed pid cancels the send without pasting), re-check row currency, re-resolve the holder, and run pane-host verification.  The paste SHALL additionally carry the prompt-readiness predicate defined by the codex-targeted injection requirement, so that a pane which is quiet for a reason other than an idle codex composer — a blocking startup menu being the observed case — is refused before anything is written.  The paste SHALL go through the shared tmux poke primitive carrying a composite synchronous confirm predicate — schedule generation not cancelled, row snapshot still current, holder tuple unchanged and still dead, and a TARGET-side foreground-carrier proof — which the primitive SHALL evaluate synchronously before anything is written (pre-capture), immediately before the paste, AND once more immediately before the Enter keypress: a failure before the paste aborts with nothing written, and a failure between paste and Enter aborts with a distinct `ownership_lost` error, leaving the pasted text unexecuted (pasted-but-unexecuted is acceptable; executing it is not).  The foreground-carrier proof SHALL demand positive evidence via a synchronous, bounded-timeout `ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=` probe: the detected codex pid present on the pane's tty with a STAT containing none of `T`/`t`/`Z`, its current command line still matching codex `--remote` with the stored `xats.agent_id="<uuid>"` (guarding against PID reuse), and its process group equal to the tty's foreground process group (`pgid == tpgid`).  Pid liveness alone (`process.kill(pid, 0)`) SHALL NOT satisfy the target-side predicate: a SIGSTOP-ed codex keeps the pid alive while the shell is foreground.  ANY probe error, timeout, EPERM, missing column, or otherwise unknown state SHALL read as not-safe: no paste, no Enter.  The poke content SHALL be built from the freshly resolved holder at send time.  Transient refusals SHALL NOT retire the schedule generation and SHALL NOT enter any long-backoff retry ladder.  Three refusals are transient: a quiet-guard failure on a send attempt (the common case right after a codex restart, while the TUI is still drawing its boot screen), a write-checkpoint refusal with nothing yet written whose ONLY failing leg is the foreground-carrier proof observing a live-but-backgrounded codex (present on the tty, STAT free of `T`/`t`/`Z`, command still matching with the stored uuid, but `pgid != tpgid`), and a prompt-readiness refusal, which is reported under its own reason and MUST NOT be folded into the quiet-guard one.  Any of these refusals returns the pane's schedule to the detection polling loop with the SAME generation token (no new generation, exactly one live schedule entry per pane, so overwrite/consumption cancellation still targets it); every subsequent poll iteration repeats the FULL detect, guard, re-probe, re-verify, paste sequence, so the retry cadence is the probe interval, bounded by the pre-reg row lifecycle — polling continues until the row expires, is overwritten, or is consumed.  A refusal observed by a cancelled or superseded generation resumes nothing and MUST NOT touch a newer generation's schedule.  Recovery lifecycle logging SHALL carry an ISO timestamp on every line: scheduling (with the holder identity), the first detection of a codex pid (once per distinct pid per generation), each transient-resume transition (at most once per consecutive streak of one reason — the streak marker resets when that stage passes again, so a relapse logs anew), delivery, and terminal cancellations with their reason; no line ever contains the key value or argv contents.  All other send outcomes remain terminal for the generation as before: delivered, `ownership_lost` after the paste (even on a carrier refusal), a vanished or restarted codex process, a stale row, holder drift, a probe hard error, and cancellation.

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


#### Scenario: A blocking startup menu never receives the recovery Enter

- **GIVEN** a scheduled recovery poke for pane `%9` whose codex process is detected
- **AND** the pane is displaying a blocking startup menu whose default action would terminate codex
- **WHEN** the send attempt runs and the quiet guard passes on the motionless menu
- **THEN** the prompt-readiness predicate refuses and nothing is pasted into `%9`
- **AND** the schedule returns to the detection polling loop with the same generation token

#### Scenario: A prompt-readiness refusal is logged apart from a quiet-guard failure

- **GIVEN** a recovery schedule whose send attempts are refused by the prompt-readiness predicate on every poll iteration
- **WHEN** the refusals repeat
- **THEN** the resume transition is logged under a reason naming the readiness refusal, never as a quiet-guard failure
- **AND** the streak logs at most once, resetting when the predicate passes again
