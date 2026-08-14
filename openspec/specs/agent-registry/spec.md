# agent-registry Specification

## Purpose

Persist agent identity tied to MCP session ids, scope visibility by team, and track liveness for all MCP tool callers.
## Requirements
### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `agent_type TEXT`, `agent_type_name TEXT`, `device TEXT NOT NULL`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`, `claude_ui_pid INTEGER`, `remote_addr TEXT`.

The `name` column is the human-readable identifier used as part of the 3-tuple identity key `(device, team, name)` — it MUST NOT be NULL, MUST NOT be empty after trimming, and MUST NOT contain the `:` character (the colon is reserved as the `name:device` syntax delimiter in the mailbox capability). The `device` column is the host-namespace identifier used as part of the same identity key — it MUST NOT be NULL, MUST NOT be empty after trimming, MUST NOT contain `:`, and MUST be 64 characters or fewer. The `role` column remains a non-null informational field that describes the agent's function (e.g. `backend`, `frontend`) but is NOT part of the identity key; multiple successive registrations for the same `(device, team, name)` MAY carry different `role` values and MUST collapse to a single row. The `agent_type` column stores the explicitly declared runtime kind (`codex`, `claude-code`, `opencode`, `kimi-code`, or `custom`) and MAY be NULL only for legacy rows written before this requirement. The `agent_type_name` column is nullable and stores an optional free-form runtime label used only when `agent_type='custom'`. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

The `claude_ui_pid` column is nullable and is populated only on `__channel_proxy__` rows; it stores the parent process id (`process.ppid`) of the channel proxy, which equals the Claude Code UI process id that spawned the proxy. It enables the host-to-proxy match during `register_agent({agent_type:'claude-code'})` auto-bind. For non-proxy rows it MUST remain NULL. The `remote_addr` column is nullable and stores the peer address of the MCP session that wrote the row when that session was non-loopback (used for daemon-internal audit only); for loopback sessions and legacy rows it MUST be NULL. Neither `claude_ui_pid` nor `remote_addr` is part of the identity key.

A UNIQUE index `agents_identity_idx` SHALL exist on `(device, team, name)` to support O(log n) identity lookup AND to physically prevent multiple rows with the same `(device, team, name)`.

On daemon startup, when the `agents` table is missing the `claude_ui_pid` column, the daemon SHALL execute an additive migration `ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER` in a single transaction; the migration is idempotent (if the column already exists, no ALTER is issued) and MUST NOT backfill values (existing rows get NULL until their next `register_agent` upsert). When the `agents` table is missing the `device` column, the daemon SHALL execute an additive migration that (1) `ALTER TABLE agents ADD COLUMN device TEXT`, (2) `UPDATE agents SET device = :local_device WHERE device IS NULL` where `:local_device` is the daemon's configured `--device` value (or its default `os.hostname()`-derived label), and (3) `DROP INDEX IF EXISTS agents_identity_idx; CREATE UNIQUE INDEX agents_identity_idx ON agents(device, team, name)` — all within a single transaction. The same startup pass SHALL also `ALTER TABLE agents ADD COLUMN remote_addr TEXT` when that column is missing (no backfill). The combined migration MUST be idempotent — repeated daemon startups MUST NOT re-run completed ALTERs. Before backfilling `device`, the daemon SHALL verify no existing row has a `name` containing `:`; if any such row exists the migration MUST fail with a clear error referencing the offending `(team, name)`. The column-rename migration covering `client → agent_type` and `client_name → agent_type_name` is described in a separate requirement.

#### Scenario: Fresh database creates UNIQUE identity index on (device, team, name)

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA index_list('agents')` contains `agents_identity_idx`
- **AND** `PRAGMA index_info('agents_identity_idx')` lists exactly three columns in order: `device`, `team`, `name`
- **AND** `PRAGMA index_list('agents')` shows `agents_identity_idx` with `unique = 1`

#### Scenario: agents table columns match schema

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists columns: `agent_id`, `agent_type`, `agent_type_name`, `device`, `team`, `role`, `name`, `model`, `registered_at`, `last_seen_at`, `last_processed_event_id`, `tmux_pane_id`, `claude_ui_pid`, `remote_addr`
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`
- **AND** the `claude_ui_pid` column exists with type `INTEGER` and `notnull = 0`
- **AND** the `device` column exists with type `TEXT` and `notnull = 1`
- **AND** the `remote_addr` column exists with type `TEXT` and `notnull = 0`
- **AND** the `name` column has `notnull = 1`
- **AND** the `role` column has `notnull = 1`
- **AND** neither `client` nor `client_name` appears in the column list

#### Scenario: Inserting two rows with same (device, team, name) violates UNIQUE constraint

- **GIVEN** a fresh `agents` table with one row `(device='host-a', team='default', name='alice', role='backend', agent_id='X')`
- **WHEN** a second INSERT is attempted with `(device='host-a', team='default', name='alice', role='frontend', agent_id='Y')`
- **THEN** SQLite raises `UNIQUE constraint failed: agents.device, agents.team, agents.name`
- **AND** only the original row `agent_id='X'` remains in the table

#### Scenario: Same (team, name) coexists across distinct devices

- **GIVEN** an `agents` table with one row `(device='host-a', team='default', name='creator', agent_id='X')`
- **WHEN** an INSERT writes `(device='host-b', team='default', name='creator', agent_id='Y')`
- **THEN** both rows persist (different devices ⇒ different identity tuples)
- **AND** `SELECT agent_id FROM agents WHERE team='default' AND name='creator' ORDER BY device` returns `['X', 'Y']`

#### Scenario: Startup migration adds claude_ui_pid to legacy schema

- **GIVEN** an existing `data.db` where `agents` table lacks the `claude_ui_pid` column
- **WHEN** the daemon starts
- **THEN** the migration issues `ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER`
- **AND** existing rows have `claude_ui_pid IS NULL`
- **AND** no other column values are modified

#### Scenario: Startup migration is idempotent for claude_ui_pid

- **GIVEN** the daemon has already migrated the database in a previous run so `claude_ui_pid` exists
- **WHEN** the daemon starts again
- **THEN** no ALTER statement is issued for `claude_ui_pid`

#### Scenario: Startup migration adds device, backfills, and rebuilds identity index

- **GIVEN** an existing `data.db` where `agents` table lacks the `device` column and contains rows with various `(team, name)` values, none of which contain `:` in `name`
- **AND** the daemon is started with `--device host-a` (or default-derived label `host-a`)
- **WHEN** the daemon starts
- **THEN** the migration issues `ALTER TABLE agents ADD COLUMN device TEXT`
- **AND** the migration issues `ALTER TABLE agents ADD COLUMN remote_addr TEXT`
- **AND** every pre-existing row has `device = 'host-a'` after the run
- **AND** `agents_identity_idx` now covers exactly `(device, team, name)` in that order with `unique = 1`
- **AND** the entire migration runs inside a single transaction

#### Scenario: Startup migration is idempotent for device and remote_addr

- **GIVEN** the daemon has already migrated the database in a previous run so `device` and `remote_addr` exist and the identity index already covers `(device, team, name)`
- **WHEN** the daemon starts again
- **THEN** no ALTER statement is issued for `device` or `remote_addr`
- **AND** the existing `agents_identity_idx` is NOT dropped or recreated

#### Scenario: Startup migration aborts when an existing name contains a colon

- **GIVEN** an existing `data.db` where one row has `name='odd:name'`
- **WHEN** the daemon starts (and the `device` column is missing so migration would run)
- **THEN** the migration aborts before backfilling `device`
- **AND** the daemon exits with a non-zero status
- **AND** stderr names the offending `(team, name)` so the operator can fix the row

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, agent_type?, agent_type_name?, device, role, name, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST reflect process liveness via the `isAgentLive` predicate (see the "Agent liveness is process-based" Requirement), NOT a fixed `last_seen_at` recency window. Agents from other teams MUST NOT appear, but agents from every device within the resolved team SHALL appear so the caller can compose `name:device` addresses for cross-device recipients. The `name` field is always present and non-empty. The `device` field is always present and non-empty. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset. `agent_type_name` SHALL be `null` unless `agent_type='custom'`. The response object MUST NOT contain legacy `client` or `client_name` keys, and MUST NOT contain `remote_addr` or any user-facing `origin` field — `device` is the only namespace identifier visible to callers.

Rows with `role='__channel_proxy__'` MUST NOT appear in the response. Channel proxy rows are internal infrastructure for the `claude-channel` delivery path; they are not legitimate `send_message` recipients and have no place in the public team listing. The exclusion is unconditional — there is no opt-in flag to surface them — and applies even when the caller itself is a channel proxy. Internal lookup paths (`AgentsRepo.getById`, channel-wake fanout, delivery dispatch) are unaffected and continue to see channel proxy rows directly.

#### Scenario: Caller in team 'alpha' sees only team 'alpha' agents

- **GIVEN** agents A, B in team 'alpha' and agent C in team 'beta'
- **WHEN** a caller in team 'alpha' invokes `list_agents`
- **THEN** the response includes A and B but NOT C
- **AND** each agent entry has `agent_type` and `agent_type_name` keys (with `agent_type_name` null for non-custom agents)
- **AND** no entry has a `client` or `client_name` key

#### Scenario: list_agents returns one row per device for shared (team, name)

- **GIVEN** the caller is in team `foo` on device `host-a`
- **AND** the `agents` table contains `(device='host-a', team='foo', name='creator', role='default')` and `(device='host-b', team='foo', name='creator', role='default')`
- **WHEN** the caller calls `list_agents()` (no `team` arg)
- **THEN** the response `agents` array contains two entries with `name='creator'`
- **AND** one entry has `device='host-a'` and the other has `device='host-b'`
- **AND** neither entry contains a `remote_addr` field or an `origin` field

#### Scenario: list_agents excludes other teams across all devices

- **GIVEN** the caller is in team `foo`
- **AND** the `agents` table contains `(device='host-b', team='bar', name='creator')`
- **WHEN** the caller calls `list_agents()`
- **THEN** the `bar`-team entry MUST NOT appear, regardless of its device

#### Scenario: list_agents response includes device field on every entry

- **GIVEN** the `agents` table contains one row `(device='host-a', team='default', name='alice')`
- **WHEN** the caller in team `default` calls `list_agents()`
- **THEN** every entry in `agents[]` has a `device` field of type `string` with length ≥ 1

#### Scenario: Online flag reflects process liveness, not idle time

- **GIVEN** the daemon's local device label is `D`
- **AND** agent A on `device=D` has `runtime_ui_pid` set to a live process and `last_seen_at = now - 3 days`
- **AND** agent B on `device=D` has `runtime_ui_pid` set to a process that is no longer running
- **WHEN** `list_agents` is called
- **THEN** A's entry has `online: true` (its process is alive despite being idle for days)
- **AND** B's entry has `online: false` (its process is gone)

#### Scenario: Channel proxy rows are excluded from list_agents output

- **GIVEN** team `default` contains business agent `alice` (role `default`) and 50 channel proxy rows (role `__channel_proxy__`), all registered and `online: true`
- **WHEN** a caller in team `default` invokes `list_agents`
- **THEN** the response `agents` array contains exactly one entry for `alice`
- **AND** no entry has `role: '__channel_proxy__'`
- **AND** no entry has `name` matching `channel-proxy-*`

#### Scenario: A channel proxy caller does not see itself or other proxies via list_agents

- **GIVEN** team `default` contains 3 channel proxy rows including the caller proxy `P1`
- **WHEN** the proxy `P1` invokes `list_agents`
- **THEN** the response `agents` array contains no entry with `role: '__channel_proxy__'`
- **AND** P1 is not present in its own response

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

### Requirement: last_seen_at updates on any tool invocation

Every MCP tool invocation by an authenticated agent SHALL update the caller's `agents.last_seen_at` to the current timestamp before returning.

#### Scenario: Tool call bumps last_seen_at

- **GIVEN** agent `sess-A` last_seen_at is 1 hour ago
- **WHEN** `sess-A` calls any tool (e.g. `list_agents`)
- **THEN** after the call, `agents.last_seen_at` for `sess-A` is within the last second

### Requirement: Tmux pane id persistence

The daemon MUST NOT auto-detect and persist `tmux_pane_id` during `register_agent`.  Instead, tmux pane binding is written only by explicit runtime-binding paths after registration.  `register_agent` may still succeed with `tmux_pane_id = NULL`.

Every such write SHALL additionally enforce "Pane binding is exclusive per device with last-writer-wins".

#### Scenario: register_agent succeeds without auto-detecting a pane

- **GIVEN** a caller invokes `register_agent({ model, name: 'alice' })`
- **WHEN** the daemon processes the registration
- **THEN** the call succeeds
- **AND** the row may still have `tmux_pane_id = NULL`
- **AND** the success hint directs the caller to `bind_runtime_identity(...)`

### Requirement: detect_tmux_pane discovers the real agent UI pane

The daemon SHALL register an MCP tool named `detect_tmux_pane` that helps callers discover the tmux pane actually hosting a coding-agent UI, even when the shell used for tool execution lives in a different pane.  The tool SHALL accept `{ agent: 'codex' | 'claude-code' | 'opencode' | 'custom', cwd?: string, tty?: string, title_contains?: string, process_pattern?: string }`.

The detector SHALL scan tmux panes globally, map each pane to its tty, inspect the real processes attached to that tty, and rank candidates using tty/process evidence rather than trusting `$TMUX_PANE` or tmux focus state alone.  For `agent='custom'`, `process_pattern` MUST be required.  Successful responses SHALL return the single best pane plus candidate metadata; ties at the highest score SHALL return an ambiguity result instead of guessing.

#### Scenario: detect_tmux_pane finds Codex UI pane when shell pane differs

- **GIVEN** a workspace where the shell invoking MCP tools lives in tmux pane `%1863`
- **AND** the visible Codex UI is running in tmux pane `%1902`
- **AND** `%1902` owns the tty whose live processes include `codex --remote ...`
- **WHEN** the caller invokes `detect_tmux_pane({ agent: 'codex', cwd: '/workspace/project' })`
- **THEN** the tool returns `{ ok: true, pane: { pane_id: '%1902', ... } }`
- **AND** the returned candidate metadata reflects tty/process evidence for `%1902`

#### Scenario: detect_tmux_pane returns ambiguous_match on tied candidates

- **GIVEN** two tmux panes both satisfy the selected agent matcher with the same highest score
- **WHEN** the caller invokes `detect_tmux_pane(...)`
- **THEN** the tool returns `{ error: 'ambiguous_match', candidates: [...] }`
- **AND** it does not silently choose one pane

### Requirement: register_agent response hints when tmux_pane_id missing

The daemon MUST attach a `hint: string` field to the successful `register_agent` response if and only if the call still ends without a usable registered `tmux_pane_id` after any best-effort automatic runtime-binding attempt AND did NOT provide a non-tmux delivery in the same call.  "Not usable" means the field is (a) omitted, (b) an empty string, or (c) a string consisting only of whitespace.  A trimmed non-empty value suppresses the hint.  Error envelopes MUST NEVER carry a hint.

The hint text MUST advise the caller that automatic runtime binding did not converge for this session and that explicit `bind_runtime_identity(...)` remains available as the fallback write path.  The hint MAY mention `detect_tmux_pane(...)` as a debugging aid for ambiguous or missing matches.  The text SHOULD mention cross-agent poke delivery as the motivation.

#### Scenario: Register succeeds without a usable pane and returns a hint

- **GIVEN** a caller that invokes `register_agent({ agent_type: 'custom', model, role })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>`
- **AND** the hint string contains the substring `tmux_pane_id`
- **AND** the hint string contains the substring `agent`

#### Scenario: Hint mentions detector debugging for split shell and UI setups

- **GIVEN** a caller that succeeds in `register_agent(...)` without registering a usable pane
- **AND** the deployment may execute shell tools in a helper pane while the visible agent UI runs in another pane
- **WHEN** the daemon returns the success envelope
- **THEN** the `hint` string contains the substring `detect_tmux_pane`
- **AND** the hint string recommends using the detector for debugging and `bind_runtime_identity(...)` for explicit fallback binding

#### Scenario: Explicit tmux_pane_id input is rejected at the schema layer

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', model, name, role, tmux_pane_id: '%42' })`
- **THEN** the call is rejected at the schema layer as an unrecognized top-level key
- **AND** no row is created or updated

#### Scenario: Non-tmux delivery suppresses hint

- **GIVEN** a caller that invokes `register_agent({ agent_type: 'codex', model, role, delivery: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' } })`
- **WHEN** the call is processed and succeeds
- **THEN** the response object MUST NOT have a `hint` field

#### Scenario: Error envelope never includes hint

- **GIVEN** a register_agent call that fails (e.g. caller unregistered or `agent_id_collision` or any non-success path)
- **WHEN** the daemon returns the error envelope
- **THEN** the response object MUST NOT have a `hint` field

### Requirement: register_agent reuses agent_id by (team, name, role) identity

The `register_agent` MCP tool SHALL take `{ agent_type: 'codex' | 'claude-code' | 'opencode' | 'custom', agent_type_name?: string, model?: string, name: string, role?: string = 'default', team?: string, project_dir?: string, ui_pid?: number, delivery?: DeliverySpec }` and:

1. Trim `name` and reject with a validation error if empty.
2. Require `agent_type` explicitly. `agent_type_name` MAY be supplied only when `agent_type='custom'`. The legacy field names `client` and `client_name` are NOT accepted by the strict schema and MUST produce an unknown-key validation error.
3. Derive the effective `team` value by applying this three-level precedence:
   - If `team` is provided and non-empty after trimming, use it as-is.
   - Else if `project_dir` is provided, compute `basename(project_dir)`, trim it, lowercase it (POSIX `basename` semantics — trailing slashes stripped before taking the last component), and if the result is non-empty use it as the effective team.
   - Else fall back to the literal string `'default'`.
   The derived value is then used wherever the original `team` parameter was consumed (UPSERT key, response, runtime binding).
