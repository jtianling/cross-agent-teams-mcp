## ADDED Requirements

### Requirement: Session delivery coordinates are exclusive per device with last-writer-wins

A codex thread and a claude channel session each belong to exactly one live conversation, so at most one non-proxy agent row per device SHALL hold any given delivery coordinate of these two kinds:

- `delivery.kind='codex-appserver'` — the coordinate is `thread_id` (`ws_url` is not part of it);
- `delivery.kind='claude-channel'` — the coordinate is `channel_session_id`.

Whenever any path persists such a delivery on agent A on device D — `register_agent`, `reconnect`, `bind_channel`, the claude `ui_pid` auto-bind, or any other writer of the delivery columns — the daemon SHALL, in the same transaction, release the same coordinate on every other row with the same device and `role != '__channel_proxy__'` by setting that row's delivery to `kind='none'` with a NULL payload.

The new holder wins.  The daemon SHALL NOT reject the write in favour of an incumbent: the registering session provably occupies the coordinate, and keeping the incumbent would route its wake-ups into a conversation that reads a different mailbox.  Pre-write conflict checks that already exist on specific paths (the codex launch reconnect's `codex_thread_conflict`) are unchanged.

When the released coordinate is a codex thread, the same statement SHALL record that `thread_id` in the incumbent's `prev_codex_thread_id` column.  The column means "the thread this row lost to a newer holder and has not replaced": it is NEVER a delivery address and MUST NOT be consulted when resolving who currently holds a thread, but the same-thread seat evidence lookup and the seat-follow key-holder lookup SHALL treat a row whose `prev_codex_thread_id` equals the registering thread exactly as they treat a row that still holds it.  The column SHALL be reset to NULL whenever that row itself has a delivery written again.  A released `claude-channel` incumbent records nothing there.

Releasing an incumbent's coordinate SHALL NOT delete its row, change its `agent_id`, or touch its mailbox, unread cursor, `tmux_pane_id`, or `identity_key`.  When a released `claude-channel` incumbent has the same non-null `runtime_ui_pid` as the new holder, the daemon SHALL also set the incumbent's `runtime_ui_pid` to NULL, so that a later proxy registration's reactive rebind cannot hand the coordinate back to it.

`__channel_proxy__` rows are outside this rule in both directions: a proxy row legitimately shares its `channel_session_id` with the host it serves, so a proxy row MUST NOT be released, and writing a proxy row MUST NOT release any host.  Rows on a different device, and deliveries of kind `kimi-server` / `opencode-server` / `none`, are untouched.

A proxy registration's reactive rebind writes one `channel_session_id` onto every host that shares the proxy's ui pid, which can be several rows left behind by renames of one Claude process.  In the same transaction the daemon SHALL converge that session onto the single most recently seen (`last_seen_at`) non-proxy holder on the device and release every other holder under the rules above.

The pre-existing identity-key migration release (a registration that presents an `identity_key` held by another row and claims the same coordinate) is unchanged by this requirement: it releases the holder's delivery before the upsert and records nothing in `prev_codex_thread_id`, exactly as before.

This rule is independent of pane exclusivity: clearing a pane binding still does not touch `delivery`; a delivery is released only because another row claimed the same coordinate.

#### Scenario: New identity on the same codex thread releases the old one

- **GIVEN** agent `codex-66df8c06` on device `jt` holds `delivery = { kind: 'codex-appserver', thread_id: 'T1' }`
- **WHEN** a session registers as `vercel-operator` on device `jt` with `thread_id = 'T1'`
- **THEN** `vercel-operator` holds `codex-appserver` delivery with `thread_id = 'T1'`
- **AND** `codex-66df8c06` has `delivery.kind = 'none'` and `prev_codex_thread_id = 'T1'`
- **AND** `codex-66df8c06` keeps its `agent_id`, mailbox rows, and unread cursor

#### Scenario: A wake for the released identity no longer reaches the thread

- **GIVEN** the state after the previous scenario
- **WHEN** another agent calls `send_message` addressed to `codex-66df8c06`
- **THEN** the `messages` row is written for `codex-66df8c06`
- **AND** no wake-up is dispatched to thread `T1`

#### Scenario: A released codex row is still same-thread seat evidence

- **GIVEN** agent `old` on device `jt` held thread `T1` with a bound runtime and was released when `new` registered on `T1`
- **WHEN** the same-thread evidence lookup runs for thread `T1`
- **THEN** it returns `old`
- **AND** the lookup of the current holder of `T1` returns only `new`

#### Scenario: A row forgets its lost thread once it holds a delivery again

- **GIVEN** agent `old` has `prev_codex_thread_id = 'T1'` and `delivery.kind = 'none'`
- **WHEN** `old` registers again with `thread_id = 'T2'`
- **THEN** `old` has `prev_codex_thread_id = NULL`

#### Scenario: New identity on the same claude channel session releases the old one

- **GIVEN** agent `old` on device `jt` holds `delivery = { kind: 'claude-channel', channel_session_id: 'C1' }` and `runtime_ui_pid = 5847`
- **WHEN** agent `new` on device `jt` with `runtime_ui_pid = 5847` is bound to `channel_session_id = 'C1'`
- **THEN** `new` holds `claude-channel` delivery with `C1`
- **AND** `old` has `delivery.kind = 'none'` and `runtime_ui_pid = NULL`

#### Scenario: Reactive rebind leaves one session on one identity

- **GIVEN** rows `old` and `new` on device `jt` in the same team both have `runtime_ui_pid = 5847` and `delivery.kind = 'none'`, and `new` was seen more recently
- **WHEN** a `__channel_proxy__` row with `claude_ui_pid = 5847` registers with `channel_session_id = 'C1'`
- **THEN** `new` holds `claude-channel` delivery with `C1`
- **AND** `old` has `delivery.kind = 'none'` and `runtime_ui_pid = NULL`
- **AND** a later proxy registration with `channel_session_id = 'C2'` rebinds only `new`

#### Scenario: Channel proxy row keeps sharing its host's session

- **GIVEN** a `__channel_proxy__` row and host `alice` on device `jt` both carry `channel_session_id = 'C1'`
- **WHEN** `alice` is re-bound to `channel_session_id = 'C1'`
- **THEN** the proxy row still carries `C1`
- **AND** registering the proxy row again does not change `alice`'s delivery

#### Scenario: Same coordinate on a different device is untouched

- **GIVEN** agent `c` on device `gx` holds `codex-appserver` delivery with `thread_id = 'T1'`
- **WHEN** agent `b` on device `jt` registers with `thread_id = 'T1'`
- **THEN** `c` still holds its delivery

#### Scenario: Re-registering the same agent on its own coordinate is idempotent

- **GIVEN** agent `b` on device `jt` holds `codex-appserver` delivery with `thread_id = 'T1'`
- **WHEN** `b` registers again with `thread_id = 'T1'`
- **THEN** `b` still holds the delivery and no other row is modified

#### Scenario: At most one non-proxy row per device holds a coordinate

- **GIVEN** any sequence of registrations and bindings has been applied after this rule took effect
- **WHEN** non-proxy `agents` rows are grouped by `(device, delivery_kind, coordinate)` over `codex-appserver` and `claude-channel` deliveries
- **THEN** no group written by those operations has more than one row

## MODIFIED Requirements

### Requirement: unknown_agent responses carry a recovery hint

When a business tool rejects a call with `unknown_agent`, the error payload MUST include a `hint` field. Two cases are distinguished:

1. **The MCP session is not bound to any agent** (before a registration binds it the session's caller id is its own session id, which never names an agent row). The hint MUST state that session→agent bindings are per-connection and are dropped by a daemon restart, an MCP client reconnect, or an MCP config hot-reload while the registration itself persists, and MUST prescribe recovery via `reconnect` with the runtime-specific lookup key: kimi-code → `base_url` + `session_id`; opencode → `base_url` (+ `session_id`); codex → `thread_id`; claude-code → `ui_pid`. The hint MUST direct never-registered callers to `register_agent` instead.

2. **The session is bound to an `agent_id` whose row no longer exists** (the registration expired after 30 days without activity, or was removed). The hint MUST state that the registration record itself is gone — it MUST NOT claim that the registration persists — MUST name the 30-day inactivity expiry as the likely cause, and MUST prescribe: call `reconnect` with the same runtime-specific lookup keys first; when it returns `need_register`, call `register_agent` again with the agent's previous name and team. It MUST state that the re-registered agent gets a new `agent_id` and that mail addressed to the expired one is not carried over.

#### Scenario: unknown_agent response includes reconnect guidance per agent type

- **GIVEN** a fresh MCP session that has not called `register_agent`
- **WHEN** it calls `get_inbox` (or any business tool)
- **THEN** the response is `{ error: 'unknown_agent', hint: <string> }`
- **AND** the hint mentions `reconnect`, the per-agent-type lookup keys (`kimi-code`, `claude-code`), and `register_agent`

#### Scenario: An expired agent is told its registration is gone and to reconnect

- **GIVEN** an MCP session bound to agent `old`
- **AND** the `agents` row of `old` has been deleted by cleanup
- **WHEN** the session calls `get_inbox` (or any business tool)
- **THEN** the response is `{ error: 'unknown_agent', hint: <string> }`
- **AND** the hint says the registration was removed, mentions the 30-day inactivity expiry, and prescribes `reconnect` followed by `register_agent` on `need_register`
- **AND** the hint does not say the registration persists
