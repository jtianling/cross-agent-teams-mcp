## ADDED Requirements

### Requirement: Pane binding is exclusive per device with last-writer-wins

A tmux pane hosts exactly one agent UI at a time, so at most one agent row per device SHALL hold any given `tmux_pane_id`.  Whenever a runtime-binding path persists `tmux_pane_id = P` for agent A on device D — `bind_runtime_identity`, the codex pending pre-reg auto-bind, or any other writer of that column — the daemon SHALL, in the same transaction, clear `tmux_pane_id` on every other row with the same `(device, P)`.

The new binding wins.  The daemon SHALL NOT reject the new binding in favour of an incumbent row: the physical fact is that the registering process occupies the pane, and refusing it would leave the live agent unreachable while keeping a dead row addressable — trading a wrong wake-up for a missed one.

Clearing an incumbent's `tmux_pane_id` SHALL NOT delete its row, change its `agent_id`, or touch its mailbox, unread cursor, or `delivery`.  An incumbent that is in fact still alive re-binds its pane on its next registration.

#### Scenario: New binding unbinds the incumbent on the same pane

- **GIVEN** agent A on device `jt` holds `tmux_pane_id='%19'`
- **WHEN** agent B on device `jt` binds `tmux_pane_id='%19'`
- **THEN** B's row holds `%19`
- **AND** A's row has `tmux_pane_id = NULL`
- **AND** A's `agent_id`, mailbox, unread cursor, and `delivery` are unchanged

#### Scenario: Same pane id on a different device is untouched

- **GIVEN** agent C on device `gx` holds `tmux_pane_id='%19'`
- **WHEN** agent B on device `jt` binds `tmux_pane_id='%19'`
- **THEN** C's row still holds `%19`

#### Scenario: Rebinding the same agent to the same pane is idempotent

- **GIVEN** agent B on device `jt` holds `tmux_pane_id='%19'`
- **WHEN** B binds `%19` again
- **THEN** B's row still holds `%19` and no other row is modified

#### Scenario: At most one row per device per pane holds a binding

- **GIVEN** any sequence of runtime bindings has been applied
- **WHEN** the `agents` table is grouped by `(device, tmux_pane_id)` over non-null pane ids
- **THEN** no group has more than one row

## MODIFIED Requirements

### Requirement: Agent liveness is process-based

The daemon SHALL determine an agent's liveness (the `online` flag) via an `isAgentLive(agent)` predicate keyed on process existence rather than a fixed `last_seen_at` recency window. The predicate resolves in order, first match wins:

1. **Local device + `runtime_ui_pid` set** → the agent is live iff that process is running (`process.kill(pid, 0)`; an `EPERM` error means the process exists and MUST be treated as live).
2. **Local device + `tmux_pane_id` set** (and no usable `runtime_ui_pid`) → the agent is live iff that pane still exists in the current tmux pane set. When tmux is unavailable, this rule does not apply and resolution falls through to rule 3.
3. **Otherwise** (remote device, or local with neither pid nor pane) → the agent is live iff `last_seen_at >= now - REACHABLE_MS`, where `REACHABLE_MS` is a day-level window (default 4 days) defined in `src/storage/agents-repo.ts`.

The legacy 5-minute `ONLINE_MS` window MUST NOT be used for the `online` flag.

`isAgentLive` MUST NOT be required for **message delivery**: a message SHALL be persisted to its recipient's mailbox regardless of that recipient's liveness, and fan-out SHALL NOT filter recipients by `online`.  This is deliberate — an offline agent reads its mail when it returns.

That guarantee covers mailbox persistence only.  It does NOT license writing to a physical terminal that the target no longer occupies: tmux injection is separately gated by "Tmux injection verifies the pane's current host" in `agent-delivery`.  The two are distinct — mailbox rows are addressed to a registered identity, tmux panes are addressed to a physical resource whose ownership changes.

#### Scenario: Local agent with a live pid is online despite long idleness

- **GIVEN** a local-device agent with `runtime_ui_pid` pointing at a running process and `last_seen_at = now - 10 days`
- **WHEN** liveness is evaluated
- **THEN** the agent is `online: true`

#### Scenario: Local agent with a dead pid is offline

- **GIVEN** a local-device agent with `runtime_ui_pid` pointing at a process that is not running
- **WHEN** liveness is evaluated
- **THEN** the agent is `online: false`