4. Execute an atomic UPSERT keyed on `(team, name)` where `team` is the derived value:
   - If no row exists for `(team, name)`: INSERT a new row with a freshly generated `agent_id = randomUUID()`, the provided `role`, `model`, `registered_at = now`, `last_seen_at = now`, `tmux_pane_id = NULL` unless an earlier runtime binding already existed for that identity, and `last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)` so the brand-new agent does not see historical mail addressed to anyone. The MAX read MUST happen inside the same transaction as the INSERT to avoid a race where a new event lands between the read and the insert.
   - If a row already exists for `(team, name)`: UPDATE that row's `agent_type`, `agent_type_name`, `role`, `model`, `last_seen_at`; preserve `agent_id`, `registered_at`, and `last_processed_event_id`; preserve the existing `tmux_pane_id` until a later automatic or explicit runtime-binding attempt writes a new usable value.
5. After the identity row exists, best-effort attempt automatic runtime binding for this session:
   - The daemon MUST NOT accept caller-supplied pane ids or pane-detect hints through the MCP tool surface.
   - If `ui_pid` is provided, the daemon MUST prefer the verified `ui_pid -> tty -> pane` runtime-binding path.
   - For `agent_type='codex' | 'claude-code' | 'opencode'`, the daemon MUST use that explicit kind as the built-in matcher for automatic tmux detection.
   - For `agent_type='custom'`, the daemon MUST skip built-in matcher inference and treat automatic runtime binding as not attempted unless a later dedicated binding tool is invoked.
   - If `ui_pid` is absent and a built-in matcher is available, the daemon MUST invoke the same pane detector behind `detect_tmux_pane` for that matcher, and if detection succeeds, it MUST run the same verified persistence path as `bind_runtime_identity(...)` using the detected pane's tty plus pane id.
   - If no matcher is available, or the detector/runtime binder returns `ambiguous_match`, `not_found`, `tmux_unavailable`, or any other non-success result, the daemon MUST treat this attempt as having no new pane id rather than failing the registration.
6. Return `{ agent_id, team }` where `agent_id` is either the preserved or newly generated id and `team` is the derived value from step 3.

The returned `agent_id` MUST be considered the stable identity for this `(team, name)` pair across reconnects AND across role changes. Changing the `role` parameter on a subsequent register does NOT produce a new `agent_id`; it updates the existing row's `role` column in place. The MCP session id is an orthogonal transport-level artifact and MUST NOT be conflated with `agent_id`.

When an automatic or explicit runtime-binding attempt resolves a usable `tmux_pane_id`, its value MUST be persisted. If the current registration attempt resolves no new pane id, the column value in the reuse case MUST remain the previously-persisted value; in the create-new case it MUST be NULL.

The hint-on-missing-pane-id semantics (see Requirement "register_agent response hints when tmux_pane_id missing") apply unchanged.

`project_dir` MUST be treated as an input-only hint for default team derivation; it MUST NOT be persisted on the agents row and MUST NOT be returned in the response.

#### Scenario: Automatic runtime binding persists a detected pane during register_agent

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', model, name: 'alice', thread_id: '<uuid>' })`
- **AND** the detector converges on a single pane `%1902`
- **AND** verified runtime binding succeeds for `%1902`
- **WHEN** the call is processed and succeeds
- **THEN** the stored `tmux_pane_id` is `'%1902'`
- **AND** the response object MUST NOT have a `hint` field

#### Scenario: ui_pid drives automatic runtime binding during register_agent

- **GIVEN** the caller invokes `register_agent({ agent_type: 'claude-code', model, name: 'alice', ui_pid: 25079 })`
- **AND** verified runtime binding via `ui_pid=25079` succeeds and resolves pane `%1902`
- **WHEN** the call is processed and succeeds
- **THEN** the stored `tmux_pane_id` is `'%1902'`
- **AND** the stored `runtime_ui_pid` is `25079`
- **AND** the response object MUST NOT have a `hint` field

#### Scenario: New identity creates a fresh agent_id with cursor at current MAX(event_id)

- **GIVEN** the agents table has no row for `(team='default', name='alice')`
- **AND** the events table currently has `MAX(event_id) = 137`
- **WHEN** a new MCP session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: <uuid>, team: 'default' }`
- **AND** the agents row has `name='alice'`, `role='backend'`, `team='default'`, `agent_type='custom'`, `agent_type_name='cursor'`
- **AND** the agents row has `last_processed_event_id = 137`
- **AND** `agent_id` is NOT equal to the MCP session id

#### Scenario: New identity in an empty events table starts at cursor 0

- **GIVEN** the agents table has no row for `(team='default', name='alice')`
- **AND** the events table is empty (`MAX(event_id) IS NULL`)
- **WHEN** a new MCP session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', name: 'alice' })`
- **THEN** the agents row's `last_processed_event_id` is `0`

#### Scenario: Reconnect reuses existing agent_id

- **GIVEN** agent with `(team='default', name='alice')` already exists with `agent_id='X'` and `role='backend'`
- **WHEN** a different MCP session (new session id) calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X as before)
- **AND** the agents table still has exactly one row for this identity
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` is unchanged from the original registration
- **AND** that row's `last_processed_event_id` is unchanged (the MAX-init only fires on fresh INSERTs)

#### Scenario: Role change updates existing agent_id in-place

- **GIVEN** agent `(team='default', name='alice')` exists with `agent_id='X'` and `role='backend'`
- **WHEN** a subsequent session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model, role: 'frontend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X — NOT a new UUID)
- **AND** the agents table still has exactly one row for `(team='default', name='alice')`
- **AND** that row's `role` is now `'frontend'`
- **AND** that row's `last_processed_event_id` (mailbox cursor) is preserved across the role change

#### Scenario: custom agent_type may persist agent_type_name

- **GIVEN** a caller invokes `register_agent({ agent_type: 'custom', agent_type_name: 'kimi-coder', model, name: 'alice' })`
- **WHEN** the call is processed and succeeds
- **THEN** the agents row stores `agent_type='custom'`
- **AND** the agents row stores `agent_type_name='kimi-coder'`

#### Scenario: agent_type_name is rejected for non-custom agent types

- **WHEN** a caller invokes `register_agent({ agent_type: 'codex', agent_type_name: 'codex-cli', model, name: 'alice', thread_id: '<uuid>' })`
- **THEN** the call is rejected at the schema layer

#### Scenario: missing agent_type is rejected

- **WHEN** a caller invokes `register_agent({ model, name: 'alice' })`
- **THEN** the call is rejected at the schema layer

#### Scenario: legacy client field is rejected

- **WHEN** a caller invokes `register_agent({ client: 'custom', name: 'alice' })`
- **THEN** the call is rejected at the schema layer with an unknown-key error citing `client`
- **AND** the error message hints that the field was renamed to `agent_type`

#### Scenario: legacy client_name field is rejected

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', client_name: 'cursor', name: 'alice' })`
- **THEN** the call is rejected at the schema layer with an unknown-key error citing `client_name`
- **AND** the error message hints that the field was renamed to `agent_type_name`

#### Scenario: Reuse updates tmux_pane_id when a later registration finds a new unique pane

- **GIVEN** agent `(default, alice)` exists with `agent_id='X'`, `role='backend'`, and `tmux_pane_id='%42'`
- **AND** a later registration attempt auto-detects `%99` as the unique pane for the same identity
- **WHEN** a new session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model, role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the agents row's `tmux_pane_id` is now `'%99'`

### Requirement: Identity label character constraints

`register_agent` SHALL reject reserved characters in the identity labels before writing any agents row, so that conversational shorthand (e.g. the `name(team)` form like `skills-creator(default)`) cannot leak into a stored identity. The `name` label MUST NOT contain `:`, `(`, or `)`; a violation returns `{error: 'invalid_name_label'}`. An explicitly supplied `team` MUST NOT contain `(` or `)`; a violation returns `{error: 'invalid_team_label'}`. A `team` derived from the `project_dir` basename (when no explicit `team` is given) is NOT character-validated, because the shorthand accident only arrives through explicit arguments. These checks apply uniformly across `agent_type` values (claude-code, codex, custom) via the shared registration path.

#### Scenario: name containing a colon is rejected

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', name: 'bad:name' })`
- **THEN** the call returns `{error: 'invalid_name_label'}` without writing any row

#### Scenario: name containing parentheses is rejected

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', name: 'skills-creator(default)' })`
- **THEN** the call returns `{error: 'invalid_name_label'}` without writing any row

#### Scenario: explicit team containing parentheses is rejected

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', name: 'alice', team: 'default)' })`
- **THEN** the call returns `{error: 'invalid_team_label'}` without writing any row

#### Scenario: team derived from a parenthesized project_dir basename is allowed

- **GIVEN** no explicit `team` is supplied
- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', name: 'alice', project_dir: '/tmp/my(proj)' })`
- **THEN** the registration succeeds with team `my(proj)` (the derived basename is not character-validated)

### Requirement: Sentinel migration advances stale zero cursors on schema apply

`applySchema` SHALL run an idempotent one-shot migration that advances every `agents` row whose `last_processed_event_id = 0` to the current `MAX(event_id)` of the events table:

```
UPDATE agents
   SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)
 WHERE last_processed_event_id = 0
```

The migration MUST be safe to run on every daemon boot. Once an agent's cursor has advanced past 0 (either via this migration, via a fresh registration, or via the new `get_inbox` auto-advance), this UPDATE WHERE-clause matches no rows and the migration is a no-op. There MUST be no separate migrations table or version flag — the `last_processed_event_id = 0` predicate is itself the sentinel.

The migration MUST run BEFORE the daemon accepts any MCP traffic (i.e. inside `applySchema` or the bootstrap path it is part of), so that the very first `get_inbox()` call on this boot already sees a non-zero cursor and does not re-emit the entire historical mailbox.

#### Scenario: Existing zero-cursor agent is advanced on first boot post-deploy

- **GIVEN** before the deploy, an existing agent row has `last_processed_event_id = 0`
- **AND** the events table has `MAX(event_id) = 500`
- **WHEN** the daemon boots and `applySchema` runs
- **THEN** that agent's `last_processed_event_id` is now `500`

#### Scenario: Migration is idempotent on subsequent boots

