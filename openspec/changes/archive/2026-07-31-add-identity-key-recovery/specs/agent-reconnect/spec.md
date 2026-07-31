## ADDED Requirements

### Requirement: reconnect recovers identity by identity_key

`reconnect` SHALL accept an optional `identity_key` and, when it is supplied, resolve the prior `(team, name)` by reverse-looking-up the agents table on `identity_key`.  The lookup MUST be constrained to the daemon's configured local device label and MUST exclude `__channel_proxy__` rows, exactly as the three existing lookups are.

Unlike the process-scoped lookups, this key survives a pane restart.  That is its entire purpose: after a restart the Claude UI pid is different, the codex thread id is different, and the agent no longer remembers its own `(team, name)`, so no existing lookup can recover the identity.

On a single match the daemon SHALL re-establish the identity through the same `register_agent` path the other reconnect arms use — same takeover, same channel rebind, same pane rebind, same preserved `agent_id` and unread cursor.  `reconnect` MUST NOT introduce a separate recovery mechanism for this key.

On zero matches the daemon SHALL return the existing `need_register` envelope.  A key that no longer resolves is a normal state, not an error: the database may have been reset, the row may have been removed, or this may be the pane's first launch.  The `ambiguous` branch is unreachable for this lookup because `UNIQUE(device, identity_key)` admits at most one match; the daemon SHALL nonetheless not silently pick a row if more than one is somehow returned.

#### Scenario: Identity recovered after a restart

- **GIVEN** a row on device `D` with `(team='aoe', name='tester')`, `agent_id='X'`, and `identity_key='K'`
- **AND** the pane has been restarted, so neither its prior `runtime_ui_pid` nor its prior conversation exists
- **WHEN** a fresh MCP session calls `reconnect({identity_key: 'K', ui_pid: <new pid>})`
- **THEN** the response carries `(team='aoe', name='tester')` and `agent_id='X'`
- **AND** the row keeps its `agent_id` and its `last_processed_event_id`
- **AND** the calling session is bound to that identity

#### Scenario: Unknown key asks for registration

- **GIVEN** no row on device `D` holds `identity_key='K'`
- **WHEN** a caller invokes `reconnect({identity_key: 'K', ui_pid: 4242})`
- **THEN** the response indicates `need_register` with a human-readable reason
- **AND** no agents row is created or mutated

#### Scenario: Lookup does not cross devices

- **GIVEN** a row holding `identity_key='K'` whose `device` differs from the daemon's local device label
- **WHEN** a caller invokes `reconnect({identity_key: 'K', ...})`
- **THEN** that row is not matched
- **AND** the response indicates `need_register`

#### Scenario: Channel proxy rows are never matched

- **GIVEN** a `__channel_proxy__` row that somehow carries an identity key
- **WHEN** a caller reconnects by that key
- **THEN** the proxy row is not considered a match

### Requirement: identity_key composes with ui_pid and thread_id instead of excluding them

`identity_key` SHALL NOT join the existing "exactly one of `ui_pid`, `thread_id`, or `base_url`" mutual-exclusion group.  It answers a different question from the others — *which identity* rather than *which live runtime* — so it MUST be combinable with one of them in a single call:

- `reconnect({identity_key, ui_pid})` is the claude-code shape.  The key resolves the identity; the `ui_pid` refreshes the pane, tty, and pid binding and rebinds the channel session id in the same call, so no window exists in which the recovered identity still points at the dead pane.
- `reconnect({identity_key, thread_id})` is the codex shape.  The key resolves the identity; the thread id is the *new* thread produced by the restart and rewrites the delivery payload.  `ui_pid` MUST remain absent here, because supplying it disables the launcher's pane pre-registration path — the pane binding instead falls through to the existing pending-pre-reg lookup.

When `identity_key` is present it SHALL take precedence for identity resolution: the accompanying `ui_pid` or `thread_id` is used only for rebinding, never as a competing identity lookup.  When it is absent, all existing arms behave exactly as before.

#### Scenario: claude shape refreshes the pane in one call

- **GIVEN** a row with `identity_key='K'` whose `tmux_pane_id` points at a pane that no longer exists
- **WHEN** the restarted agent calls `reconnect({identity_key: 'K', ui_pid: <its new $PPID>})`
- **THEN** the identity is resolved from `K`
- **AND** `tmux_pane_id`, `runtime_tty`, and `runtime_ui_pid` are overwritten with the values verified from the new pid
- **AND** the channel session id is rebound to the current proxy's csid

