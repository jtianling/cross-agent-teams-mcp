## MODIFIED Requirements

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