- **GIVEN** every agent row already has `last_processed_event_id > 0` after a prior boot ran the migration
- **AND** new events have appeared since then, raising `MAX(event_id)` further
- **WHEN** the daemon boots again and `applySchema` runs
- **THEN** no agent row is modified (the WHERE clause matches zero rows)
- **AND** existing cursors are NOT bumped to the new MAX (preserving each agent's own pace)

#### Scenario: Migration on empty events table sets cursors to zero (no-op)

- **GIVEN** an existing agent row with `last_processed_event_id = 0`
- **AND** the events table is empty (`MAX(event_id) IS NULL`)
- **WHEN** the daemon boots and `applySchema` runs
- **THEN** the agent's `last_processed_event_id` remains `0` (COALESCE → 0)
- **AND** no error is raised

### Requirement: Repeated register_agent for same identity updates metadata

Any subsequent `register_agent` call for a `(team, name)` pair that already has a row in the agents table SHALL upsert metadata on that existing row without producing a new `agent_id`, regardless of whether the call originates from the same MCP session or a new one, and regardless of whether the `role` parameter on the subsequent call matches the persisted `role`.

Upsert fields: `role`, `model`, `last_seen_at` are overwritten by the incoming values; `tmux_pane_id` is overwritten only when the current registration attempt resolves a usable pane id; `agent_id`, `registered_at`, and `last_processed_event_id` are preserved.

#### Scenario: Same session re-registers and replaces tmux_pane_id after a new detector result

- **GIVEN** session `sess-A` has registered `(default, alice)` with `role='backend'`, `tmux_pane_id='%42'` and received `agent_id='X'`
- **AND** a later registration attempt auto-detects `%99` as the unique pane for that same identity
- **WHEN** the same session calls `register_agent({ agent_type: 'custom', model, role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` becomes `'%99'`

#### Scenario: Re-register after reconnect preserves mailbox continuity

- **GIVEN** agent with `agent_id='X'` has unread messages addressed to X in the mailbox, and `last_processed_event_id=5`
- **WHEN** the owner reconnects (new MCP session) and calls `register_agent({ agent_type: 'custom', model, role, name })` for the same `(team, name)` identity — with the same OR a different `role`
- **THEN** the returned `agent_id` is `'X'`
- **AND** the row's `last_processed_event_id` is still `5`
- **AND** a subsequent `get_inbox()` call returns those unread messages

### Requirement: Within-session agent_id_collision via Authorization header

When a `register_agent` tool call carries an `Authorization` request header, the daemon MUST bind that session id to the sha256 hash of the (trimmed) header value on first binding, and MUST reject any subsequent `register_agent` for the **same MCP session id** presenting a different `Authorization` value with HTTP status 409.

The 409 rejection body MUST NOT be a bare `{ "error": <string> }` object. Strict MCP clients (e.g. codex's `rmcp`) deserialize any response body as a JSON-RPC message; a bare `{ "error": "agent_id_collision" }` object matches no JSON-RPC 2.0 variant and poisons the client transport. The body MUST be either an empty body or a well-formed JSON-RPC 2.0 error object `{ "jsonrpc": "2.0", "id": null, "error": { "code": <integer>, "message": <string> } }` that a strict client can deserialize without error. (This concerns only the transport-level HTTP rejection emitted before/around tool dispatch; tool-result-level `{ error: ... }` payloads returned inside a normal 200 JSON-RPC `result` are unaffected.)

当 `register_agent` 调用的 `(device, team, name)` 已绑定到不同的 MCP session id 时, daemon MUST 将其视为身份 TAKEOVER, 而不是 collision, 但下述稳定 runtime 身份共用连接的例外除外.  TAKEOVER 必须执行以下步骤:

1. 将内存连接账本替换为新的 MCP session id.
2. 对每个旧 MCP transport 调用 SDK transport 的 `close()` 方法.  关闭 MUST 经过 transport 的 `onclose` 链, 从 daemon 的 `sessions` Map 删除旧 session, 并清理对应的 SSE fanout 和 channel-wake 绑定.
3. 继续复用 agents row 的正常 upsert 路径, 保留 `agent_id`, `registered_at`, `last_processed_event_id`, 更新 `last_seen_at`, `role`, `model` 等字段, 并向新 session 返回 `{ agent_id, team }`.
4. 对每个旧 session 输出 debug 级 takeover 日志, 日志 MUST 包含新旧 session id 和 `(team, name)`.  即使 transport 中已找不到旧 session id, 也 MUST 输出日志.

强制关闭 MUST 使用幂等 session 清理器同步撤销旧 session 的路由、连接账本和 fanout 所有权.  SDK transport 的 `close()` 仍 MUST 被调用.  如果 `close()` 同步抛错或 Promise rejection, daemon MUST 显式记录包含旧 session id 的错误, 并保留已经完成的路由撤销, 不得让旧 session 继续通过 `/mcp` 到达业务工具.

例外是**稳定 runtime 身份共用连接**, 适用于以下两种情况:

- **Codex 同 thread**: 新旧注册都声明 `agent_type='codex'`, 都携带通过校验的 `delivery.kind='codex-appserver'`, 且 `delivery.thread_id` 相同.
- **kimi 同 session**: 新旧注册都声明 `agent_type='kimi-code'`, 都携带通过校验的 `delivery.kind='kimi-server'`, 且 canonical 化后的 `delivery.base_url` 与 `delivery.session_id` 都相同.  canonical 化规则由注册持久化、共享 key 与 reconnect 查询共用: scheme/host 小写、默认端口移除 (均由 URL 解析器完成)、hash 剥离、尾部斜杠去除, 不可解析的输入退化为仅去尾斜杠.  kimi 的 endpoint URL 由 base_url 直接拼接 `/api/v1/...` 构成, 因此所有 kimi base_url 入口 — register schema、显式 kimi reconnect schema、以及 delivery 对象的写入校验 (validateDeliveryForWrite, 覆盖 `agent_type='custom'` 携带 kimi-server delivery 的旁路) — MUST 共用同一 validator 拒绝携带 query、fragment 或 userinfo 的 base_url; 判定 MUST 检查原始字符串中的 `?` / `#` 分隔符, 因为 WHATWG URL 对裸尾部 `?`/`#` 报告空 search/hash 却在序列化中保留分隔符.  canonical 化在 service 持久化边界执行, 不只在 MCP tool 层.  kimi 的 session id 只在单个 server 内唯一, 因此共享 key MUST 由 `(base_url, session_id)` 二元组构成 — 相同 `session_id` 出现在等价 URL 拼写上共享, 出现在真正不同的 `base_url` 上仍执行 TAKEOVER.  这覆盖 kimi 双引擎架构下同一逻辑 agent 的两条 MCP 连接 (TUI 进程内引擎与 server 引擎): server 侧 turn 的同名 re-register MUST NOT 关闭 TUI 侧连接.

满足任一情况时, daemon MUST 将这些 MCP session 视为同一 runtime 身份的并发连接.  内存账本 MUST 保留所有连接, MUST NOT 关闭任何已有 transport, MUST NOT 输出 takeover 日志, 且所有连接 MUST 继续以同一个 `agent_id` 调用业务工具.  任一连接关闭时, daemon MUST 只释放该连接, 其余同 key 连接保持有效.  不同的稳定 key (thread_id / base_url+session_id), 缺少对应的已校验 delivery, 或任何其他 agent 类型仍执行正常 TAKEOVER.

因此, collision 保护仍仅适用于同一 session 内的 Authorization mismatch.  跨 session 重用同一身份时, daemon 根据上述规则执行 TAKEOVER 或稳定 runtime 身份共存, 不得返回 collision.

When the request carries no `Authorization` header (or an empty one after trim), the daemon MUST NOT enforce Authorization-based collision detection.

Arriving on a different TCP socket (e.g. after keep-alive expiry) MUST NOT by itself trigger a collision.

#### Scenario: Different Authorization credentials on same session id

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX`
- **WHEN** a request with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenY` calls `register_agent`
- **THEN** response status is HTTP 409
- **AND** the response body is NOT a bare `{ "error": "agent_id_collision" }` object (it is empty or a valid JSON-RPC 2.0 error object)

#### Scenario: Cross-session same identity under different Authorization reuses agent_id

- **GIVEN** session `sess-A` has registered `(default, alice)` with `Authorization: Bearer tokenX`, then `sess-A` has been released (connection closed)
- **WHEN** session `sess-B` calls `register_agent` for `(default, alice)` with `Authorization: Bearer tokenY`
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (reuse, not collision)

#### Scenario: Cross-session takeover while prior session is still live

- **GIVEN** session `sess-A` has called `register_agent` for `(default, alice)` and the daemon's `sessions` Map still contains `sess-A`
- **AND** `sess-A` has NOT sent DELETE and its MCP transport is still open
- **WHEN** a new MCP session `sess-B` calls `register_agent` for `(default, alice)` (no Authorization header on either call)
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (200 OK, NOT 409)
- **AND** the daemon's in-memory connection binding for `('default', 'alice')` now points to `sess-B`
- **AND** the prior MCP transport for `sess-A` has been closed by the daemon
- **AND** `sess-A` no longer appears in the `sessions` Map

#### Scenario: Cross-session takeover emits a debug log

- **GIVEN** the conditions of the prior scenario hold
- **WHEN** the takeover is processed
- **THEN** the daemon emits a debug-level log line containing `takeover`, the old session id, the new session id, the team `'default'`, and the name `'alice'`

#### Scenario: 同一 Codex thread 的并发 MCP session 共存

- **GIVEN** `sess-A` 已通过 `agent_type='codex'` 和 `thread_id='T'` 注册 `(default, alice)`, 并获得 `agent_id='X'`
- **WHEN** `sess-B` 使用相同 `agent_type`, `(device, team, name)` 和 `thread_id='T'` 注册
- **THEN** `sess-B` 获得相同的 `agent_id='X'`
- **AND** daemon 不关闭 `sess-A`, 也不输出 takeover 日志
- **AND** `sess-A` 和 `sess-B` 都能继续调用 `get_inbox` 等业务工具
- **AND** 任一 session 关闭后, 另一个 session 仍保持注册状态

#### Scenario: 新 Codex thread 接管旧 thread 的所有连接

- **GIVEN** `sess-A` 和 `sess-B` 都以 `thread_id='T1'` 绑定到 `(default, alice)`
- **WHEN** `sess-C` 以相同身份和不同的 `thread_id='T2'` 注册
- **THEN** daemon 关闭 `sess-A` 和 `sess-B`
- **AND** 内存连接账本只保留 `sess-C`
- **AND** daemon 为两个被关闭的 session 分别输出 takeover 日志

#### Scenario: 同一 kimi session 的两条引擎连接共存

- **GIVEN** `sess-TUI` 已通过 `agent_type='kimi-code'` 和 `delivery={ kind:'kimi-server', session_id:'S', base_url:'http://127.0.0.1:58627' }` 注册 `(default, kimi-1)`, 并获得 `agent_id='X'`
- **WHEN** `sess-SRV` (server 引擎侧的新 MCP session) 使用相同 `agent_type`, `(device, team, name)` 和相同 `session_id='S'` 注册
- **THEN** `sess-SRV` 获得相同的 `agent_id='X'`
- **AND** daemon 不关闭 `sess-TUI`, 也不输出 takeover 日志
- **AND** 两条连接都能继续调用 `get_inbox` 等业务工具

#### Scenario: 不同 kimi session 的同名注册仍执行 takeover

- **GIVEN** `sess-TUI` 以 `session_id='S1'` 绑定到 `(default, kimi-1)`
- **WHEN** `sess-NEW` 以相同身份和不同的 `session_id='S2'` 注册
- **THEN** daemon 关闭 `sess-TUI` 并输出 takeover 日志
- **AND** 内存连接账本只保留 `sess-NEW`

#### Scenario: 相同 session_id 不同 base_url 仍执行 takeover

- **GIVEN** `sess-A` 以 `delivery={ kind:'kimi-server', session_id:'S', base_url:'http://127.0.0.1:58627' }` 绑定到 `(default, kimi-1)`
- **WHEN** `sess-B` 以相同身份、相同 `session_id='S'` 但 `base_url='http://127.0.0.1:59999'` 注册
- **THEN** daemon 关闭 `sess-A` 并输出 takeover 日志 (跨 server 的同名 session id 不是同一 runtime)
- **AND** agents row 的 delivery 指向 `sess-B` 的 base_url

#### Scenario: 等价 base_url 拼写视为同一 runtime

- **GIVEN** `sess-A` 以 `base_url='http://127.0.0.1'` + `session_id='S'` 绑定到 `(default, kimi-1)`
- **WHEN** `sess-B` 以相同身份、相同 `session_id='S'` 和 `base_url='HTTP://127.0.0.1:80/'` (大写 scheme + 默认端口 + 尾斜杠) 注册
- **THEN** 两条连接共享同一 runtime 身份, daemon 不关闭 `sess-A`, 不输出 takeover 日志

### Requirement: Mismatched agent_id for tool call returns 403

If a tool call explicitly carries a `from_agent_id` parameter that does not match the caller's **currently registered agent_id** (held in the session's `agentIdHolder.current`), the daemon MUST reject the request with HTTP 403.

The 403 rejection body MUST NOT be a bare `{ "error": <string> }` object. Strict MCP clients (e.g. codex's `rmcp`) deserialize any response body as a JSON-RPC message; a bare `{ "error": "identity_mismatch" }` object matches no JSON-RPC 2.0 variant and poisons the client transport. The body MUST be either an empty body or a well-formed JSON-RPC 2.0 error object `{ "jsonrpc": "2.0", "id": null, "error": { "code": <integer>, "message": <string> } }` that a strict client can deserialize without error.

Before the session has called `register_agent` successfully, `agentIdHolder.current` is `undefined`; any tool call other than `register_agent` MUST also be rejected (unregistered session).

#### Scenario: send_message with spoofed from_agent_id

- **GIVEN** session `sess-A` has registered and holds `agentIdHolder.current = 'X'`
- **WHEN** a tool call on this session arrives with `from_agent_id='Y'` (not `'X'`)
- **THEN** the daemon rejects with HTTP 403
- **AND** the response body is NOT a bare `{ "error": "identity_mismatch" }` object (it is empty or a valid JSON-RPC 2.0 error object)

#### Scenario: Unregistered session calling business tool is rejected

- **GIVEN** a fresh MCP session that has not yet called `register_agent`
- **WHEN** it calls `list_agents` (or any business tool)
- **THEN** the call is rejected (unregistered)

### Requirement: unknown_agent responses carry a recovery hint

When a business tool rejects a call because the caller's MCP session is not bound to a registered agent (`unknown_agent`), the error payload MUST include a `hint` field. The hint MUST state that session→agent bindings are per-connection and are dropped by a daemon restart, an MCP client reconnect, or an MCP config hot-reload while the registration itself persists, and MUST prescribe recovery via `reconnect` with the runtime-specific lookup key: kimi-code → `base_url` + `session_id`; opencode → `base_url` (+ `session_id`); codex → `thread_id`; claude-code → `ui_pid`. The hint MUST direct never-registered callers to `register_agent` instead.

#### Scenario: unknown_agent response includes reconnect guidance per agent type

- **GIVEN** a fresh MCP session that has not called `register_agent`
- **WHEN** it calls `get_inbox` (or any business tool)
- **THEN** the response is `{ error: 'unknown_agent', hint: <string> }`
- **AND** the hint mentions `reconnect`, the per-agent-type lookup keys (`kimi-code`, `claude-code`), and `register_agent`

### Requirement: Agents table includes delivery_kind and delivery_payload columns

The `agents` table SHALL include two additional columns for persisting the agent's `DeliverySpec`, see `agent-delivery/spec.md`: `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT`, nullable and storing a JSON string when non-null.  These two columns together are the authoritative storage for the delivery channel.  `delivery_kind` defaults to `'none'` so that rows inserted by code paths that do not yet supply delivery remain valid.

#### Scenario: Fresh database creates agents table with delivery_kind and delivery_payload columns

- **WHEN** the daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists a column named `delivery_kind` with type `TEXT`, `notnull = 1`, and default value `'none'`
- **AND** `PRAGMA table_info('agents')` lists a column named `delivery_payload` with type `TEXT` and `notnull = 0`
- **AND** rows inserted without providing delivery fields have `delivery_kind='none'` and `delivery_payload IS NULL`

### Requirement: Startup migration adds delivery columns and backfills from channel_session_id

On daemon startup, when the `agents` table is missing the `delivery_kind` or `delivery_payload` columns, the daemon SHALL execute an additive migration in a single transaction:

1. `ALTER TABLE agents ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'none'`, if missing.
2. `ALTER TABLE agents ADD COLUMN delivery_payload TEXT`, if missing.
3. `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', channel_session_id) WHERE channel_session_id IS NOT NULL AND delivery_kind='none'`

The migration MUST be idempotent: if both columns already exist, no ALTER is issued.  The UPDATE SHALL only affect rows whose `channel_session_id` is non-null and `delivery_kind` is still the default `'none'`.  The migration MUST NOT modify the legacy `channel_session_id` column.

#### Scenario: Startup migration on old schema adds both columns

- **GIVEN** an existing `data.db` where `agents` table lacks `delivery_kind` and `delivery_payload` columns
- **WHEN** the daemon starts
- **THEN** both columns are added with their declared types and defaults

#### Scenario: Startup migration backfills claude-channel rows

- **GIVEN** an existing `agents` row with `channel_session_id='csid-abc'` and no `delivery_*` columns yet
- **WHEN** the daemon starts and the migration completes
- **THEN** the row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: Startup migration is idempotent

- **GIVEN** the daemon has already migrated the database in a previous run
- **WHEN** the daemon starts again
- **THEN** no ALTER statements are issued
- **AND** no existing `delivery_kind` or `delivery_payload` values are overwritten

#### Scenario: Startup migration leaves channel_session_id column untouched

- **GIVEN** the migration runs against an old schema
- **WHEN** the migration completes
- **THEN** every row's original `channel_session_id` value is unchanged

### Requirement: register_agent accepts optional delivery field

The `register_agent` MCP tool SHALL accept an optional `delivery: DeliverySpec` field in its input.  When omitted, the tool behaves as before and persists `delivery_kind='none'`, `delivery_payload=NULL` on insert, or leaves existing delivery untouched on an idempotent re-registration.  When provided, the tool validates it via the `agent-delivery` write validator and persists `delivery_kind` / `delivery_payload` in the same transaction that writes the identity row.

Validation failures SHALL return `{error: 'invalid_delivery', reason: ...}` without writing any row.

#### Scenario: register_agent without delivery preserves existing default behavior

- **GIVEN** a fresh MCP session calling `register_agent({agent_type: 'custom', team: 'default', name: 'alice', model: 'sonnet'})` with no `delivery` field
- **WHEN** the tool returns successfully
- **THEN** the `agents` row for alice has `delivery_kind='none'` and `delivery_payload IS NULL`

#### Scenario: register_agent with delivery kind 'claude-channel' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` alongside identity fields
- **WHEN** the tool returns successfully
- **THEN** the `agents` row has both the identity fields and `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: register_agent with delivery kind 'codex-appserver' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN'}` alongside identity fields
- **WHEN** the tool returns successfully
- **THEN** the `agents` row has `delivery_kind='codex-appserver'`
- **AND** `delivery_payload='{\"thread_id\":\"11111111-1111-4111-8111-111111111111\",\"ws_url\":\"ws://127.0.0.1:8799\",\"auth_token_ref\":\"CODEX_REMOTE_TOKEN\"}'`

#### Scenario: register_agent with invalid codex delivery rejects without inserting

- **GIVEN** a caller supplies `delivery={kind: 'codex-appserver', thread_id: 'not-a-uuid', ws_url: 'ws://127.0.0.1:8799'}` for a not-yet-registered `(team, name)`
- **WHEN** the tool validates the payload
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_thread_id'}`
- **AND** no row is inserted for that identity

### Requirement: register_agent registers a Codex app-server delivery without implicit tmux binding

The daemon SHALL expose Codex app-server registration through `register_agent({ agent_type: 'codex', ... })`.  For Codex callers, the tool accepts the normal identity fields plus optional `ws_url`, `auth_token_ref`, and `thread_id`.  It SHALL:

1. Resolve one or more Codex app-server websocket candidates from explicit input, the legacy single-endpoint environment override, the multi-endpoint environment configuration, or the built-in default.
2. Initialize the Codex protocol for each selected candidate needed to identify the target runtime.
3. If `thread_id` is provided, attempt `thread/resume` only for that thread id and register only when exactly one candidate accepts it.
4. If `thread_id` is omitted, preserve the existing single-endpoint diagnostic flow: call `thread/loaded/list`, attempt `thread/resume` against the loaded thread ids, and return `{ error: 'thread_id_required', detail: { ws_url, thread_ids: [...] } }` instead of registering any thread.
5. Register the caller as `delivery.kind='codex-appserver'` only after a caller-supplied `thread_id` has been confirmed resumable on exactly one endpoint.
6. Leave tmux pane binding unchanged.  If the caller wants tmux fallback delivery, it MUST rely on the normal runtime-binding path or invoke `bind_runtime_identity(...)` explicitly afterward.

The daemon MUST NOT infer the caller's current Codex thread solely from the set of loaded or resumable threads.  The tool surface MUST reject Codex-only top-level fields unless `agent_type='codex'`.  When no new usable pane id is available, the persisted `tmux_pane_id` follows the normal registration semantics: omit on first insert yields `NULL`, omit on re-registration preserves the existing value.

The Codex registration path is Codex-only.  If no candidate websocket endpoint is reachable or speaks the expected Codex protocol, the tool SHALL return `{error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? }}` rather than guessing.  If multiple candidates accept the same `thread_id`, it SHALL return `{ error: 'codex_endpoint_ambiguous', detail: { thread_id, ws_urls } }` without mutating an agent row.

#### Scenario: register_agent registers a caller-supplied Codex thread_id without changing tmux pane state

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', team: 'default', role: 'worker', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** exactly one configured candidate accepts `thread/resume` for `11111111-1111-4111-8111-111111111111`
- **WHEN** the tool completes successfully
- **THEN** it returns `{ agent_id, team: 'default', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: '<matched-url>' }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'` and the matched URL
- **AND** the tool does not require tmux pane discovery to succeed

#### Scenario: register_agent rejects Codex thread inputs without agent_type=codex

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **THEN** the MCP tool schema rejects the request as carrying an unknown top-level key
- **AND** the tool does not accept Codex-only fields unless `agent_type='codex'`

#### Scenario: explicit runtime binding can follow Codex register_agent

- **GIVEN** the caller first succeeds with `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the caller still has no usable persisted `tmux_pane_id`
- **WHEN** the caller later invokes `bind_runtime_identity(...)` successfully
- **THEN** the existing `delivery.kind='codex-appserver'` remains intact
- **AND** the caller row gains the verified `tmux_pane_id` written by the runtime-binding path

#### Scenario: re-registration preserves existing pane when no new pane is found

- **GIVEN** agent `(default, lead)` already exists with `tmux_pane_id='%42'`
- **AND** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', team: 'default', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** exactly one configured candidate accepts `thread/resume`
- **AND** Codex tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row keeps `tmux_pane_id='%42'`
- **AND** the caller's `agents` row is updated with the newly confirmed `delivery.kind='codex-appserver'`

#### Scenario: register_agent requires explicit thread_id when resumable threads exist for Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the selected single websocket endpoint reports resumable thread ids `['11111111-1111-4111-8111-111111111111']`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'thread_id_required', detail: { ws_url, thread_ids: ['11111111-1111-4111-8111-111111111111'] } }`
- **AND** no `agents` row is inserted or updated for the caller

#### Scenario: register_agent returns no_loaded_threads for Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the selected single Codex app-server reports zero loaded threads
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'no_loaded_threads', detail: { ws_url } }`

#### Scenario: register_agent returns codex_resume_failed for an explicit thread_id

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** no initialized candidate accepts `thread/resume`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'codex_resume_failed', detail: { thread_id: '11111111-1111-4111-8111-111111111111', attempts: [...] } }`

#### Scenario: register_agent rejects an ambiguous Codex endpoint match

- **GIVEN** two configured app-server candidates both accept `thread/resume` for the caller's `thread_id`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'codex_endpoint_ambiguous', detail: { thread_id, ws_urls } }`
- **AND** no `agents` row is inserted or updated for the caller

#### Scenario: register_agent returns unsupported_client outside Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** every selected websocket endpoint is unreachable or does not implement the Codex protocol
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? } }`

### Requirement: list_agents returns delivery field

`list_agents` response entries SHALL include a `delivery` field that is a public projection of the agent's internal `DeliverySpec`. The projected shape is strictly limited to the kind discriminant and, for `claude-channel`, the `channel_session_id` already exposed separately at the top level:

- For any agent, `delivery.kind` is one of the supported `DeliveryKind` values (`'none'`, `'claude-channel'`, `'codex-appserver'`).
- For `delivery.kind === 'claude-channel'`, `delivery` also includes `channel_session_id: string`.
- For all other kinds, `delivery` includes only `kind`.

Transport-specific routing fields — specifically `thread_id`, `ws_url`, and `auth_token_ref` for `codex-appserver`, and any future kind's payload — SHALL NOT appear in `list_agents` response entries. Internal callers (dispatchers, `AgentsRepo.getById`) continue to see the full `DeliverySpec`; only the MCP wire response is projected.

#### Scenario: list_agents surfaces delivery for kind 'claude-channel'

- **GIVEN** team `default` has agent `alice` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `delivery: {kind: 'claude-channel', channel_session_id: 'csid-abc'}`

#### Scenario: list_agents surfaces delivery kind 'none' for agents with no channel

- **GIVEN** team `default` has agent `bob` with `delivery_kind='none'` and `delivery_payload IS NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `bob` has `delivery: {kind: 'none'}`

#### Scenario: list_agents hides codex-appserver routing fields from peers