#### Scenario: Remote agent falls back to a day-level last_seen window

- **GIVEN** a remote-device agent (the daemon cannot probe its pid) with `last_seen_at = now - 2 days` and `REACHABLE_MS = 4 days`
- **WHEN** liveness is evaluated
- **THEN** the agent is `online: true`
- **AND** the same agent with `last_seen_at = now - 5 days` evaluates to `online: false`

#### Scenario: Offline recipient still receives its mailbox row

- **GIVEN** a recipient evaluating to `online: false`
- **WHEN** a sender sends it a message
- **THEN** the message is persisted to its mailbox
- **AND** the recipient reads it on its next `get_inbox`

### Requirement: Tmux pane id persistence

The daemon MUST NOT auto-detect and persist `tmux_pane_id` during `register_agent`.  Instead, tmux pane binding is written only by explicit runtime-binding paths after registration.  `register_agent` may still succeed with `tmux_pane_id = NULL`.

Every such write SHALL additionally enforce "Pane binding is exclusive per device with last-writer-wins".

#### Scenario: register_agent succeeds without auto-detecting a pane

- **GIVEN** a caller invokes `register_agent({ model, name: 'alice' })`
- **WHEN** the daemon processes the registration
- **THEN** the call succeeds
- **AND** the row may still have `tmux_pane_id = NULL`
- **AND** the success hint directs the caller to `bind_runtime_identity(...)`

### Requirement: bind_runtime_identity verifies and persists tmux runtime identity

The daemon SHALL expose `bind_runtime_identity({ agent, ui_pid?, ui_tty?, tmux_pane_id?, process_pattern? })` for registered callers.

The tool SHALL require one of:

1. `ui_pid`
2. `ui_tty` together with `tmux_pane_id`

If `ui_pid` is supplied, the daemon SHALL:

1. Read the process tty and command from the local host.
2. Verify the command matches the declared agent kind and is not a known helper process for that agent.
3. Resolve the tty to a tmux pane.
4. Persist the verified `tmux_pane_id`, `runtime_ui_pid`, `runtime_tty`, `runtime_verification_mode`, and `runtime_bound_at`, clearing any other row's binding on that `(device, pane)` per "Pane binding is exclusive per device with last-writer-wins".

If `ui_tty + tmux_pane_id` are supplied, the daemon SHALL:

1. Verify the pane exists and its tty equals `ui_tty`
2. Verify that tty hosts a process matching the declared agent kind and not only helper processes for that agent
3. Persist the same runtime metadata, with `runtime_ui_pid = NULL`, under the same exclusivity rule

#### Scenario: bind_runtime_identity succeeds via ui_pid

- **GIVEN** caller `alice` is already registered
- **AND** `ui_pid` belongs to a Codex UI process whose tty maps to pane `%1902`
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'codex', ui_pid: 81979 })`
- **THEN** the response is `{ ok: true, tmux_pane_id: '%1902', verification_mode: 'verified_pid_tty_pane', tty: 'ttys026', ui_pid: 81979 }`
- **AND** the caller row persists `tmux_pane_id='%1902'`

#### Scenario: bind_runtime_identity rejects Codex helper process ids

- **GIVEN** caller `alice` is already registered
- **AND** `ui_pid` belongs to `codex app-server` whose tty maps to pane `%1993`
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'codex', ui_pid: 23201 })`
- **THEN** the response is `{ error: 'agent_process_mismatch' }`
- **AND** the caller row does not persist pane `%1993`
- **AND** no incumbent binding on `%1993` is cleared, because the rejected call persists nothing

#### Scenario: bind_runtime_identity succeeds via ui_tty plus pane id

- **GIVEN** caller `alice` is already registered
- **AND** pane `%1916` exists with tty `ttys020`
- **AND** tty `ttys020` hosts a matching Claude process
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'claude-code', ui_tty: '/dev/ttys020', tmux_pane_id: '%1916' })`
- **THEN** the response is `{ ok: true, tmux_pane_id: '%1916', verification_mode: 'verified_tty_pane', tty: 'ttys020' }`
- **AND** the caller row persists `tmux_pane_id='%1916'`
- **AND** any other row on the same device previously holding `%1916` now has `tmux_pane_id = NULL`
