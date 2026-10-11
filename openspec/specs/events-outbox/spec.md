# events-outbox Specification

## Purpose

Provide an append-only, team-scoped events table that underpins message, contract, and task projections, plus cursor-based replay and bounded retention.
## Requirements
### Requirement: Events table schema

The SQLite database SHALL contain an `events` table with columns `event_id INTEGER PRIMARY KEY AUTOINCREMENT`, `from_team TEXT NOT NULL`, `to_team TEXT NOT NULL`, `event_type TEXT NOT NULL`, `actor_agent_id TEXT`, `payload TEXT NOT NULL /* JSON */`, `created_at TEXT NOT NULL /* ISO8601 */`. It MUST carry two composite indexes: `idx_events_from_team_eventid (from_team, event_id)` and `idx_events_to_team_eventid (to_team, event_id)`. It MUST NOT carry any index keyed on a single `team` column.

For all event types other than cross-team `send_message` (e.g. `agent_registered`, `broadcast` messages, `broadcast_to_role` messages, same-team `send_message`), the writer MUST set `from_team = to_team`. Only cross-team `send_message` may produce rows where `from_team != to_team`.

The set of event types written by the daemon SHALL be exactly: `agent_registered`, `message_sent` (for `send_message`, `broadcast`, `broadcast_to_role`, including the cross-team variant of `send_message`), and any infrastructure events emitted by the channel/runtime layer. The daemon MUST NOT write `contract_registered`, `task_added`, `task_claimed`, or `task_completed` events. Legacy rows of those types from prior versions MAY remain in the table until the 30-day cleanup TTL reaps them, but no consumer reads them.