- **GIVEN** team `default` has agent `carol` with `delivery_kind='codex-appserver'` and `delivery_payload='{\"thread_id\":\"11111111-1111-4111-8111-111111111111\",\"ws_url\":\"ws://127.0.0.1:8799\",\"auth_token_ref\":\"env:TOKEN\"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `carol` has `delivery.kind === 'codex-appserver'`
- **AND** the entry for `carol` has no `delivery.thread_id` field
- **AND** the entry for `carol` has no `delivery.ws_url` field
- **AND** the entry for `carol` has no `delivery.auth_token_ref` field

### Requirement: Agents table includes channel_session_id column

The `agents` table SHALL retain the existing nullable column `channel_session_id TEXT` for backward compatibility.  This column is now legacy and read-only: no code path in the daemon SHALL `INSERT` or `UPDATE` the `channel_session_id` column directly; the authoritative delivery state lives in `delivery_kind` / `delivery_payload`, see `agent-delivery/spec.md`.  The column remains in `PRAGMA table_info` output so that databases migrated from older daemons continue to round-trip through backup and restore.  Removing this column is deferred to a later change.

#### Scenario: Fresh database still creates agents table with channel_session_id column

- **WHEN** the daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists a column named `channel_session_id`
- **AND** the column has type `TEXT` and `notnull = 0`
- **AND** rows inserted without providing `channel_session_id` have `NULL` in that column

#### Scenario: No write path updates the legacy column directly

- **GIVEN** an arbitrary sequence of `register_agent` and `bind_channel` calls against the daemon
- **WHEN** the sequence completes
- **THEN** at no point is any SQL of the form `UPDATE agents SET channel_session_id = ...` or `INSERT INTO agents (... channel_session_id ...)` executed by daemon code

### Requirement: list_agents returns channel_session_id field

`list_agents` response entries SHALL continue to include a `channel_session_id: string | null` field for backward compatibility.  This field is now derived from `delivery` per the rule in `agent-delivery/spec.md`: it equals `delivery.channel_session_id` when `delivery.kind === 'claude-channel'`, and is `null` otherwise.  The field is no longer populated by reading the legacy column value directly.

#### Scenario: list_agents surfaces derived channel_session_id for claude-channel delivery

- **GIVEN** team `default` has agent `alice` with `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` and agent `bob` with `delivery={kind: 'none'}`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `channel_session_id: 'csid-abc'`
- **AND** the entry for `bob` has `channel_session_id: null`

#### Scenario: list_agents returns null channel_session_id for non-claude delivery kinds

- **GIVEN** team `default` has an agent whose `delivery.kind` is anything other than `'claude-channel'`, for example `'none'` or a future kind
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry has `channel_session_id: null`

### Requirement: unregister_self removes the caller's current agent registration

The daemon SHALL expose an MCP tool `unregister_self({})` that only operates on the caller's currently-registered agent identity.

When invoked:

1. The caller MUST already be a registered agent; otherwise return `{ error: 'unknown_agent' }`.
2. The daemon MUST, in one logical operation:
   - delete the caller's row from `agents`
   - release any in-memory session binding and identity claim associated with the caller, so the current MCP session is no longer treated as registered
3. The daemon MUST return `{ ok: true, team: <previous team>, name: <previous name>, agent_id: <previous agent_id> }`.
4. After success, any subsequent business tool call on the same MCP session MUST be rejected as `unknown_agent` until that session registers again.

Historical mailbox events and messages MAY continue to reference the removed `agent_id` as stored text.  `unregister_self` MUST NOT rewrite historical rows.

#### Scenario: Registered caller successfully unregisters itself

- **GIVEN** agent `alice` is registered in team `default`
- **WHEN** `alice` invokes `unregister_self({})`
- **THEN** the response is `{ ok: true, team: 'default', name: 'alice', agent_id: <alice-agent-id> }`
- **AND** the `agents` table no longer has a row with that `agent_id`

#### Scenario: Unregistered session cannot call unregister_self

- **GIVEN** a fresh MCP session that has not called `register_agent`
- **WHEN** it invokes `unregister_self({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: Successful unregister_self clears current session identity

- **GIVEN** agent `alice` successfully invoked `unregister_self({})` on MCP session `sess-A`
- **WHEN** the same session `sess-A` next invokes `get_inbox({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: Same identity can register again after unregister_self

- **GIVEN** agent `alice` in team `default` successfully invoked `unregister_self({})`
- **WHEN** a later MCP session invokes `register_agent({ agent_type: 'custom', model: 'opus-4-7', name: 'alice', team: 'default' })`
- **THEN** the call succeeds
- **AND** the `agents` table contains exactly one row for `(team='default', name='alice')`

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

### Requirement: register_agent accepts claude_ui_pid only for __channel_proxy__ callers

The `register_agent` MCP tool SHALL accept an optional `claude_ui_pid: integer` field.  When the field is provided:

1. The `role` field on the same call MUST equal `'__channel_proxy__'`; otherwise the tool SHALL reject at the schema layer as an invalid field combination (the same error class as existing gated fields).
2. The value MUST be a positive integer; non-integer or non-positive values are rejected at the schema layer.
3. On UPSERT, `claude_ui_pid` is written to the corresponding column on the proxy's agents row.  On re-registration (same `(team, name)` identity) the value is overwritten if the new call supplies it, and preserved otherwise.

For all `role != '__channel_proxy__'` callers, the tool SHALL reject the `claude_ui_pid` key as unrecognized.

#### Scenario: proxy registration persists claude_ui_pid

- **GIVEN** a caller invokes `register_agent({agent_type:'custom', role:'__channel_proxy__', name:'channel-proxy-27245', team:'default', model:'proxy', claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-abc'}})`
- **WHEN** the tool completes successfully
- **THEN** the agents row has `claude_ui_pid=25424`
- **AND** the row's `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: non-proxy caller cannot supply claude_ui_pid

- **WHEN** a caller invokes `register_agent({agent_type:'custom', role:'worker', name:'alice', model:'sonnet', claude_ui_pid:25424})`
- **THEN** the call is rejected at the schema layer
- **AND** no row is inserted or updated

#### Scenario: claude_ui_pid must be a positive integer

- **WHEN** a caller invokes `register_agent({agent_type:'custom', role:'__channel_proxy__', name:'proxy-1', model:'proxy', claude_ui_pid:0})`
- **THEN** the call is rejected at the schema layer

#### Scenario: omitted claude_ui_pid preserves existing value

- **GIVEN** the agents table contains `(default, channel-proxy-27245)` with `claude_ui_pid=25424`
- **WHEN** a new session re-registers the same identity without supplying `claude_ui_pid`
- **THEN** the row's `claude_ui_pid` is still `25424` (preserved, not NULL-ified)

### Requirement: register_agent agent_type=claude-code auto-binds channel_session_id via ui_pid match

When `register_agent({agent_type:'claude-code', ui_pid, ...})` is invoked AND the caller does NOT supply `channel_session_id` via the `delivery` field or any top-level csid argument, the daemon SHALL, after completing the identity UPSERT and any automatic runtime binding, perform a best-effort auto-bind of `delivery.kind='claude-channel'`:

1. Persist the caller's `ui_pid` onto the identity row as `runtime_ui_pid` (this already happens during ui_pid-based automatic runtime binding; when that path is skipped — e.g. tmux detection fails or already converged without ui_pid — the value MUST still be persisted on the row so auto-bind can subsequently find it).
2. Query: find a row where `role='__channel_proxy__'` AND `device = <caller.device>` AND `claude_ui_pid = <caller ui_pid>` AND `last_seen_at > now() - 5 minutes`, ordered by `last_seen_at DESC` with `LIMIT 1`. The query MUST filter by `device` to disambiguate PID collisions across hosts: PIDs are not unique across machines, so a `(device, claude_ui_pid)` match is required to identify the correct proxy. The query MUST NOT filter by team: the channel proxy always registers into `team='default'` per the `claude-channel-transport` startup sequence, while Claude Code hosts typically register into a project-derived team, so a team filter would prevent auto-bind in the common case.
3. If no row matches, no action is taken — the caller's delivery is left as its existing value (typically `'none'`).
4. If a row matches, extract `channel_session_id` from `delivery_payload`. If the csid also has a live `ChannelWakeFanout` sink attached in-memory, write the caller's `delivery_kind='claude-channel'` and `delivery_payload=json_object('channel_session_id', <csid>)` and include `channel_session_id: <csid>` in the response envelope. If the sink is not live, skip the write and behave as if no row matched.

This auto-bind path runs after the caller's identity row exists, before the response is returned. It is best-effort: failures or non-matches MUST NOT fail the `register_agent` call.

If the caller explicitly supplies `channel_session_id` (via `delivery.channel_session_id` or any top-level csid argument), the existing explicit-bind path (identical to `bind_channel` semantics) MUST continue to run, and the auto-bind path MUST NOT be attempted.

Callers with other agent types (`codex`, `opencode`, `custom`) are NOT affected by auto-bind — only `agent_type='claude-code'` triggers it.

#### Scenario: register_agent with agent_type=claude-code and ui_pid auto-binds when proxy row exists on same device

- **GIVEN** a `__channel_proxy__` row exists with `device='host-b'`, `team='default'`, `claude_ui_pid=25424`, `delivery_kind='claude-channel'`, `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller from device `host-b` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/host-b/workspace/foo', ui_pid:25424})` (no `channel_session_id`)
- **THEN** the call succeeds
- **AND** the caller's agents row has `device='host-b'`, `delivery_kind='claude-channel'`, and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **AND** the caller's `runtime_ui_pid` is `25424`

#### Scenario: auto-bind does NOT cross devices when PIDs collide

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `claude_ui_pid=25424`, live `delivery.channel_session_id='csid-host-a'`
- **AND** no `__channel_proxy__` row exists with `device='host-b'`
- **WHEN** a caller from device `host-b` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'` (the `device='host-a'` proxy MUST NOT match a `device='host-b'` caller despite the matching PID)

#### Scenario: register_agent with agent_type=claude-code without ui_pid does NOT auto-bind

- **GIVEN** a `__channel_proxy__` row exists for some proxy
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/host-a/workspace/cross-agent-teams-mcp'})` with no `ui_pid`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code and no matching proxy leaves delivery at none

- **GIVEN** no `__channel_proxy__` row has `device='host-a'` AND `claude_ui_pid=99999`
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:99999})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code skips auto-bind when proxy row's sink is dead

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `claude_ui_pid=25424`, and `delivery.channel_session_id='csid-abc'`
- **AND** no `ChannelWakeFanout` sink is attached under `'csid-abc'` (the proxy's MCP session closed)
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'` (no stale csid bound)

#### Scenario: explicit channel_session_id bypasses auto-bind entirely on register_agent

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `claude_ui_pid=25424`, and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424, channel_session_id:'csid-explicit'})` and `'csid-explicit'` has a live sink attached
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_payload='{\"channel_session_id\":\"csid-explicit\"}'` (explicit value wins, auto-bind did not run)

#### Scenario: auto-bind ignores team: proxy row in team A still matches caller in team B on same device

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `team='default'`, `claude_ui_pid=25424`, `delivery.channel_session_id='csid-abc'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', team:'alpha', ui_pid:25424})`
- **THEN** the caller's agents row is created in team `alpha` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'` (proxy team `default` does NOT block the match; the `(device, claude_ui_pid)` pair uniquely identifies the caller's proxy)

#### Scenario: register_agent with agent_type=codex does NOT auto-bind

- **GIVEN** a live `__channel_proxy__` row with `device='host-a'`, `claude_ui_pid=25424`, and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has its codex-specific delivery (or `delivery_kind='none'` if no codex delivery supplied) — it MUST NOT be set to `claude-channel`

### Requirement: register_agent accepts and enforces device per origin

The `register_agent` MCP tool SHALL accept an optional `device: string` argument and SHALL resolve the row's effective `device` value based on the session's `origin` tag (set by `mcp-transport`):

- When `origin = 'local'` (loopback session): if the caller supplied `device` and it equals the daemon's configured local device label, the value is accepted; if it was supplied and differs from the local label, the daemon SHALL return `{ error: 'device_spoofing_from_loopback' }`; if it was omitted, the daemon SHALL auto-fill `device` with the local label.
- When `origin = 'remote'` (non-loopback session): the caller MUST supply a non-empty `device`. Missing or empty returns `{ error: 'device_required_from_remote' }`. If the supplied value equals the local label, the daemon SHALL return `{ error: 'device_spoofing_local_label_from_remote' }`. If the value contains `:` or exceeds 64 characters, the daemon SHALL return `{ error: 'invalid_device_label' }`.

The `name` field SHALL additionally be rejected with `{ error: 'invalid_name_label' }` when it contains the `:` character (regardless of origin). All other existing `register_agent` validations (delivery, claude_ui_pid, agent_type, etc.) continue to apply unchanged. When the session's `origin` is `'remote'` and the row is successfully written, the daemon SHALL persist the session's peer address in the `remote_addr` column; for `origin='local'` rows `remote_addr` MUST remain NULL.

These error codes are wire-stable. They are returned in the same `{ error: ... }` envelope shape used by existing `register_agent` validation errors and MUST NOT block other unrelated arguments from validation reports when more than one rule is violated (existing precedence rules apply: the first violation in the daemon's check order wins, matching prior behavior for `agent_id_collision` etc.).

#### Scenario: loopback caller omits device — daemon fills local label

- **GIVEN** the daemon is started with `--device host-a`
- **AND** an MCP session was established via loopback (`origin='local'`)
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7'})` (no `device`)
- **THEN** the call succeeds
- **AND** the persisted row has `device='host-a'`
- **AND** `remote_addr IS NULL`

#### Scenario: loopback caller supplies matching device — accepted

- **GIVEN** the daemon is started with `--device host-a`
- **WHEN** a loopback caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-a'})`
- **THEN** the call succeeds
- **AND** the persisted row has `device='host-a'`

#### Scenario: loopback caller spoofs another device — rejected

- **GIVEN** the daemon is started with `--device host-a`
- **WHEN** a loopback caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-b'})`
- **THEN** the response is `{ error: 'device_spoofing_from_loopback' }`
- **AND** no row is written

#### Scenario: remote caller omits device — rejected

- **GIVEN** the daemon is started with `--host 0.0.0.0 --token T --device host-a`
- **AND** an MCP session was established from a non-loopback peer (`origin='remote'`)
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7'})` (no `device`)
- **THEN** the response is `{ error: 'device_required_from_remote' }`
- **AND** no row is written

#### Scenario: remote caller claims local label — rejected

- **GIVEN** the daemon is started with `--device host-a`
- **AND** an MCP session was established from a non-loopback peer
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-a'})`
- **THEN** the response is `{ error: 'device_spoofing_local_label_from_remote' }`
- **AND** no row is written

#### Scenario: remote caller supplies its own device — accepted and remote_addr recorded

- **GIVEN** the daemon is started with `--device host-a`
- **AND** an MCP session was established from a non-loopback peer at `10.0.0.42`
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-b'})`
- **THEN** the call succeeds
- **AND** the persisted row has `device='host-b'`
- **AND** the persisted row has `remote_addr='10.0.0.42'`

#### Scenario: device label containing colon is rejected from remote

- **GIVEN** a remote session
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'has:colon'})`
- **THEN** the response is `{ error: 'invalid_device_label' }`

#### Scenario: device label exceeding 64 characters is rejected

- **GIVEN** a remote session
- **AND** a 65-character device value (e.g. 65 lowercase letters)
- **WHEN** the caller invokes `register_agent({..., device: '<65-char string>'})`
- **THEN** the response is `{ error: 'invalid_device_label' }`

#### Scenario: name containing colon is rejected regardless of origin

- **GIVEN** any MCP session (loopback or remote)
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'bad:name', model:'opus-4-7'})`
- **THEN** the response is `{ error: 'invalid_name_label' }`
- **AND** no row is written

### Requirement: runtime_ui_pid persisted on register_claude_self and register_agent agent_type=claude-code

When `register_agent({agent_type:'claude-code'})` is invoked with `ui_pid`, the daemon SHALL persist that value to the caller's `agents.runtime_ui_pid` column regardless of whether automatic tmux runtime binding converged. This makes `runtime_ui_pid` available to the reactive-rebind path (`claude-channel-transport`: "Proxy registration triggers reactive rebind of matching hosts") even in deployments where tmux binding was bypassed or failed.

#### Scenario: runtime_ui_pid persisted even when tmux detection does not converge

- **GIVEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **AND** tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's agents row has `runtime_ui_pid=25424`
- **AND** the `tmux_pane_id` column is NULL

#### Scenario: runtime_ui_pid overwritten on subsequent re-registration with new ui_pid

- **GIVEN** agent `(default, opus)` already exists with `runtime_ui_pid=111`
- **WHEN** a new MCP session invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:222})`
- **THEN** the row's `runtime_ui_pid` is now `222`

### Requirement: pre_register_codex_pane tool records pending tmux pane claim

The daemon SHALL expose an MCP tool `pre_register_codex_pane` that accepts `pane_id` (string, tmux pane identifier such as `%1972`), `xats_agent_id` (non-empty string, matches the UUID the launcher will place on the `codex --remote` command line via `-c xats.agent_id="<uuid>"`), optional `identity_key` (non-empty, non-whitespace string, the launcher-minted restart-stable identity handle, delivered only over this CLI/HTTP channel), optional `team` and `agent_name` (non-empty, non-whitespace strings, the identity the launcher declares for this pane, subject to the label rules in `Declared identity labels are validated at the pre-registration entry`), and optional `ttl_seconds` (positive integer, default `120`, capped at `600`).  On success it SHALL trim supplied `team` and `agent_name`, persist a pending pre-registration row keyed by `pane_id` (including `identity_key`, normalized `team` and normalized `agent_name` when supplied), and return `{ ok: true, expires_at: <ISO8601> }`.  If `pane_id` or `xats_agent_id` is missing or empty, or `identity_key`, `team` or `agent_name` is supplied but empty or whitespace-only, the tool SHALL return `{ error: "invalid_arguments", detail: <message> }` without writing any state.

`team` and `agent_name` SHALL be independently optional, and neither SHALL imply the other: a launcher that knows only one of them SHALL be able to send it.  Whether a partial declaration is usable is decided where notices are scheduled, not here.

#### Scenario: Launcher pre-registers a pane successfully
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"4EF01740-DBAC-4F39-BD94-64A058815856"})`
- **THEN** the daemon writes a pending pre-reg row for `%1972` with the given UUID and a `ttl_seconds=120` default expiry
- **AND** returns `{ ok: true, expires_at: <now + 120s> }`