#### Scenario: codex shape rewrites delivery without a ui_pid

- **GIVEN** a row with `identity_key='K'` and delivery `{kind: 'codex-appserver', thread_id: 'T-old'}`
- **WHEN** the restarted codex agent calls `reconnect({identity_key: 'K', thread_id: 'T-new'})` with no `ui_pid`
- **THEN** the identity is resolved from `K`
- **AND** the delivery payload's `thread_id` becomes `T-new`
- **AND** pane binding is attempted through the pending pre-registration path rather than through a supplied pid

#### Scenario: The key wins over the accompanying runtime key

- **GIVEN** a row `A` holding `identity_key='K'` and an unrelated row `B` whose `runtime_ui_pid` equals the caller's `ui_pid`
- **WHEN** a caller invokes `reconnect({identity_key: 'K', ui_pid: <that pid>})`
- **THEN** the recovered identity is row `A`'s, not row `B`'s

#### Scenario: Existing single-key calls are unchanged

- **WHEN** a caller invokes `reconnect({ui_pid})`, `reconnect({thread_id})`, or `reconnect({base_url, session_id})` with no `identity_key`
- **THEN** the behaviour is identical to before this change, including the exactly-one validation among those three

## MODIFIED Requirements

### Requirement: reconnect tool description guides invocation on reconnect phrases

The `reconnect` tool's MCP description SHALL instruct the agent to invoke it when the user asks to reconnect or re-register to xats — covering at least the phrases "reconnect xats", "re-register xats", "重连 xats", and "重新注册 xats" — passing the Claude UI process id (`$PPID`) as `ui_pid`. The description SHALL ALSO route automatic re-establishment by a three-way branch, evaluated in order:

- **First**, when an `XATS_IDENTITY_KEY` is available in the environment, the description SHALL guide `reconnect({identity_key, ui_pid: $PPID})` (or `{identity_key, thread_id}` for codex) *before* considering the other two branches, and SHALL state that on a `need_register` result the agent asks the user for `(team, name)` as usual and passes the same `identity_key` on that `register_agent` call.  This branch MUST come first because after a restart the agent both holds a key and does not remember its `(team, name)`, so the two later branches would otherwise capture the case and fail.
- When there is no identity key and the agent does NOT remember its `(team, name)` (for example after a context clear, where `$PPID` is unchanged), the description SHALL guide `reconnect({ ui_pid: $PPID })` as the path to recover identity by process id and rebind the new `channel_session_id` in one step, preferred over the `bind_channel`→`register_agent` fallback.
- When there is no identity key and the agent DOES remember its `(team, name)` (for example after closing Claude Code and resuming the conversation, where `$PPID` has changed but the context survived), the description SHALL guide `register_agent` with the remembered `(team, name)` and the current `$PPID` instead of `reconnect` — because `reconnect` reverse-looks-up the changed `$PPID`, finds no match, and returns `need_register`.

The description MUST NOT route the later two branches on whether `$PPID` is unchanged, a condition the agent cannot self-evaluate.

#### Scenario: Description lists the trigger phrases and the ui_pid source

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it names the reconnect/re-register trigger phrases (including the Chinese "重连 xats" / "重新注册 xats")
- **AND** it states that `ui_pid` is the Claude UI process id (`$PPID`)
- **AND** it states that `reconnect` is the path to re-establish after a context clear when the agent no longer remembers its `(team, name)` and `$PPID` is unchanged

#### Scenario: Description routes remembered-identity resume to register, not reconnect

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it states that an agent which still remembers its `(team, name)` after a restart + resume (changed `$PPID`) should `register_agent` with that remembered identity rather than call `reconnect`
- **AND** it does NOT instruct the agent to use `reconnect` "even when it still remembers its `(team, name)`"

#### Scenario: Description puts the identity key branch first

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it contains the literal substring `XATS_IDENTITY_KEY`
- **AND** the identity-key branch is presented ahead of the remembers / does-not-remember branches
- **AND** it states that a `need_register` result means asking the user for `(team, name)` and passing the same key on the subsequent `register_agent`