#### Scenario: Fresh database creates events table with both team-scoped indexes

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('events')` lists columns including `from_team` and `to_team` (both NOT NULL), and does NOT include a plain `team` column
- **AND** `PRAGMA index_list('events')` contains both `idx_events_from_team_eventid` and `idx_events_to_team_eventid`
- **AND** `PRAGMA index_list('events')` does NOT contain `idx_events_team_eventid`

#### Scenario: Non-cross-team event must have equal from_team and to_team

- **WHEN** the daemon appends any event with `event_type != 'message_sent'`, or a `message_sent` event from `broadcast` / `broadcast_to_role` / same-team `send_message`
- **THEN** the inserted row has `from_team == to_team`

#### Scenario: Daemon never emits task or contract event types

- **GIVEN** a running daemon on the new version
- **WHEN** any MCP tool, internal job, or boot-time migration writes to the `events` table
- **THEN** no row is inserted with `event_type IN ('contract_registered', 'task_added', 'task_claimed', 'task_completed')`

### Requirement: Event append returns monotonically increasing event_id

Every call to `EventsOutbox.append({from_team, to_team, event_type, actor_agent_id?, payload})` SHALL return the inserted row's `event_id`. The `from_team` and `to_team` parameters are required and MUST be strings.

Successive appends SHALL return strictly increasing `event_id` values (globally monotonic — the index is across all teams, not per-team).

#### Scenario: Two appends return increasing ids

- **GIVEN** an empty events table
- **WHEN** `append({from_team:'default', to_team:'default', event_type:'x', payload:{}})` is called twice
- **THEN** the second returned id is greater than the first

#### Scenario: Cross-team append records differing from/to teams

- **WHEN** `append({from_team:'alpha', to_team:'beta', event_type:'message_sent', actor_agent_id:'sess-A', payload:{...}})` is called
- **THEN** the inserted row has `from_team='alpha'` and `to_team='beta'`

### Requirement: Team-scoped fan-out query

`EventsOutbox.since({team, since_event_id, limit})` SHALL return rows where `to_team = :team AND event_id > :since_event_id`, ordered by `event_id` ascending, capped by `limit` (default 100, max 500). The `team` parameter filters by `to_team` — i.e. events **targeted at** the named team — because consumers are reading their inbox.

Rows where `from_team = :team` but `to_team != :team` (i.e. the team's outbound cross-team messages) MUST NOT be returned by `since({team})`.  If callers need an outbound audit view, a separate query method is expected (not required by this Requirement).

#### Scenario: Cursor-based pagination returns events targeted at the team

- **GIVEN** events: (1) `from=alpha, to=alpha`, (2) `from=alpha, to=alpha`, (3) `from=alpha, to=beta`, (4) `from=beta, to=alpha`, (5) `from=alpha, to=alpha`
- **WHEN** `since({team:'alpha', since_event_id:0, limit:10})` is queried
- **THEN** the returned rows have event_ids exactly `[1, 2, 4, 5]`
- **AND** event_id 3 (alpha's outbound to beta) is excluded

#### Scenario: since(team) does not leak events targeting other teams

- **GIVEN** events in team `beta` with ids 6..10 (all from_team=to_team='beta')
- **WHEN** `since({team:'default', since_event_id:0, limit:10})` is queried
- **THEN** the returned rows contain none of ids 6..10

### Requirement: Thirty-day uniform cleanup of mailbox-derived tables

A cleanup routine SHALL run periodically (default every 1 hour, overridable via `CLEANUP_INTERVAL_MS`) and delete every row in `events`, `messages`, and `message_delivery_status` that satisfies a uniform 30-day age threshold:

- `messages` rows where `sent_at < now - 30d`
- `message_delivery_status` rows whose `message_id` references a `messages` row marked for deletion
- `events` rows where `created_at < now - 30d`

In addition, the same cleanup pass SHALL delete `agents` rows in two independent steps:

- rows where `role='__channel_proxy__'` AND `last_seen_at < now - 30d`, subject to the live-reference guard defined in the "Cleanup may prune stale channel proxy rows" requirement below;
- rows where `role != '__channel_proxy__'` AND `last_seen_at < now - 30d`, as defined in the "Cleanup does not touch current-state tables" requirement below.

The deletion MUST execute as a single SQLite transaction in child-to-parent order (`message_delivery_status` → `messages` → `events`, with the two `agents` steps executed afterwards within the same transaction) so that no foreign-key reference is dangling at any observable point. The `runCleanup` function MUST return the total number of rows deleted across all four tables.

The 30-day threshold is hard — it MUST NOT be gated by `last_processed_event_id` of any agent, online or otherwise. Agents that have been offline for more than 30 days forfeit any unread mail.

The cleanup routine MUST NOT delete:

- Rows newer than 30 days (regardless of read status).
- Rows in tables other than the four listed above (`events`, `messages`, `message_delivery_status`, `agents`).
- `agents` rows of any role whose `last_seen_at` is within the last 30 days.

#### Scenario: Cleanup deletes 31-day-old rows across all three tables in one transaction

- **GIVEN** an `events` row with `event_id=42`, `created_at = now - 31d`, plus a `messages` row with `event_id=42`, `sent_at = now - 31d`, plus a `message_delivery_status` row keyed by that message
- **WHEN** `runCleanup` runs
- **THEN** all three rows are deleted
- **AND** the deletions occur in the order: `message_delivery_status` first, `messages` second, `events` last
- **AND** the call returns a non-zero `deleted` count

#### Scenario: Cleanup leaves <30-day rows intact

- **GIVEN** an `events` row with `created_at = now - 29d` plus its paired `messages` and `message_delivery_status` rows
- **WHEN** `runCleanup` runs
- **THEN** none of the three rows are deleted

#### Scenario: Cleanup ignores last_processed_event_id

- **GIVEN** all online agents in team `default` have `last_processed_event_id = 0`
- **AND** events / messages / delivery status rows older than 30 days exist
- **WHEN** `runCleanup` runs
- **THEN** those old rows are deleted regardless of any agent's cursor position

#### Scenario: Cleanup leaves recently seen non-proxy agents untouched

- **GIVEN** a non-proxy `agents` row with `registered_at = now - 90d` and `last_seen_at = now - 29d`
- **WHEN** `runCleanup` runs
- **THEN** the row remains

### Requirement: Cleanup does not touch current-state tables

The cleanup routine SHALL only operate on `events`, `messages`, `message_delivery_status`, and `agents`.

The `messages` and `message_delivery_status` tables are projections of the events outbox (each `messages` row carries `event_id REFERENCES events(event_id)` and each `message_delivery_status` row is keyed by `message_id`), so cleanup deletes them in lock-step with the underlying events to preserve referential integrity. Channel proxy rows in `agents` are pure infrastructure registered by the channel proxy launcher, accumulate per Claude Code session start, and SHALL be reaped under the 30-day TTL described above.

Non-proxy `agents` rows SHALL expire under the same 30-day threshold, keyed on `last_seen_at`: a row whose `last_seen_at < now - 30d` MUST be deleted, on every device label alike (a row registered from another device is refreshed only by that session's own tool calls, exactly like a local row). `registered_at` MUST NOT be consulted. The window matches the mailbox retention contract — such an agent has already forfeited its unread mail.

Deleting an expired agent row MUST NOT delete `messages`, `message_delivery_status`, or `events` rows that reference its `agent_id`; those rows carry the id as plain text and age out under their own 30-day rule.

The cleanup contract MUST NOT enumerate the legacy `tasks`, `contracts`, or `contract_subscriptions` tables. Those tables no longer exist on the new version; on upgrade they are dropped during daemon boot (see `daemon-core`).

#### Scenario: Ancient non-proxy agent rows are deleted

- **GIVEN** an `agents` row with `role='default'` (or any non-`__channel_proxy__` role) and `last_seen_at = now - 31d`
- **WHEN** `runCleanup` runs
- **THEN** the row is deleted
- **AND** the returned `deleted` count includes it

#### Scenario: Agent seen within 30 days survives regardless of registration age

- **GIVEN** an `agents` row with `role='default'`, `registered_at = now - 200d`, and `last_seen_at = now - 29d`
- **WHEN** `runCleanup` runs
- **THEN** the row remains

#### Scenario: Expired rows on another device label are deleted too

- **GIVEN** an `agents` row with `device='gx'` (not the local device) and `last_seen_at = now - 31d`
- **WHEN** `runCleanup` runs
- **THEN** the row is deleted

#### Scenario: Mail referencing an expired agent is left to its own retention

- **GIVEN** an `agents` row `old` with `last_seen_at = now - 31d`
- **AND** a `messages` row addressed to `old` with `sent_at = now - 2d`
- **WHEN** `runCleanup` runs
- **THEN** the `agents` row `old` is deleted
- **AND** the `messages` row and its `events` row remain

### Requirement: Cleanup may prune stale channel proxy rows

The cleanup routine SHALL delete `agents` rows that satisfy ALL of the following conditions:

- `role = '__channel_proxy__'`
- `last_seen_at < now - 30d`
- The row's `agent_id` is NOT referenced as a live `channel_session_id` by any other (non-proxy) `agents` row's `delivery_payload` whose `delivery_kind = 'claude-channel'`. (The delivery payload stores the channel proxy's `channel_session_id`; pruning a referenced proxy would silently break message routing for the live host.)

Channel proxy rows that fail any of these conditions MUST be retained.

The deletion MUST occur within the same SQLite transaction as the mailbox-derived cleanup, after the `events` deletion, so that all of `runCleanup`'s deletes commit atomically.

#### Scenario: Stale unreferenced channel proxy is pruned

- **GIVEN** a channel proxy row `P` in team `default` with `last_seen_at = now - 31d`
- **AND** no other `agents` row has `delivery_kind='claude-channel'` referencing `P`'s `channel_session_id`
- **WHEN** `runCleanup` runs
- **THEN** `P` is deleted
- **AND** the call's returned `deleted` count includes the row

#### Scenario: Stale channel proxy still bound to a live host is retained

- **GIVEN** a channel proxy row `P` in team `default` with `last_seen_at = now - 90d` and `channel_session_id = 'csid-X'`
- **AND** non-proxy agent `H` in team `default` with `delivery_kind='claude-channel'` and `delivery_payload` referencing `channel_session_id='csid-X'`
- **WHEN** `runCleanup` runs
- **THEN** `P` is NOT deleted
- **AND** `H`'s `delivery` configuration remains intact

#### Scenario: Recent channel proxy is retained regardless of references

- **GIVEN** a channel proxy row with `last_seen_at = now - 1d`
- **WHEN** `runCleanup` runs
- **THEN** the row is NOT deleted

#### Scenario: Pruning happens in the same cleanup transaction

- **GIVEN** stale events, messages, delivery_status, AND stale unreferenced channel proxy rows all exist
- **WHEN** `runCleanup` runs
- **THEN** all deletions commit atomically as a single SQLite transaction
- **AND** the returned `deleted` count is the sum across `events`, `messages`, `message_delivery_status`, and pruned channel proxy rows

### Requirement: SQLite PRAGMAs on bootstrap

On first connection to the database, the daemon SHALL apply: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`.

#### Scenario: PRAGMAs applied after bootstrap

- **WHEN** daemon opens the database
- **THEN** `PRAGMA journal_mode` returns `wal`
- **AND** `PRAGMA busy_timeout` returns `5000`
- **AND** `PRAGMA foreign_keys` returns `1`