#### Scenario: Launcher pre-registers with an identity key
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1", ttl_seconds:300})`
- **THEN** the stored row carries `identity_key="K1"` alongside `xats_agent_id="U1"`
- **AND** returns `{ ok: true, expires_at: <now + 300s> }`

#### Scenario: Launcher pre-registers with a declared identity
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%25", xats_agent_id:"U1", identity_key:"K1", team:"monkeys", agent_name:"mvr-coder"})`
- **THEN** the stored row carries `team="monkeys"` and `agent_name="mvr-coder"` alongside the uuid and key
- **AND** returns `{ ok: true, expires_at: <ISO8601> }`

#### Scenario: A declaration missing one half is still stored
- **WHEN** the launcher supplies `team` without `agent_name`
- **THEN** the row stores the supplied half and leaves the other NULL

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

When a pre-reg for the same `pane_id` already exists, the new call SHALL replace the stored `xats_agent_id`, `identity_key` (including replacing a present key with NULL when the new call omits it), `team` and `agent_name` (each likewise replaced with NULL when the new call omits it), and `expires_at` atomically.  The previous row SHALL NOT leak to subsequent register calls or to recovery-poke scheduling.

A declaration SHALL be cleared by an omitting overwrite for the same reason a key is: the row states what THIS launch announced, and a stale declaration surviving into a launch that did not make it would name an identity nobody currently claims.

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

#### Scenario: Overwrite without a declaration clears the stored declaration
- **WHEN** pane `%25` has a pending pre-reg declaring `team="monkeys"`, `agent_name="mvr-coder"`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%25", xats_agent_id:"B"})` without either field
- **THEN** the row for `%25` now has `team = NULL` and `agent_name = NULL`
- **AND** no notice names `mvr-coder` on behalf of this pane

### Requirement: Expired pending pre-regs are ignored and garbage-collected

A pre-reg row whose `expires_at` is in the past SHALL NOT match any `register_agent` call, even if `pane_id` and argv UUID align.  The daemon SHALL remove expired rows opportunistically (at minimum: on every `pre_register_codex_pane` write and on every codex `register_agent` consumption attempt).

#### Scenario: Expired pre-reg does not match
- **WHEN** a pre-reg for pane `%1972` with UUID `A` was created with `ttl_seconds=60`
- **AND** 120 seconds have elapsed
- **AND** a codex `register_agent` call arrives while the UI in pane `%1972` still has `xats.agent_id="A"` on its argv
- **THEN** the daemon does not auto-bind via the expired pre-reg
- **AND** registration proceeds with the normal no-pane hint fallback

#### Scenario: Expired rows are removed on next write
- **WHEN** pane `%1000` has an expired pre-reg row
- **AND** any client calls `pre_register_codex_pane({pane_id:"%2000", xats_agent_id:"x"})`
- **THEN** the expired row for `%1000` is deleted as part of the write
- **AND** only the new row for `%2000` remains

### Requirement: register_agent auto-binds codex pane via pending pre-reg

BEFORE any pre-reg scan, the daemon SHALL resolve SAME-THREAD SESSION EVIDENCE for the codex registration: agent rows on the same device whose codex-appserver `thread_id` equals the registering thread AND that still carry a bound runtime (`runtime_ui_pid` and/or `runtime_tty`).  The caller's own `(device, team, name)` upsert-reused row counts as evidence exactly when its PRE-UPSERT stored codex-appserver thread equals the effective registering thread — the upsert preserves the row's bound runtime but OVERWRITES its stored thread, so the daemon SHALL capture the pre-upsert thread before the register write; a same-name registration arriving with a NEW thread (restart recovery) contributes no evidence.  Once ANY same-thread evidence exists, the daemon SHALL NEVER scan foreign pre-reg rows and SHALL NEVER run unrestricted global pane detection (`detect_tmux_pane`) for this registration: the only correlation either has is "unique machine-wide candidate", which is no caller association at all, so reaching them can hand the caller an UNRELATED launcher's pending pane, pid, and seat key, or bind a foreign pane (runtime identity corruption).  The evidence rows SHALL be collapsed by PHYSICAL seat: rows sharing a positive `runtime_ui_pid` and/or a `runtime_tty` are ONE seat (a rename chain A→B→C leaves every abandoned row with its pid/tty intact — only the pane is cleared by the last-writer-wins rebind, so multiple same-thread rows are the NATURAL state, not an anomaly), and each seat folds to its last-writer-wins owner (latest `runtime_bound_at`; a still-set pane breaks ties).  A unique physical seat SHALL be inherited EXACTLY: an owner with a positive pid runs the existing `bind_runtime_identity(agent:"codex", ui_pid:<that pid>)` path (which re-verifies pid → tty → pane live); an owner without a positive pid but with a recorded tty AND pane binds EXACTLY that tty/pane via the existing tty/pane bind shape, with no detection substituting another seat.  Multiple DISTINCT physical seats, a failed inherit bind, or a seat with no bindable runtime info SHALL fail closed: no pre-reg scan, no global detection, no runtime bind — `register_agent` still succeeds and takes the standard no-pane-hint path.  ONE inherit failure is exempt: when the seat's carrier is PROVABLY GONE — the seat records a POSITIVE `runtime_ui_pid` that a liveness check confirms is NOT running — the registration SHALL proceed to the pre-reg scan, and to the pre-reg scan ONLY; the global `detect_tmux_pane` fallback SHALL remain out of reach for it, because a vacated seat proves nothing about which pane the caller occupies now.  Inheriting a dead pid is impossible, and failing closed there strands exactly the case recovery exists for: the pane is woken by the recovery poke and has nowhere to land, its pre-reg row is never consumed, and its key never attaches.  The scan is not a guess — it requires a launcher-asserted pane, the full foreground-carrier proof carrying the stored uuid, and a non-foreign key claim.  A seat recording NO positive pid is liveness UNKNOWN, never gone (a tty/pane bind legitimately records none), and SHALL keep failing closed.  A bind that failed because the registration was SUPERSEDED (`stale_registration_bind`) SHALL keep failing closed REGARDLESS of carrier liveness: a registration the row has already moved past must act on nothing, and leaving that to the scan's own generation-conditional write would substitute defence in depth for the rule itself.  The exempt outcome SHALL be logged through the same single decision point with its own distinct outcome name, stating that only the scan was reached.  After a successful inherit the existing seat-follow hook runs as usual: with the inherited seat it finds the key-holding row and thread equality migrates the key.  ONLY a registration with NO same-thread evidence (a genuinely new thread, e.g. post-restart recovery) proceeds to the pre-reg scan below and, failing that, to the `detect_tmux_pane` fallback.

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

#### Scenario: A seat whose carrier is provably gone reaches the pre-reg scan and rebinds
- **GIVEN** the caller's own same-thread row records a POSITIVE `runtime_ui_pid` whose process is no longer running (carrier #1 died with the pane's previous codex), its pane still carries the launcher's fresh pre-reg row with the SAME `identity_key`, and carrier #2 is now the pane's foreground codex
- **WHEN** the restarted codex obeys the recovery notice and re-registers with the same name, team and thread
- **THEN** the inherit bind against the dead pid fails, the seat is classified GONE, and the registration proceeds to the pre-reg scan — which binds carrier #2, consumes the row, and attaches its key
- **AND** `detect_tmux_pane` is never invoked, and the decision is logged with the distinct vacated-seat outcome

#### Scenario: A pid-less seat that fails to bind stays fail-closed
- **GIVEN** same-thread evidence collapsing to one seat that records NO positive pid (a tty/pane bind) whose tty/pane bind fails, and a fully consumable pre-reg row pending on that pane
- **WHEN** the same conversation re-registers with that thread
- **THEN** liveness is UNKNOWN, not gone: the registration fails closed, the pre-reg row and its key remain untouched, and no pane detection runs

#### Scenario: A superseded registration never reaches the scan, however dead its seat
- **GIVEN** registration A inheriting a seat whose recorded pid is not running, while a newer same-name registration re-minted the row's generation during A's bind
- **WHEN** A's conditional write changes zero rows (`stale_registration_bind`)
- **THEN** A fails closed with the ordinary inherit-failure outcome: the carrier being gone does NOT open the scan for a registration the row has already moved past

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

### Requirement: Auto-bind failure does not corrupt register_agent result

Any failure inside the pre-reg lookup / argv matching / `bind_runtime_identity` chain (tmux unavailable, ps failure, bind error, IO error) SHALL be caught and SHALL NOT propagate as a `register_agent` error.  The daemon SHALL log the failure at debug level and fall back to the existing no-pane hint path.  The registered `agent_id` row SHALL be identical to what would have been persisted without the pre-reg feature.

#### Scenario: tmux unavailable during auto-bind
- **GIVEN** a pending pre-reg for pane `%1972`
- **AND** `tmux list-panes` fails because tmux is not running
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon returns the standard register_agent success envelope with the no-pane hint
- **AND** the pre-reg row is not deleted (so a later retry can still succeed)
- **AND** no error is raised to the caller

#### Scenario: bind_runtime_identity internal error
- **GIVEN** a pending pre-reg and a matching UI pid
- **AND** `bind_runtime_identity` fails internally (e.g., SQLite write error)
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon returns the standard register_agent success envelope with the no-pane hint
- **AND** the agent row is still persisted (agent_type=codex, name, etc.)
- **AND** the pre-reg row is not deleted

### Requirement: register_claude_self and register_codex_self tools removed from MCP tool surface

The daemon SHALL NOT register MCP tools named `register_claude_self` or `register_codex_self`. Both names MUST be absent from the `tools/list` response across all MCP transports (Streamable HTTP and stdio). Calls naming either tool MUST fail with the standard MCP `Method not found` (or equivalent unknown-tool) error.

The underlying `RegisterCodexSelfService` class SHALL remain in source and continue to back the `register_agent({agent_type:'codex', thread_id, ...})` route inside `executeRegister`. Only the MCP-tool wrappers are removed; backend services are unchanged.

#### Scenario: tools/list omits register_claude_self

- **WHEN** an MCP client enumerates tools via `tools/list`
- **THEN** the returned tool list does NOT contain an entry whose `name` equals `register_claude_self`

#### Scenario: tools/list omits register_codex_self

- **WHEN** an MCP client enumerates tools via `tools/list`
- **THEN** the returned tool list does NOT contain an entry whose `name` equals `register_codex_self`

#### Scenario: Calling register_claude_self returns method-not-found

- **WHEN** an MCP client calls `tools/call` with `name='register_claude_self'`
- **THEN** the response is an error envelope indicating the tool is not registered (the MCP runtime's standard unknown-tool error)
- **AND** no agents row is created or modified

#### Scenario: Calling register_codex_self returns method-not-found

- **WHEN** an MCP client calls `tools/call` with `name='register_codex_self'`
- **THEN** the response is an error envelope indicating the tool is not registered
- **AND** no agents row is created or modified

### Requirement: register_agent rejects agent_type="codex" without thread_id at schema layer

The Zod schema for `register_agent` SHALL reject any call where `agent_type='codex'` and `thread_id` is missing or an empty string. The rejection MUST happen at the schema-validation layer, BEFORE any backend service runs and BEFORE any agents row is written or read. The error message MUST mention `thread_id` and SHOULD direct launcher pre-reg callers to `pre_register_codex_pane` instead.

The previous `thread_id_required` candidate-list envelope (returned by the deleted `register_codex_self` tool when `thread_id` was omitted) is NOT preserved on the `register_agent` surface — that discovery affordance is replaced by the schema-level rejection plus the DETECTION block in the tool description.

#### Scenario: agent_type='codex' without thread_id is rejected by schema

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5'})` with no `thread_id`
- **THEN** the response is a Zod validation error citing the missing `thread_id`
- **AND** no agents row is created
- **AND** no codex-appserver handshake is attempted

#### Scenario: agent_type='codex' with empty-string thread_id is rejected by schema

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:''})`
- **THEN** the response is a Zod validation error citing the empty `thread_id`
- **AND** no agents row is created

#### Scenario: agent_type='codex' with valid thread_id passes schema and reaches the codex-appserver path

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'019dbf73-e0d8-7cb1-a944-801df112b6e2'})`
- **THEN** the call routes through `RegisterCodexSelfService.register(...)` inside `executeRegister` and writes `delivery.kind='codex-appserver'` on success
- **AND** the response includes `{agent_id, team, thread_id, ws_url}`

#### Scenario: Schema rejection error message names pre_register_codex_pane

- **WHEN** the schema rejects a `agent_type='codex'` call without `thread_id`
- **THEN** the error message string contains the literal substring `pre_register_codex_pane` (or an equivalent reference to launcher pre-reg) so the LLM can self-correct

### Requirement: register_agent({agent_type:'claude-code'}) defaults model via session client info sniff when omitted

When `register_agent` is invoked with `agent_type='claude-code'` and `model` is omitted, the daemon SHALL apply the same model-default it previously applied for `register_claude_self`: it sniffs the caller's MCP session client info (via the existing `getSessionClientInfo()` helper) and supplies the resulting Claude-specific default. The behavior of `register_agent` calls with explicit `model` is unchanged — the explicit value always wins.

#### Scenario: agent_type='claude-code' without model uses session-info-derived default

- **GIVEN** the MCP session's client info reports a Claude Code build whose default model is `'claude-opus-4-7'`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', ui_pid:25424})` with no `model`
- **THEN** the agents row is written with `model='claude-opus-4-7'` (or whatever `defaultClaudeSelfModel(getSessionClientInfo())` returns for that build)

#### Scenario: agent_type='claude-code' with explicit model preserves explicit value

- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'sonnet-4-6'})`
- **THEN** the agents row is written with `model='sonnet-4-6'` (the default-sniff path is NOT consulted)

### Requirement: register_agent({agent_type:'codex'}) defaults ws_url to empty string when omitted

When `register_agent` is invoked with `agent_type='codex'` and `ws_url` is omitted, the daemon SHALL set `ws_url=''` before invoking the codex-appserver path.  `RegisterCodexSelfService` SHALL resolve candidates using this precedence: explicit non-empty `ws_url`, legacy `CROSS_AGENT_TEAMS_CODEX_WS_URL`, JSON array `CROSS_AGENT_TEAMS_CODEX_WS_URLS`, then built-in `ws://127.0.0.1:8799`.  Invalid multi-endpoint JSON or non-WebSocket entries SHALL be rejected as configuration errors before registration mutates state.

#### Scenario: agent_type='codex' without ws_url uses the built-in default

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **AND** neither endpoint environment variable is configured
- **THEN** the daemon connects to `ws://127.0.0.1:8799`
- **AND** the returned `ws_url` reflects that default

#### Scenario: agent_type='codex' without ws_url honors legacy environment override

- **GIVEN** the daemon process environment has `CROSS_AGENT_TEAMS_CODEX_WS_URL=ws://127.0.0.1:8899`
- **AND** it also has a multi-endpoint configuration
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the daemon connects only to the legacy env-override URL
- **AND** the returned `ws_url` is `ws://127.0.0.1:8899`

#### Scenario: agent_type='codex' auto-matches a multi-endpoint runtime

- **GIVEN** `CROSS_AGENT_TEAMS_CODEX_WS_URLS` is `["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]`
- **AND** only the second endpoint accepts the caller's `thread_id`
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the returned `ws_url` is `ws://127.0.0.1:8800`

#### Scenario: invalid multi-endpoint configuration fails closed

- **GIVEN** `CROSS_AGENT_TEAMS_CODEX_WS_URLS` is invalid JSON or contains a non-`ws` URL
- **WHEN** a Codex caller omits `ws_url`
- **THEN** registration returns a machine-readable configuration error
- **AND** no `agents` row is inserted or updated

### Requirement: register_agent tool description contains DETECTION block for agent types

The `register_agent` MCP tool description SHALL contain a clearly marked DETECTION block instructing LLM callers to determine `agent_type` by running a sequence of mechanical probes against their tool shell environment, in order, with first-match-wins semantics. FOUR active probes SHALL be promoted; everything else falls through to a `agent_type="custom"` fallback:

