# agent-registry Delta

## ADDED Requirements

### Requirement: Pre-registration reports where it landed and what it received

`pre_register_codex_pane` SHALL report, on success, the field names it actually received and whether the named `pane_id` is currently visible to the daemon on the daemon's own tmux server; the CLI SHALL additionally print the daemon endpoint it resolved.

A pre-registration can be authenticated, succeed, and still have reached a daemon nobody intended.  With neither `--port` nor `--token`, the endpoint comes from `CROSS_AGENT_TEAMS_MCP_HOME`'s pid file and the inherited token, so an environment that isolates tmux but not xats reaches the default daemon.  Measured 2026-08-01: an e2e fixture on a private tmux socket wrote its rows into the production database this way, received `{ ok: true }`, and neither side had any signal — the rows were found from the other end days later while investigating an unrelated recovery failure.

The three signals answer three independent questions and SHALL NOT be collapsed into one: which daemon received the call, whether the arguments survived the trip, and whether the write and the pane are on the same side of an isolation boundary.  A cached CLI build silently dropping an argument has already occurred once in production, so endpoint reporting alone is not sufficient.

Pane visibility SHALL be REPORTED and SHALL NOT be enforced.  Refusing an invisible pane would make the write depend on the daemon's own tmux resolution, which is precisely what is misconfigured in the case this exists to expose; a daemon whose environment resolves a different server would then reject every pre-registration on that host.  A diagnostic that can misfire SHALL NOT be load-bearing.

The endpoint report SHALL carry host and port only.  It SHALL NOT carry the token, nor its length, nor a hash of it: the token is already readable by anything that can read the app-server environment, and this SHALL NOT add a second exposure.

#### Scenario: A pre-registration for a pane the daemon cannot see still succeeds, and says so

- **GIVEN** a launcher pre-registering `%0`, where the daemon's own tmux server has no pane `%0`
- **WHEN** the call succeeds
- **THEN** the response records that the pane is not visible to the daemon
- **AND** the row is written exactly as it is today

#### Scenario: The received field set comes back

- **GIVEN** a launcher calling with `pane_id`, `xats_agent_id` and `identity_key`
- **WHEN** the call succeeds
- **THEN** the response names those fields as received, so a dropped argument is visible to the caller

#### Scenario: An omitted optional field is reported as not received

- **GIVEN** a launcher calling with `pane_id` and `xats_agent_id` only
- **WHEN** the call succeeds
- **THEN** `identity_key` is absent from the reported field set

#### Scenario: The CLI names the endpoint it resolved

- **GIVEN** `pre-register-codex-pane` invoked with neither `--port` nor `--token`
- **WHEN** the call completes
- **THEN** the printed result includes the resolved host and port
- **AND** it includes no token value, no token length and no token hash

### Requirement: A pending pre-reg blocks a pane on row existence, not on carrier evidence

The `detect_tmux_pane` fallback's refusal SHALL continue to key on the EXISTENCE of an unexpired pre-registration row for that `pane_id`.  It SHALL NOT be narrowed to rows whose `xats_agent_id` is observable on that pane's carrier.

This is stated as a requirement rather than left implicit because the narrowing is the natural repair for a real defect — a tmux pane id is unique per SERVER, so a foreign server's row can refuse an identically-numbered pane on this one — and it must not be re-proposed.  The window the refusal protects is the one after a launcher announces a pane and before that pane's codex registers, which in the production launch shape is before `exec codex` has replaced the launcher shell at all.  In that window the pane's tty hosts `sh`, the row's uuid is legitimately absent, and requiring it would switch the protection off exactly where it is meant to apply.  A foreign row and a not-yet-`exec`'d legitimate row are indistinguishable to that probe: the difference is which tmux server the pane belongs to, which is the dimension the key does not carry.

Closing the cross-server collision therefore requires the scope key, not a better predicate.  The scope key is not adopted here; its revisit criterion is an OBSERVED overwrite of a legitimate row by a foreign write during that window.

#### Scenario: A pane announced but not yet running codex is still protected

- **GIVEN** an unexpired pending pre-reg row for `%7` whose launcher has not yet `exec`-ed codex, so no process on `%7` carries the row's uuid
- **WHEN** an unrelated codex registration reaches the `detect_tmux_pane` fallback for `%7`
- **THEN** the bind is refused with the existing reason, and the row remains pending