1. `printenv KIMI_XATS_BASE_URL` non-empty → `agent_type='kimi-code'`; pass that value as `base_url`, and pass `session_id` from `printenv KIMI_XATS_SESSION_ID` (the `xats-kimi` launcher pre-creates the session via the kimi server REST API and exports BOTH variables; the id is exact — callers MUST NOT derive it from `~/.kimi-code/session_index.jsonl`, whose last `workDir` match can be a different kimi session in the same directory). `session_id` is REQUIRED for kimi-code — the daemon does NOT auto-resolve it. The env vars are set ONLY by the `xats-kimi` launcher, so their presence is itself the runtime assertion that the caller is kimi-code.
2. `printenv OPENCODE_XATS_BASE_URL` non-empty → `agent_type='opencode'`; pass that value as `base_url`. Do NOT pass `session_id` — the daemon auto-resolves it as the most recently updated session on that base_url. The env var is set ONLY by the `free-xats-opencode` launcher, so its presence is itself the runtime assertion that the caller is opencode.
3. `printenv CODEX_THREAD_ID` non-empty → `agent_type='codex'`, pass that value as `thread_id` (REQUIRED for codex per the Zod refinement); do NOT pass `ui_pid` (the launcher's `pre_register_codex_pane` flow handles tmux pane binding and supplying `ui_pid` from codex disables that path).
4. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type='claude-code'`; pass `$PPID` as `ui_pid` to enable channel auto-bind.
5. None of the above → `agent_type='custom'`, `agent_type_name=<the harness you are running under, e.g. cursor, ...>`. Detect the harness name from your runtime environment when you can — for example, `printenv CURSOR_TRACE_ID` non-empty is a cursor signal — but the DETECTION block MUST also explicitly warn against guessing agent type from system-wide signals like "binary X exists on PATH", because such probes detect what the user has installed, not what runtime the LLM is inside.

The DETECTION block's textual presence is the contract — implementers may reword the prose, but the description MUST contain:

- The five env-based probe signals `KIMI_XATS_BASE_URL`, `KIMI_XATS_SESSION_ID`, `OPENCODE_XATS_BASE_URL`, `CODEX_THREAD_ID`, and `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT`.
- The `agent_type="custom"` fallback rule with the `agent_type_name` requirement.
- A reference to `CURSOR_TRACE_ID` (or equivalent) as an example of how to derive `agent_type_name` for cursor under the custom fallback — NOT as a separate active probe.
- An anti-pattern warning against system-wide probes (the literal phrase "PATH" appearing alongside language about installed binaries vs. runtime identity is sufficient).
- An explicit opencode branch that instructs callers to pass `agent_type='opencode'` with `base_url=$OPENCODE_XATS_BASE_URL`, and to OMIT `session_id` (daemon auto-resolves) unless the caller has an explicit override.
- An explicit kimi-code branch that instructs callers to pass `agent_type='kimi-code'` with `base_url=$KIMI_XATS_BASE_URL` and a REQUIRED `session_id` read from `$KIMI_XATS_SESSION_ID`.

The description MUST NOT contain the previously promoted active probe `command -v opencode` (or any other "binary X is on PATH" probe). The env-based probes are the ONLY sanctioned mechanisms for promoting `agent_type='opencode'` / `agent_type='kimi-code'`; PATH-based probes remain rejected because they assert runtime identity from system-wide state instead of session-local state.

#### Scenario: tools/list returns register_agent description containing KIMI_XATS_BASE_URL probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `KIMI_XATS_BASE_URL`
- **AND** that substring appears in the DETECTION block as the env-var probe for `agent_type='kimi-code'`

#### Scenario: tools/list returns register_agent description containing OPENCODE_XATS_BASE_URL probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `OPENCODE_XATS_BASE_URL`
- **AND** that substring appears in the DETECTION block as the env-var probe for `agent_type='opencode'`

#### Scenario: tools/list returns register_agent description containing CODEX_THREAD_ID probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `CODEX_THREAD_ID`

#### Scenario: tools/list returns register_agent description containing CLAUDECODE probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `CLAUDECODE` OR `CLAUDE_CODE_ENTRYPOINT`

#### Scenario: tools/list returns register_agent description does NOT promote opencode binary probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string does NOT contain the literal substring `command -v opencode`
- **AND** the description string does NOT contain any clause that suggests choosing `agent_type='opencode'` based on the presence of an `opencode` binary on PATH

#### Scenario: tools/list returns register_agent description containing custom fallback rule

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `agent_type="custom"` (or equivalent) AND `agent_type_name` paired with a "required when agent_type=custom" or "your harness name" clause

#### Scenario: tools/list returns register_agent description containing anti-pattern warning

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains language warning against system-wide probes (the literal substring `PATH` appears together with wording that contrasts what the user has installed with what runtime the LLM is inside)

#### Scenario: register_agent description does not name the removed self tools

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string does NOT contain the literal substring `register_claude_self`
- **AND** does NOT contain the literal substring `register_codex_self`

### Requirement: Top-level MCP server instructions describe register_agent with agent_type= detection guidance

The instructions string attached to the MCP `server.setInstructions` call SHALL describe registration in terms of `register_agent` only.  It MUST mention:

- `register_agent` as the single registration entry point.
- That `agent_type="kimi-code"` is selected when `KIMI_XATS_BASE_URL` is non-empty, and that callers pass that value as `base_url` plus a REQUIRED `session_id` read from `$KIMI_XATS_SESSION_ID`.
- That `agent_type="opencode"` is selected when `OPENCODE_XATS_BASE_URL` is non-empty, and that callers pass that value as `base_url` (daemon auto-resolves `session_id`).
- That `agent_type="codex"` requires `thread_id` from `$CODEX_THREAD_ID`.
- That `agent_type="claude-code"` should pass `$PPID` as `ui_pid` for channel auto-bind.
- That ANY other harness (cursor, an editor extension, an unknown caller) uses `agent_type="custom"` with `agent_type_name=<harness name>`.
- An anti-pattern warning that mirrors the DETECTION block: callers MUST NOT guess from system-wide signals like "binary X is on PATH" because that reflects what the user has installed, not what runtime the LLM is inside.

The instructions string MUST NOT contain the literal substrings `register_claude_self` or `register_codex_self`.

The `xats` abbreviation guidance and the `project_dir` team-default convention from the existing instructions string are preserved (covered by `mcp-transport`'s instructions requirement).

#### Scenario: instructions contain register_agent only

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `register_agent`
- **AND** does NOT contain the literal substring `register_claude_self`
- **AND** does NOT contain the literal substring `register_codex_self`

#### Scenario: instructions mention CODEX_THREAD_ID for codex callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `CODEX_THREAD_ID`

#### Scenario: instructions mention OPENCODE_XATS_BASE_URL for opencode callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `OPENCODE_XATS_BASE_URL`

#### Scenario: instructions mention KIMI_XATS_BASE_URL for kimi-code callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `KIMI_XATS_BASE_URL`

#### Scenario: instructions mention agent_type=custom fallback

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string mentions `agent_type="custom"` (or equivalent quoting) AND `agent_type_name`

### Requirement: register_agent treats model as truly optional regardless of agent type

The Zod schema for `register_agent` SHALL accept a missing `model` field for any value of `agent_type`. The previous schema rejection of `model === undefined && agent_type !== 'claude-code' && agent_type !== 'codex'` (with error message `'model is required'`) is removed. When `model` is omitted, the agents row's `model` column is persisted as SQL NULL.

For `agent_type='claude-code'` and `agent_type='codex'`, the existing default-injection rules in `executeRegister` still apply when the field is omitted (`defaultClaudeSelfModel(getSessionClientInfo())` and `'gpt'` respectively); for any other agent type (`opencode`, `custom`), omitted `model` means the column is left NULL.

The `register_agent` tool description and the MCP `serverInfo.instructions` string MUST state that `model` is OPTIONAL for any agent type.

#### Scenario: register_agent with agent_type='custom' and no model succeeds and stores NULL

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', name: 'foo', project_dir: '/tmp/x' })` with no `model`
- **THEN** the call succeeds and returns `{ agent_id, team }`
- **AND** the agents row has `model IS NULL`

#### Scenario: register_agent with agent_type='claude-code' and no model still uses session-info default

- **GIVEN** the MCP session's client info reports a Claude Code build whose default model is `'claude-opus-4-7'`
- **WHEN** a caller invokes `register_agent({ agent_type: 'claude-code', name: 'opus', ui_pid: 25424 })` with no `model`
- **THEN** the agents row has `model = 'claude-opus-4-7'` (the existing claude-code default applies; the row is NOT NULL)

#### Scenario: register_agent with agent_type='codex' and no model still defaults to 'gpt'

- **WHEN** a caller invokes `register_agent({ agent_type: 'codex', name: 'gpt', thread_id: '<uuid>' })` with no `model`
- **THEN** the agents row has `model = 'gpt'` (the existing codex default applies)

#### Scenario: register_agent description states model is OPTIONAL for any agent type

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains language indicating `model` is optional regardless of `agent_type` (the literal substring `OPTIONAL` paired with `model` is sufficient)

### Requirement: Startup migration renames client and client_name columns

On daemon startup, when the `agents` table contains a column named `client` (the pre-rename name) and does NOT yet contain a column named `agent_type`, the daemon SHALL execute these idempotent column-rename migrations in a single transaction:

```sql
ALTER TABLE agents RENAME COLUMN client      TO agent_type;
ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name;
```

Detection MUST use `PRAGMA table_info(agents)` to inspect the current column list. If both `agent_type` and `agent_type_name` already exist (i.e. the migration has already run, or the database is fresh), no ALTER statements are issued. The migration MUST NOT backfill or modify any data — only the column metadata is renamed.

The `claude_ui_pid` migration (additive `ADD COLUMN`) and the `agent_type` rename migration are independent: their order MUST be defined and stable so that a database migrating from a pre-`claude_ui_pid` schema in the same boot cycle ends in a fully migrated state regardless of which migration runs first.

#### Scenario: Startup migration renames client → agent_type on legacy schema

- **GIVEN** an existing `data.db` whose `agents` table has columns including `client TEXT` and `client_name TEXT` (and no `agent_type` / `agent_type_name`)
- **WHEN** the daemon starts
- **THEN** the migration issues `ALTER TABLE agents RENAME COLUMN client TO agent_type`
- **AND** the migration issues `ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name`
- **AND** all existing row data on those two columns is preserved (e.g. a row that had `client='claude-code'` now has `agent_type='claude-code'`)
- **AND** the `client` and `client_name` columns no longer exist in `PRAGMA table_info(agents)`

#### Scenario: Startup migration is idempotent on already-renamed schema

- **GIVEN** the daemon has already migrated the database in a previous run so `agent_type` and `agent_type_name` exist (and `client` / `client_name` do not)
- **WHEN** the daemon starts again
- **THEN** no `ALTER TABLE ... RENAME COLUMN` statement is issued for either column
- **AND** `PRAGMA table_info(agents)` is unchanged

#### Scenario: Fresh database starts with renamed columns and no migration runs

- **GIVEN** the daemon bootstraps a fresh `data.db`
- **THEN** the `agents` table is created directly with `agent_type` and `agent_type_name` columns (the schema CREATE statement uses the new names)
- **AND** no `ALTER TABLE ... RENAME COLUMN` statement is issued during startup
- **AND** the `client` and `client_name` columns never exist in this database

### Requirement: list_agents tool description forbids pre-flight verification before send_message

The `list_agents` MCP tool description SHALL explicitly state that the tool is scoped to the caller's team and that it MUST NOT be used to verify a recipient's existence before calling `send_message`. The description's prose may be reworded, but it MUST contain all of:

1. A statement that `list_agents` returns only agents in the caller's team (e.g., the substring `caller`'s team or `caller-team only`).
2. A statement that `list_agents` cannot see agents in other teams (e.g., the substring `CANNOT` paired with `cross-team`, or equivalent jussive prose).
3. A directive forbidding pre-flight verification before `send_message` (e.g., the substring `DO NOT` paired with `send_message` and the notion of pre-verification, or equivalent jussive prose).
4. A pointer to the canonical miss signal — `unknown_recipient` returned by `send_message` — so the caller understands the recommended recovery path.

The directive language SHALL use jussive form (DO NOT / CANNOT / MUST NOT) rather than advisory hedges (you may / consider / it is recommended), because the observed failure mode is the LLM overriding implicit norms with defensive RLHF behavior.

#### Scenario: list_agents description declares caller-team scope

- **GIVEN** the MCP server has registered the `list_agents` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains a statement that the tool returns agents in the caller's team only (case-insensitive match on `caller`'s team or `caller-team only`)

#### Scenario: list_agents description forbids cross-team verification use

- **GIVEN** the MCP server has registered the `list_agents` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains jussive prose stating that `list_agents` cannot see cross-team agents (case-insensitive match on `CANNOT` together with `cross-team` within the same sentence, or an equivalent MUST NOT formulation)

#### Scenario: list_agents description forbids pre-flight verification before send_message

- **GIVEN** the MCP server has registered the `list_agents` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains the literal substring `send_message`
- **AND** the description contains directive prose forbidding using `list_agents` as a pre-flight check (case-insensitive match on `DO NOT` together with `pre` (as in pre-flight, pre-verify, or pre-check) within the same sentence)
- **AND** the description references `unknown_recipient` as the canonical miss signal returned by `send_message`

### Requirement: register_agent({agent_type:'opencode'}) resolves session_id and writes opencode-server delivery

The daemon SHALL handle `register_agent({agent_type:'opencode'})` as a dedicated branch in `executeRegister`, distinct from the `codex` and `claude-code` branches. The following normative rules apply:

1. `base_url` MUST be a non-empty `http://` or `https://` URL. The Zod schema SHALL reject calls where `base_url` is missing, empty, or not parseable as an http/https URL, BEFORE any backend service runs and BEFORE any agents row is written or read.
2. `session_id` is OPTIONAL. If the caller supplies it, it MUST be a non-empty string starting with `ses` (Zod rejection otherwise). If omitted, the daemon SHALL resolve it by `GET <base_url>/session` and selecting the entry with the largest "updated" timestamp value. The daemon MUST accept both field paths the opencode server has been observed to return: the legacy flat `time_updated` (number, top-level) and the structured `time.updated` (number, nested under a `time` object, as emitted by opencode 1.17.x+). When both paths are present on the same entry, the flat `time_updated` wins. Entries lacking BOTH paths are filtered out. If the resulting candidate list is empty, return `{ error: 'no_active_session', detail: { base_url } }`.
3. The daemon SHALL `GET <base_url>/global/health` before session resolution; if it fails (network error or non-2xx), return `{ error: 'opencode_unreachable', detail: { base_url, cause: <message> } }` and do NOT write any agents row.
4. `auth_token_ref` is OPTIONAL; when supplied it MUST be a trimmed non-empty string and is propagated verbatim into the persisted `delivery_payload`.
5. On success, the daemon writes `delivery={kind:'opencode-server', session_id, base_url, auth_token_ref?}` on the caller's agents row via the `agent-delivery` persistence rules (`UPDATE agents SET delivery_kind='opencode-server', delivery_payload=...`).
6. The successful response envelope SHALL be `{ agent_id, team, session_id, base_url }`. The `session_id` is always present (either caller-supplied or daemon-resolved) so the agent can echo it back to the user.

The schema rejection error message for missing/malformed `base_url` SHOULD reference `OPENCODE_XATS_BASE_URL` so an LLM that forgot to read its environment can self-correct.

This requirement supersedes the previously-deleted `register_opencode_self` tool (which was removed in 2026-04-30). That tool's failure mode was opencode runtime self-identification; the env-var-driven DETECTION block in `register_agent`'s tool description is the sound replacement.

#### Scenario: register_agent({agent_type:'opencode'}) with explicit session_id writes delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', team:'default', base_url:'http://127.0.0.1:18888', session_id:'ses_xyz'})`
- **AND** `GET http://127.0.0.1:18888/global/health` returns `{"healthy":true,...}`
- **THEN** the agents row is written with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_xyz","base_url":"http://127.0.0.1:18888"}'`
- **AND** the response is `{ agent_id: <uuid>, team: 'default', session_id: 'ses_xyz', base_url: 'http://127.0.0.1:18888' }`

#### Scenario: register_agent({agent_type:'opencode'}) without session_id auto-resolves most recent

- **GIVEN** `GET http://127.0.0.1:18888/session` returns sessions `[{id:'ses_a', time_updated: 1000}, {id:'ses_b', time_updated: 2000}, {id:'ses_c', time_updated: 1500}]`
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})`
- **THEN** the agents row is written with `delivery_payload` containing `session_id='ses_b'`
- **AND** the response `session_id` is `'ses_b'`

#### Scenario: register_agent({agent_type:'opencode'}) auto-resolves from nested time.updated (opencode 1.17.x+ format)

- **GIVEN** `GET http://127.0.0.1:18888/session` returns sessions `[{id:'ses_a', time:{created:1000, updated:1000}}, {id:'ses_b', time:{created:1900, updated:2000}}, {id:'ses_c', time:{created:1400, updated:1500}}]` (no top-level `time_updated`)
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})`
- **THEN** the agents row is written with `delivery_payload` containing `session_id='ses_b'`
- **AND** the response `session_id` is `'ses_b'`

#### Scenario: register_agent({agent_type:'opencode'}) treats entries missing both time paths as filtered out

- **GIVEN** `GET http://127.0.0.1:18888/session` returns sessions `[{id:'ses_a'}, {id:'ses_b', time:{}}]` (no usable updated timestamp on any entry)
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})`
- **THEN** the response is `{ error: 'no_active_session', detail: { base_url: 'http://127.0.0.1:18888' } }`
- **AND** no agents row is written

#### Scenario: register_agent({agent_type:'opencode'}) returns no_active_session when session list is empty

- **GIVEN** `GET http://127.0.0.1:18888/session` returns `[]`
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})`
- **THEN** the response is `{ error: 'no_active_session', detail: { base_url: 'http://127.0.0.1:18888' } }`
- **AND** no agents row is written or modified

#### Scenario: register_agent({agent_type:'opencode'}) returns opencode_unreachable when health check fails

- **GIVEN** `GET http://127.0.0.1:9999/global/health` rejects (connection refused)
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:9999'})`
- **THEN** the response is `{ error: 'opencode_unreachable', detail: { base_url: 'http://127.0.0.1:9999', cause: <string> } }`
- **AND** no agents row is written
- **AND** no session-list HTTP request is sent

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects missing base_url

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1'})` with no `base_url`
- **THEN** the response is a Zod validation error citing the missing `base_url`
- **AND** no HTTP request is sent
- **AND** no agents row is written

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects malformed base_url

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'not-a-url'})`
- **THEN** the response is a Zod validation error citing the malformed `base_url`
- **AND** no HTTP request is sent

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects ws:// base_url

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'ws://127.0.0.1:18888'})`
- **THEN** the response is a Zod validation error citing the malformed `base_url`

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects invalid session_id

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888', session_id:'abc'})`
- **THEN** the response is a Zod validation error citing the malformed `session_id`
- **AND** no HTTP request is sent

#### Scenario: register_agent({agent_type:'opencode'}) preserves auth_token_ref in delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888', auth_token_ref:'OPENCODE_SERVER_PASSWORD'})` and the health check passes
- **WHEN** the agents row is written
- **THEN** `delivery_payload` JSON-decodes to an object containing `auth_token_ref: 'OPENCODE_SERVER_PASSWORD'`

### Requirement: register_agent({agent_type:'opencode'}) defaults model to NULL when omitted

When `register_agent` is invoked with `agent_type='opencode'` and `model` is omitted, the daemon SHALL persist `model = NULL` on the agents row. The opencode branch has no model-default inference (unlike `claude-code`'s session-info sniff or `codex`'s `'gpt'` default) because opencode sessions are model-agnostic at registration time. An explicit `model` value always wins.

#### Scenario: agent_type='opencode' without model persists NULL

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})` with no `model`
- **AND** the call succeeds
- **THEN** the agents row has `model IS NULL`

#### Scenario: agent_type='opencode' with explicit model preserves value

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888', model:'glm-5.2'})`
- **THEN** the agents row has `model='glm-5.2'`

### Requirement: register_agent({agent_type:'kimi-code'}) validates inputs and writes kimi-server delivery

The daemon SHALL handle `register_agent({agent_type:'kimi-code'})` as a dedicated branch in `executeRegister`, mirroring the `opencode` branch. The following normative rules apply:

1. `base_url` MUST be a non-empty `http://` or `https://` URL. The Zod schema SHALL reject calls where `base_url` is missing, empty, or not parseable as an http/https URL, BEFORE any backend service runs and BEFORE any agents row is written or read.
2. `session_id` is REQUIRED. It MUST be a trimmed non-empty string (Zod rejection otherwise). Unlike opencode, the daemon MUST NOT auto-resolve `session_id` — kimi has no reliable "most recent session" semantic from inside a session, so the caller passes the exact id from `$KIMI_XATS_SESSION_ID` (exported by the `xats-kimi` launcher, which pre-creates the session via the kimi server REST API) per the DETECTION block.
3. `auth_token_ref` is OPTIONAL; when supplied it MUST be a trimmed non-empty string and is propagated verbatim into the persisted `delivery_payload`.
4. The daemon SHALL NOT perform a health check against the kimi server at registration time (the kimi server may be started later by `start-xats`; reachability failures surface at poke time as `kimi_connect_failed`).
5. On success, the daemon writes `delivery={kind:'kimi-server', session_id, base_url, auth_token_ref?}` on the caller's agents row via the `agent-delivery` persistence rules (`UPDATE agents SET delivery_kind='kimi-server', delivery_payload=...`).
6. The successful response envelope SHALL be `{ agent_id, team, session_id, base_url }`.
7. When `model` is omitted, the daemon SHALL persist `model = NULL` (no model-default inference, same as opencode).

The schema rejection error message for missing/malformed `base_url` or `session_id` SHOULD reference `KIMI_XATS_BASE_URL` / `KIMI_XATS_SESSION_ID` so an LLM that forgot to read its environment can self-correct.

#### Scenario: register_agent({agent_type:'kimi-code'}) writes kimi-server delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', team:'default', base_url:'http://127.0.0.1:58627', session_id:'session_abc'})`
- **WHEN** the call succeeds
- **THEN** the agents row is written with `delivery_kind='kimi-server'` and `delivery_payload='{"session_id":"session_abc","base_url":"http://127.0.0.1:58627"}'`
- **AND** the response is `{ agent_id: <uuid>, team: 'default', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627' }`

#### Scenario: register_agent({agent_type:'kimi-code'}) schema rejects missing session_id

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'http://127.0.0.1:58627'})` with no `session_id`
- **THEN** the response is a Zod validation error citing the missing `session_id`
- **AND** no agents row is written

#### Scenario: register_agent({agent_type:'kimi-code'}) schema rejects missing base_url

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', session_id:'session_abc'})` with no `base_url`
- **THEN** the response is a Zod validation error citing the missing `base_url`
- **AND** no agents row is written

#### Scenario: register_agent({agent_type:'kimi-code'}) schema rejects ws:// base_url

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'ws://127.0.0.1:58627', session_id:'session_abc'})`
- **THEN** the response is a Zod validation error citing the malformed `base_url`

#### Scenario: register_agent({agent_type:'kimi-code'}) preserves auth_token_ref in delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'http://127.0.0.1:58627', session_id:'session_abc', auth_token_ref:'KIMI_SERVER_TOKEN'})`
- **WHEN** the agents row is written
- **THEN** `delivery_payload` JSON-decodes to an object containing `auth_token_ref: 'KIMI_SERVER_TOKEN'`

#### Scenario: register_agent({agent_type:'kimi-code'}) without model persists NULL

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'http://127.0.0.1:58627', session_id:'session_abc'})` with no `model`
- **AND** the call succeeds
- **THEN** the agents row has `model IS NULL`

### Requirement: Registry row removal is not agent termination

Removing an `agents` row — whether via `unregister_self` or via `DELETE /api/agents/:agent_id` — SHALL be understood as deleting the daemon's registration record for an agent, and NOTHING else. It MUST NOT be documented, described, or relied upon as a way to stop, kill, or shut down the agent behind that row.

Removal SHALL NOT touch the process, tmux pane, MCP session, or runtime-side session that the row described. The daemon has no mechanism to terminate any of those, and MUST NOT claim otherwise.

Two consequences SHALL be stated wherever removal is documented:

1. A running agent whose row is removed will fail its next xats tool call with the daemon's unregistered-session rejection, and must call `register_agent` again to become addressable. This is expected behaviour of an operator action, not a fault.
2. For runtimes whose identity is a server-side session rather than a local process — `kimi-code`, whose delivery is `{ kind: 'kimi-server', session_id, base_url }` — the underlying session continues to exist and continues to accept prompts after the row is removed. Removal ends the agent's addressability through xats; it does not end the session.

Historical `messages` and `events` rows MAY continue to reference a removed `agent_id` as stored text. Removal MUST NOT rewrite historical rows.

#### Scenario: Removed row does not stop the underlying runtime

- **GIVEN** a registered `kimi-code` agent whose delivery carries `session_id` `S` on a reachable kimi server
- **WHEN** an operator removes that agent's row via `DELETE /api/agents/:agent_id`
- **THEN** the row is gone and the agent is no longer addressable through xats
- **AND** session `S` still exists on the kimi server and still accepts prompts

#### Scenario: A live agent whose row was removed must re-register

- **GIVEN** an agent with a live MCP session whose row has been removed by an operator
- **WHEN** that agent invokes any business tool
- **THEN** the call is rejected as an unregistered session
- **AND** the agent can recover by calling `register_agent` again

#### Scenario: Historical mail survives removal

- **GIVEN** an agent `A` that has sent messages, and whose row is then removed
- **WHEN** any agent reads mailbox history referencing `A`
- **THEN** the stored `from_agent_id` / sender text for those messages is unchanged

### Requirement: Agents table includes identity_key column

The `agents` table SHALL carry a nullable `identity_key TEXT` column holding an opaque, launcher-minted value that survives a pane restart, plus a `UNIQUE(device, identity_key)` index.  The key is scoped per device because every reconnect lookup is already device-scoped and a key carried to another host is meaningless there; SQLite treats `NULL` as distinct under a unique index, so the unregistered majority of rows are unaffected.

The daemon SHALL add both the column and the index on startup through the existing idempotent schema-healing path, so a database created before this change gains them without operator action, and a database that already has them is left untouched.

The daemon SHALL NOT interpret, parse, or validate the contents of `identity_key` beyond requiring a non-blank string.

#### Scenario: Fresh database carries the column and index

- **WHEN** the daemon initialises a new database
- **THEN** `PRAGMA table_info(agents)` includes `identity_key`
- **AND** a unique index over `(device, identity_key)` exists

#### Scenario: Legacy database is healed on startup

- **GIVEN** a database whose `agents` table predates this change and has no `identity_key` column
- **WHEN** the daemon starts against it
- **THEN** the column and the unique index are added
- **AND** every pre-existing row has `identity_key = NULL`
- **AND** starting the daemon a second time against the same database makes no further schema change and raises no error

#### Scenario: Many rows may hold a null key

- **GIVEN** several agents rows on one device that were registered without an identity key
- **WHEN** another such row is inserted
- **THEN** the unique index does not reject it

### Requirement: register_agent accepts optional identity_key and binds it by a four-branch rule

`register_agent` SHALL accept an optional `identity_key` string.  When supplied, the daemon SHALL resolve it against the caller's device and apply exactly one of four branches:

1. **Unbound** — no row on this device holds the key: the key is written onto the row this call registers.
2. **Idempotent** — the key is already held by the very row this call registers (same `(device, team, name)`): nothing changes.
3. **Migration** — the key is held by a *different* row whose binding is not held by a live process, meaning that row's `runtime_ui_pid` is `NULL`, equals the `ui_pid` of the current call, or names a process that no longer exists: the key moves to the row this call registers and is cleared on the old row.  This is the ordinary rename path — because identity is keyed on `(device, team, name)`, registering under a new name inserts a *new* row rather than updating the old one, so without migration the key would keep pointing at the abandoned identity.
4. **Conflict** — the key is held by a different row whose `runtime_ui_pid` names a live process other than the caller's: the call SHALL fail with `identity_key_conflict` and the error SHALL carry the holding row's `team` and `name` so the operator can diagnose which pane is holding it.  No row is created or mutated.

A `register_agent` call that omits `identity_key` SHALL leave any existing key on the matched row untouched, mirroring how an omitted `delivery` is preserved.  Omitting the key SHALL NOT change behaviour for any pre-existing caller.

The conflict branch is a secondary net only.  It catches two panes registering while both are alive; it cannot catch a key that was copied and later used to recover an identity, because at reconnect time a legitimate restart and a stolen key are indistinguishable.  Preventing duplication remains the minting side's responsibility.

#### Scenario: First registration binds the key

- **GIVEN** no row on device `D` holds key `K`
- **WHEN** an agent calls `register_agent({name: 'tester', team: 'aoe', identity_key: 'K', ...})`
- **THEN** the resulting row has `identity_key = 'K'`

#### Scenario: Re-registering the same identity is idempotent

- **GIVEN** row `(D, aoe, tester)` holds key `K`
- **WHEN** the same identity registers again with `identity_key: 'K'`
- **THEN** the call succeeds
- **AND** the row still holds `K` and keeps its `agent_id`

#### Scenario: Rename migrates the key to the new row

- **GIVEN** row `(D, aoe, tester)` holds key `K` and its `runtime_ui_pid` names a process that no longer exists
- **WHEN** an agent calls `register_agent({name: 'reviewer', team: 'aoe', identity_key: 'K', ...})`
- **THEN** the call succeeds and the new row `(D, aoe, reviewer)` holds `K`
- **AND** row `(D, aoe, tester)` has `identity_key = NULL`
- **AND** a later `reconnect` by `K` resolves to `(aoe, reviewer)`, not `(aoe, tester)`

#### Scenario: Rename from the same live process migrates the key

- **GIVEN** row `(D, aoe, tester)` holds key `K` with `runtime_ui_pid = P`
- **WHEN** a call carrying `ui_pid: P` registers `(aoe, reviewer)` with `identity_key: 'K'`
- **THEN** the key migrates to the new row rather than being rejected

#### Scenario: Two live panes sharing a key is rejected

- **GIVEN** row `(D, aoe, tester)` holds key `K` with `runtime_ui_pid = P`, and process `P` is alive
- **WHEN** a different call whose `ui_pid` is not `P` registers `(aoe, second)` with `identity_key: 'K'`
- **THEN** the response is `identity_key_conflict`
- **AND** the error names `team = 'aoe'` and `name = 'tester'`
- **AND** neither row is created or mutated

#### Scenario: Omitting the key preserves an existing one

- **GIVEN** row `(D, aoe, tester)` holds key `K`
- **WHEN** that identity registers again without an `identity_key` argument
- **THEN** the row still holds `K`

#### Scenario: Blank key is rejected at the schema layer

- **WHEN** a caller passes `identity_key: ''`
- **THEN** the call is rejected by schema validation
- **AND** no row is created or mutated

### Requirement: register_agent tool description instructs callers to present XATS_IDENTITY_KEY

The `register_agent` MCP tool description SHALL instruct callers to read `XATS_IDENTITY_KEY` from their environment and pass it as `identity_key` on **every** registration, including the very first one.  The description MUST state that the key is what makes the identity recoverable after a restart, and that omitting it on the first registration silently disables recovery for that pane with no observable symptom.

This instruction is orthogonal to the existing `agent_type` DETECTION block: `XATS_IDENTITY_KEY` SHALL NOT be added as a first-match-wins `agent_type` probe, because it says nothing about which runtime the caller is.  It applies to every `agent_type`.

The description exists specifically to cover runtimes that have no channel proxy to inline the value for them — codex above all.

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

### Requirement: The pre-reg scan selects by a verifiable caller-to-row correlation

When a codex `register_agent` reaches the pre-registration scan, the daemon SHALL select the row belonging to THAT caller by a correlation the daemon can verify itself, rather than by the count of machine-wide candidates.  Candidate uniqueness SHALL be demoted to a fail-closed backstop used only when no correlation is available; it SHALL NOT be the means of deciding whose row a pending row is.

The correlation SHALL take as its caller-side input only values the delivery path already relies on.  A value the caller reports that the delivery path does NOT already rely on SHALL NOT be sufficient on its own: forging it would not cost the forger anything, while the pane-side carrier proof — which matches the row's stored uuid against a live pane's argv — would then corroborate the forger rather than expose it.  Such a self-reported value MAY be used only as an accelerator whose result is discarded unless it agrees with the daemon-derived correlation.

A correlation that resolves SHALL still be subject to every existing check before anything is written: the full foreground-carrier proof on the row's pane, the identity-key ownership arbitration, the full-snapshot re-read, and the in-transaction re-arbitration.  The correlation decides WHICH row is considered; it SHALL NOT waive any evidence.

#### Scenario: Two overlapping pre-reg windows each bind their own caller
- **GIVEN** two codex panes whose pre-registration rows are both pending and unexpired, each pane hosting its own foreground carrier carrying its own row's uuid
- **WHEN** each pane's codex registers
- **THEN** each registration consumes ITS OWN row and binds ITS OWN pane
- **AND** neither registration is refused for candidate count

#### Scenario: A correlation contradicted by pane evidence fails closed
- **GIVEN** a resolved correlation naming a row whose stored uuid does not appear on any visible pane's carrier
- **WHEN** the caller registers
- **THEN** the registration fails closed with its own reason — no row is consumed, no pane is bound
- **AND** the daemon SHALL NOT fall back to candidate counting for that registration, because doing so would let a correlation failure re-enter the very path the correlation replaced

#### Scenario: A self-reported identifier alone never selects a row
- **GIVEN** a caller reporting a launch identifier that the daemon cannot corroborate from its own sources
- **WHEN** that identifier names a row belonging to another pane
- **THEN** the report is ignored and the registration proceeds as if it had not been made

#### Scenario: No correlation available keeps today's behaviour
- **GIVEN** the correlation cannot be resolved for this caller
- **WHEN** the caller registers
- **THEN** the scan falls back to the existing unique-candidate rule with unchanged behaviour, and the fallback is logged with its own reason

### Requirement: The recovery notice carries a one-time pane token

When the daemon sends a codex recovery poke it SHALL mint a one-time token for
the pane it is sending to, quote that token in the notice, and instruct the
codex to pass it back verbatim on `register_agent`.  The daemon issued the token
to one known pane, so the token-to-pane mapping is a fact the daemon owns rather
than an inference — which is what makes it a correlation and not another
elimination rule.

The token SHALL be minted per SEND, not per schedule: a retry reissues and
retires the previous token, so only the notice actually sitting in the pane can
be quoted back.  It SHALL be spent when the scan begins, not after a successful
bind — a token surviving a failed bind could re-target a LATER registration at a
pane whose row has since moved on.  Minting for a pane SHALL retire that pane's
previous token, and cancelling the pane's recovery schedule (row consumed,
replaced or expired) SHALL clear it, because a token outliving its row would
still name that pane.  The token SHALL be stored in memory only: it is
meaningless once the daemon that issued it is gone, and persisting it would
outlive the pane state it names.

A registration carrying a token the daemon does not recognise SHALL be treated
as offering no correlation and SHALL fall back, never fail.  The recovery notice
SHALL NOT contain the identity key, unchanged from the existing wording rule.

This requirement SHALL NOT be described as making codex recovery automatic, nor
as covering restarts generally.  Three limits are part of it: a FIRST launch
receives no notice and therefore no token, so it still falls back to the
unique-candidate rule; the re-registration the notice asks for stops at the
host's approval prompt unless the user has pre-authorised it, so what is
automatic is the PROMPTING, not the recovery; and whether one restart action
brings two panes back depends on both panes having entered the recoverable
state, which is a property of the launcher's adoption timing rather than of
this requirement.  What this establishes is narrower and worth stating exactly:
a caller that received a notice can name its own pane, so overlapping
pre-registration windows no longer make every one of them fail.

#### Scenario: Two panes restarted together each bind their own
- **GIVEN** two panes with pending pre-reg rows and their own carriers, each having been sent a recovery notice with its own token
- **WHEN** each codex re-registers quoting the token it received
- **THEN** each consumes ITS OWN row and binds ITS OWN pane, and neither registration is refused for candidate count

#### Scenario: A token is spent once
- **GIVEN** a registration that already presented a token
- **WHEN** the same token is presented again
- **THEN** it resolves to nothing and that registration falls back to the unique-candidate rule

#### Scenario: Cancelling the schedule retires the token
- **WHEN** a pane's recovery schedule is cancelled because its row was consumed, replaced or expired
- **THEN** the pane's outstanding token no longer resolves

### Requirement: Correlation outcomes are logged on success as well as failure

The daemon SHALL log the correlation outcome for every codex registration that reaches the scan, including the successful resolution, not only refusals.  A mechanism that reports only its failures becomes invisible once it works, and its later silent breakage would present as the ordinary candidate-count refusal it was introduced to eliminate.

#### Scenario: A resolved correlation leaves a trace
- **WHEN** a registration's correlation resolves and its row is consumed
- **THEN** the decision log records that the row was chosen by correlation, with the caller id and the chosen pane — never any key value

### Requirement: A live keyed pre-registration is only replaceable by its own key

`pre_register_codex_pane` SHALL refuse a write that would replace an existing
pre-registration row when ALL of the following hold: the row is UNEXPIRED, it
carries an `identity_key`, the incoming call does not carry that same key, and
the row's own launch is still present on that pane (a `codex --remote` process
on the pane's tty whose argv carries the ROW's stored uuid).  The refusal SHALL
leave the stored row completely untouched and SHALL be reported as
`pane_claimed` with a detail naming no key value.

Holding SOME key SHALL NOT suffice — only the row's own key.  A key is
obtainable from the shared app-server environment, so "carries a key" would
admit exactly the caller this rule exists to exclude, while the launcher for
that pane always has the matching one.

This rule's premise — that only that pane's launcher holds that pane's key —
has a KNOWN reachable exception, and the requirement is stated with it rather
than around it: a `--remote` model reads the app-server's environment, which
carries ONE `TMUX_PANE` and ONE `XATS_IDENTITY_KEY`, both from the shell that
started it.  Should an app-server ever be started from a keyed codex pane,
every session through it can read that pane's id AND its key together, and its
write would satisfy this rule.  Production does not satisfy the precondition
today (its app-server environment carries no identity key), and the remedy
belongs to app-server launch hygiene rather than to this rule.  Consequently
this requirement SHALL NOT be described as making the write path safe; what it
establishes is that a caller which cannot read the pane's key can no longer
replace its row.

Protection SHALL end when the row's own launch is gone.  Liveness for this
purpose SHALL NOT require the foreground-carrier proof: that proof answers
whether it is safe to paste into the pane, and a suspended codex is still the
same launch.  A probe that cannot be completed SHALL read as NOT protected —
uniquely among this system's liveness rules — because a refusal here blocks a
launcher immediately before `exec codex`, so a transient tmux or ps failure
would break agent startup, a likelier and worse outcome than the overwrite
being guarded against.

A row carrying NO key, an expired row, and a pane with no row SHALL all remain
freely writable, and the liveness probe SHALL NOT be consulted for them.

#### Scenario: A stranger cannot destroy a live identity's handle
- **GIVEN** a pane whose unexpired pre-registration carries an identity key and whose original codex process is still running
- **WHEN** another caller pre-registers that pane with no key, or with a different key
- **THEN** the call is refused with `pane_claimed`, and the stored uuid, key and expiry are unchanged

#### Scenario: The rightful launcher replaces its own row
- **WHEN** a caller pre-registers that pane supplying the row's own identity key
- **THEN** the write is accepted and the row takes the new uuid

#### Scenario: A vacated pane is free again
- **GIVEN** the row's stored uuid no longer matches any process on that pane
- **WHEN** any caller pre-registers that pane
- **THEN** the write is accepted, so a tmux server restart that reissues pane ids never leaves a batch of panes locked for the remainder of their TTL

### Requirement: A first launch can be given a pane token when candidacy is ambiguous

When two or more unexpired pre-registration rows are pending at once, the daemon SHALL be able to give each of those panes a one-time token by the same means it gives one to a restarted pane, and SHALL do so even when no agent row holds the row's `identity_key`.

Without this, the first launch is a closed loop rather than a slow path: a token is minted only when a recovery notice is sent, a recovery notice is scheduled only when an identity already holds the row's key, and an identity acquires that key only by consuming a pre-registration row — which is the step the ambiguity blocks.  Nothing seeds, so nothing ever becomes recoverable, and every subsequent launch of those panes repeats the same round.

The token SHALL be minted ONLY under that ambiguity.  With a single pending row the existing unique-candidate rule already selects correctly, and sending anyway would write into a pane where nothing was ambiguous, which buys nothing and costs an unsolicited write into a pane a person may be using.

A pane SHALL hold at most one live token.  When a pane already has a recovery token, that token SHALL stand and no seeding token SHALL be minted for it: the recovery notice carries strictly more than the seeding one, and two live tokens for one pane would make the pane's identity ambiguous at the moment the token is spent.

The seeding notice SHALL NOT contain the identity key, under the same rule that governs the recovery notice.

#### Scenario: Two first-launch panes each bind their own row

- **GIVEN** two panes with pending unexpired pre-registration rows, neither row's `identity_key` held by any agent row, each pane hosting its own foreground carrier carrying its own row's uuid
- **WHEN** each pane's codex registers quoting the token it was given
- **THEN** each registration consumes ITS OWN row and binds ITS OWN pane
- **AND** neither is refused for candidate count

#### Scenario: A single pending row is not sent anything

- **GIVEN** exactly one pending unexpired pre-registration row
- **WHEN** the row is written
- **THEN** no seeding token is minted and nothing is written into the pane
- **AND** the registration binds through the existing unique-candidate rule

#### Scenario: A recovery token is not displaced by a seeding token

- **GIVEN** pane A with a live recovery schedule and pane B pre-registering as a first launch
- **WHEN** the ambiguity trigger evaluates
- **THEN** pane A keeps its recovery token and receives no seeding token
- **AND** pane B is given a seeding token

#### Scenario: A registration quoting an unknown token still falls back

- **GIVEN** a registration quoting a token the daemon does not recognise
- **WHEN** the pre-reg scan runs
- **THEN** the scan proceeds as if no token had been offered, and never fails for that reason

### Requirement: Binding a runtime does not seed an identity

An agent row SHALL acquire an `identity_key` only by consuming a pre-registration row that carries one.  A runtime binding established by any other path — in particular the `detect_tmux_pane` fallback — SHALL NOT be described or relied upon as making that agent recoverable.

These two states look alike from outside and are not: a row can carry a bound `runtime_ui_pid`, deliver pokes, and appear fully working while holding no key, and such an agent has no restart recovery at all.  Measured 2026-08-01, a production registry held 3 keys across 526 agent rows, including one codex row with a bound pid and no key.  Reading "it binds fine" as "it will recover" is what let this stand: the two are unrelated, and the daemon SHALL NOT present a successful bind as evidence of the second.

#### Scenario: A fallback-bound agent holds no key

- **GIVEN** a codex registration that binds through the `detect_tmux_pane` fallback with no pre-registration row consumed
- **WHEN** the bind succeeds and records a runtime pid
- **THEN** the agent row's `identity_key` remains unset
- **AND** a later restart of that pane finds no holder and schedules no recovery

### Requirement: The seeding token states what it does not supply

This requirement SHALL NOT be described as making a first launch register itself.  Beyond the limits the recovery token already carries — the re-registration stops at the host's approval prompt unless pre-authorised, so what is automatic is the PROMPTING; and whether one action brings two panes back also depends on the launcher's adoption timing — seeding carries one more that is specific to it.

A pane in the seeding round has no xats identity yet.  The notice therefore asks a codex to register under a name and team it does not know, and the token does not supply them: it fixes WHICH row such a registration consumes, not WHO registers.  Something else still has to name the agent.

What this establishes is exactly this and no more: two codex panes asked to register concurrently can each name their own pane, so they stop refusing each other.

#### Scenario: The notice does not assert an identity it does not have

- **GIVEN** a seeding notice being composed for a pane whose row's key is held by no agent row
- **WHEN** the notice content is produced
- **THEN** it names no team and no name as the pane's prior identity
- **AND** it contains no identity key

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

### Requirement: Seat identity for key migration is the pane, never the tty

Seat-follow SHALL NOT treat `runtime_tty` equality as evidence that two rows occupy the same seat, on either branch.

A tty number is drawn from a pool and is reused as soon as the previous pane releases it, so it identifies nothing durable; a tmux pane id is monotonic within a server and is never reused.  Measured 2026-08-01: a brand-new pane inherited a live identity key from an unrelated dead agent on the strength of a recycled tty alone, and a second pane in the same startup matched three further unrelated rows and was spared only because none of them held a key.

The DEAD-holder migration is the branch that most requires this, because it performs no identity verification at all.  Its premise is that the caller is the same pane restarted, and that premise SHALL be established by an identifier that survives the pane rebind and is never recycled.  Matching by `runtime_ui_pid` cannot reach that branch — a pid equal to the caller's own live carrier is classified ALIVE — so the branch's entire input was the reusable identifier, and its "same seat, so no check is needed" justification was therefore circular.

#### Scenario: A recycled tty does not move a key

- **GIVEN** a dead key-holding row whose `runtime_tty` equals a newly bound caller's, with a different pane and a different pid
- **WHEN** seat-follow runs for that caller
- **THEN** no key is moved, and the holder keeps its `identity_key`

#### Scenario: A recycled tty does not suppress a legitimate follow either

- **GIVEN** a caller whose genuine predecessor is matched by pane takeover, and an unrelated key-holding row sharing only the caller's `runtime_tty`
- **WHEN** seat-follow runs
- **THEN** the unrelated row is not a candidate, so the genuine migration is not skipped for ambiguity

### Requirement: The pane rebind preserves the pane it takes over

When a runtime-binding path clears `tmux_pane_id` on another row under the per-device pane exclusivity rule, the daemon SHALL record on that row the pane id being cleared, and seat-follow's dead-holder branch SHALL use it as the seat identity: the holder qualifies when the pane it lost is the pane the caller now holds.

The pane id is destroyed exactly one statement before seat-follow needs it, by code that is already authoritative about the takeover.  Preserving it is what lets the dead-holder branch keep serving the case it was written for — a same-pane restart with no pre-registration row — instead of that case being removed along with the unsound identifier.

A preserved pane id SHALL NOT be read as a live binding: it records that this row once held that pane and lost it, nothing more.

#### Scenario: A same-pane restart still migrates its key

- **GIVEN** a key-holding row whose pane was taken over by the caller's bind, and whose recorded pid is confirmed not running
- **WHEN** seat-follow runs for the caller
- **THEN** the key migrates and is cleared from the holder, in the caller's bind transaction

#### Scenario: A row that never held the caller's pane does not qualify

- **GIVEN** a dead key-holding row that lost a DIFFERENT pane than the one the caller now holds
- **WHEN** seat-follow runs
- **THEN** no key is moved

#### Scenario: The preserved pane is not a binding

- **GIVEN** a row whose pane was taken over
- **WHEN** any path reads its runtime binding
- **THEN** the row is still unbound from that pane — the preserved value never makes it a delivery target

### Requirement: codex_pane_pre_registrations table carries the declared identity

The `codex_pane_pre_registrations` table SHALL carry two nullable columns, `team TEXT` and `agent_name TEXT`, holding the identity a launcher declares for that pane.  Migration SHALL add them to an existing table, leaving every pre-existing row NULL, and SHALL be idempotent when the columns already exist.

The two columns SHALL live on the pre-registration row rather than anywhere longer-lived, because the declaration must share the row's lifetime exactly: overwritten when the row is overwritten, gone when the row is consumed or expires.  A declaration surviving its row would no longer be "what this pane declared on THIS launch", which is the only thing it is allowed to mean.

The declared columns SHALL NOT be added to the full-snapshot currency comparison used by row consumption and recovery-schedule generation (`pane_id`, `xats_agent_id`, `identity_key`, `expires_at`).  That comparison protects binding decisions, and the declaration influences no binding decision — only which identity a notice names.  Declaration replacement is protected deterministically elsewhere: every accepted overwrite SHALL unconditionally retire the old recovery generation with `cancelCodexRecoverySchedule(reason='row_replaced')` before re-evaluating the new row, so an in-flight old send stops at its next generation checkpoint.  Currency comparison is not the safety boundary for declaration replacement.

#### Scenario: Migration adds the columns and leaves old rows null
- **GIVEN** a database whose pre-registration table predates this change
- **WHEN** the schema is applied
- **THEN** `PRAGMA table_info(codex_pane_pre_registrations)` includes `team` and `agent_name`
- **AND** every pre-existing row has both columns NULL

#### Scenario: Applying the schema twice is safe
- **WHEN** the schema is applied to a database that already has both columns
- **THEN** the migration completes without error and no data changes

### Requirement: Declared identity labels are validated at the pre-registration entry

`pre_register_codex_pane` SHALL validate a supplied `team` or `agent_name` against the same label rules the registry applies to an agent's own identity: `agent_name` SHALL NOT contain `:`, `(`, or `)`; `team` SHALL NOT contain `(` or `)`.  Both fields SHALL additionally reject `"`, Unicode control characters (including newlines, carriage returns and tabs), and the Unicode line separators U+2028 and U+2029.  A violation SHALL return `{ error: "invalid_arguments", detail: <message naming the offending field> }` and SHALL write no state.  Double quote carries addressing meaning inside the daemon's fixed recovery-notice template, so accepting it would make the quoted registration identity ambiguous rather than merely unconventional.

The daemon SHALL NOT accept-and-drop, accept-and-truncate, or otherwise tolerate an invalid label.  The reason is the shape of the calling side: a launcher's degrade-and-retry branch can only observe an exit code, so it cannot distinguish "this daemon does not know the flag" from "this daemon knows it and the value is invalid".  A tolerant daemon therefore produces the worst available outcome — the retry drops the declaration, the call succeeds, the pane looks healthy, and the declaration silently does not exist until the next seat rebuild reveals it.  That is the same class of failure this change exists to remove.  A hard refusal instead surfaces the error while a human is still looking at the configuration.

Whitespace-only values SHALL be rejected on the same grounds as an empty `identity_key`.  Supplied values SHALL be trimmed before storage and before the accepted-row recovery hook runs.  Spaces and single quotes inside an otherwise valid label SHALL be accepted; double quotes, control characters and U+2028/U+2029 SHALL be rejected.  The two line separators are named separately because Unicode does not classify them as control characters: rejecting them makes the label contain no line terminator and keeps the notice's addressing field single-line.  This is contract completeness, not mitigation of premature submission; bracketed paste does not submit on these characters.

#### Scenario: A parenthesised name is refused rather than dropped
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%25", xats_agent_id:"U1", team:"monkeys", agent_name:"mvr-coder(monkeys)"})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message naming agent_name> }`
- **AND** no row is written, so the caller cannot mistake this for a stored declaration

#### Scenario: A colon in the name is refused
- **WHEN** the launcher supplies `agent_name:"mvr-coder:jt"`
- **THEN** the call is refused with `invalid_arguments` naming `agent_name`

#### Scenario: A colon in the team is accepted but parentheses are not
- **WHEN** the launcher supplies `team:"monkeys:a"`
- **THEN** the call succeeds, because the team rule constrains only `(` and `)`
- **AND** a later call supplying `team:"monkeys(a)"` is refused with `invalid_arguments` naming `team`

#### Scenario: Spaces and single quotes inside a label are accepted
- **WHEN** the launcher supplies `team:" monkeys team "` and `agent_name:" mvr 'coder' "`
- **THEN** the call succeeds and the row stores `team="monkeys team"` and `agent_name="mvr 'coder'"`

#### Scenario: Double quotes, control characters and line separators are refused
- **WHEN** the launcher supplies `agent_name:"mvr\"coder"` or a label containing `\n`, `\r`, `\t`, U+2028 or U+2029
- **THEN** the call is refused with `invalid_arguments` naming the offending field
- **AND** no state is written

#### Scenario: Whitespace-only values are refused
- **WHEN** the launcher supplies `agent_name:"   "`
- **THEN** the call is refused with `invalid_arguments` naming `agent_name`
- **AND** no state is written

### Requirement: CLI pre-register-codex-pane forwards the declared identity

The `pre-register-codex-pane` CLI SHALL accept optional `--team <value>` and `--agent-name <value>` and forward each as the corresponding tool argument.  The two flags SHALL be independently optional: either may appear without the other.  Both SHALL be added to the known-flag set so that supplying them is not rejected as an unknown flag.

The flag SHALL be named `--agent-name`, not `--name`.  This CLI already carries `--agent-id` for the codex launch uuid, which is an unrelated dimension; a bare `--name` beside it reads as that identifier's name.  `--agent-name` also makes every flag correspond one-to-one with its environment-variable twin (`--team` ↔ `XATS_TEAM`, `--agent-name` ↔ `XATS_AGENT_NAME`).

A value SHALL be forwarded verbatim, including spaces and quotes that survived shell escaping; the daemon owns label validation and the CLI SHALL NOT duplicate it.

The CLI SHALL nevertheless require each new flag to own a following value token.  A following token beginning with `--` SHALL be treated as the next flag, not as the current flag's value, and the CLI SHALL fail locally with `invalid_arguments` before contacting the daemon.  This is argument-boundary parsing, not duplicated label validation.

#### Scenario: Both flags are forwarded
- **WHEN** the launcher runs `pre-register-codex-pane --pane %25 --agent-id U1 --identity-key-env XATS_IDENTITY_KEY --team monkeys --agent-name mvr-coder`
- **THEN** the tool call carries `team="monkeys"` and `agent_name="mvr-coder"` alongside the pane, uuid and key

#### Scenario: One flag without the other is accepted
- **WHEN** only `--team monkeys` is supplied
- **THEN** the tool call carries `team="monkeys"` and no `agent_name`

#### Scenario: Neither flag leaves the call unchanged
- **WHEN** neither flag is supplied
- **THEN** the tool call is byte-for-byte what it was before this change

#### Scenario: The daemon's label refusal reaches the caller
- **WHEN** `--agent-name 'mvr-coder(monkeys)'` is supplied
- **THEN** the CLI exits non-zero and prints the daemon's `invalid_arguments` envelope naming `agent_name`

#### Scenario: A missing value cannot consume the next flag
- **WHEN** the launcher runs `--team --agent-name mvr-coder`
- **THEN** the CLI exits non-zero with `invalid_arguments` naming `--team`
- **AND** it does not store `--agent-name` as a team

### Requirement: register_agent tool description names the declared-identity environment variables

The `register_agent` MCP tool description SHALL instruct callers to read `XATS_TEAM` and `XATS_AGENT_NAME` from their environment and, when present, register under those values instead of asking a human which identity they are.  The instruction SHALL be written for every `agent_type`, not for codex alone.

The description SHALL state that these variables are the launcher's declaration of who this pane is, and that they are what allows an identity to survive a seat rebuild, which no runtime lookup can do once the pane's identity key has been re-minted.

The description SHALL state that codex is the exception that cannot use them: a codex tool call executes inside the shared app-server, so the values it reads belong to the shell that launched that server rather than to its own pane.  Codex SHALL be told that its launcher delivers the declaration through `pre_register_codex_pane` instead, exactly as with `XATS_IDENTITY_KEY`.

These variables SHALL NOT be added as a branch of the numbered first-match-wins `agent_type` DETECTION sequence: they say nothing about which runtime the caller is.

#### Scenario: Description names both variables
- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description contains the literal substrings `XATS_TEAM` and `XATS_AGENT_NAME`
- **AND** it instructs registering under those values when they are present

#### Scenario: The instruction is not codex-scoped
- **WHEN** the description is inspected
- **THEN** the declared-identity instruction is stated for every `agent_type`
- **AND** it separately records that codex cannot read them and relies on its launcher instead

#### Scenario: The variables are not an agent_type probe
- **WHEN** the description is inspected
- **THEN** neither variable appears as a numbered branch of the `agent_type` DETECTION sequence
- **AND** the existing `agent_type` probes are unchanged
