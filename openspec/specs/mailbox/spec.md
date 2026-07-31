# mailbox Specification

## Purpose

Deliver direct and role-based messages between agents in the same team, persisting through offline periods via the events outbox and cursor-based inbox polling.
## Requirements
### Requirement: Messages table schema and event projection

The database SHALL contain a `messages` table: `id TEXT PRIMARY KEY`, `event_id INTEGER NOT NULL REFERENCES events(event_id)`, `from_team TEXT NOT NULL`, `to_team TEXT NOT NULL`, `from_agent_id TEXT NOT NULL`, `to_agent_id TEXT`, `to_role TEXT`, `subject TEXT`, `body TEXT NOT NULL`, `need_reply INTEGER NOT NULL DEFAULT 1`, `sent_at TEXT NOT NULL`. Every message write MUST be paired with an `events` row of `event_type='message_sent'`, and that events row's `from_team` / `to_team` MUST equal the message row's `from_team` / `to_team` respectively.

For same-team writes (`broadcast`, `broadcast_to_role`, same-team `send_message`), `from_team` MUST equal `to_team`. For cross-team `send_message`, `from_team` and `to_team` MAY differ.

#### Scenario: Sending a same-team message creates paired rows with equal team fields

- **WHEN** `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})` succeeds with sender in team `alpha` (or equivalently `send_message({to_agent_name:'bob', body:'hi'})` resolving to the same UUID)
- **THEN** one new row appears in `messages` with `from_team='alpha'` and `to_team='alpha'`
- **AND** exactly one new row in `events` with matching `event_id` and `from_team='alpha'`, `to_team='alpha'`

#### Scenario: Sending a cross-team message records distinct team fields

- **WHEN** `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})` succeeds with sender in team `alpha` and recipient `bob` genuinely in team `beta`
- **THEN** the new `messages` row has `from_team='alpha'`, `to_team='beta'`
- **AND** the paired `events` row has `from_team='alpha'`, `to_team='beta'`

#### Scenario: messages table exposes need_reply

- **WHEN** the daemon applies the storage schema
- **THEN** the `messages` table contains a `need_reply` column
- **AND** the column is `NOT NULL`
- **AND** the column default is `1`

### Requirement: send_message and send_message_by_id return unknown_recipient on unresolvable target

When the supplied recipient cannot be resolved, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event. "Cannot be resolved" means:

- For `send_message_by_id({to_agent_id})`: no row in `agents` has that `agent_id`, OR the row's `team` field does not equal the caller's team (cross-team is not supported by this tool). `device` is NOT part of this check — UUIDs are globally unique and the caller's device does not constrain UUID lookup.
- For `send_message({to_agent_name, to_team?})`: `AgentsRepo.findByIdentity({ device: resolved_to_device, team: resolved_to_team, name: resolved_name })` returns `undefined` — i.e. no row in `agents` has the matching `(device, team, name)` triple — where:
  - `resolved_name` and `resolved_to_device` come from parsing `to_agent_name` per the "send_message resolves to_agent_name via (device, team, name) lookup" requirement (bare name ⇒ `(name, caller.device)`; `name:device` ⇒ `(name, device)`).
  - `resolved_to_team = to_team ?? caller.team`.

#### Scenario: send_message_by_id with non-existent id

- **GIVEN** no agent with id `uuid-Z` exists
- **WHEN** caller in team 'default' calls `send_message_by_id({to_agent_id:'uuid-Z', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: bare to_agent_name does not exist on caller's device

- **GIVEN** the caller is on device `host-a`, team `default`
- **AND** an agent `(device='host-b', team='default', name='ghost')` exists
- **AND** no agent `(device='host-a', team='default', name='ghost')` exists
- **WHEN** the caller calls `send_message({to_agent_name:'ghost', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (the bare name resolved to the caller's device, where no `ghost` exists)
- **AND** no new event row is created

#### Scenario: name:device syntax does not exist on the specified device

- **GIVEN** the caller is on device `host-a`, team `default`
- **AND** no agent `(device='host-b', team='default', name='ghost')` exists
- **WHEN** the caller calls `send_message({to_agent_name:'ghost:host-b', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: to_agent_name exists in caller team on caller device but explicit to_team points elsewhere

- **GIVEN** agent `(device='host-a', team='alpha', name='bob')` exists only; caller is on device `host-a`, team `alpha`
- **WHEN** caller calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (resolved triple is `(host-a, beta, bob)`, which has no row)
- **AND** no new event row is created

#### Scenario: send_message_by_id pointing at a cross-team agent returns unknown_recipient

- **GIVEN** agent `sess-B` with `agent_id='uuid-B'` is in team `beta`, caller is in team `alpha`
- **WHEN** caller calls `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

### Requirement: send_message resolves to_agent_name via (device, team, name) lookup

When `send_message` is called with `to_agent_name`, the daemon SHALL parse the value into `(name_part, device_part)` as follows:

- If `to_agent_name` contains no `:` character, then `name_part = to_agent_name` and `device_part = caller.device` (the caller's persisted `device` value).
- If `to_agent_name` contains a `:`, split on the FIRST `:` only: `name_part = substring(0, first_colon)`, `device_part = substring(first_colon + 1)`. Both halves MUST be non-empty after the split; if either is empty, the daemon SHALL return `{ error: 'invalid_to_agent_name' }`.

The daemon SHALL then resolve the recipient UUID via `AgentsRepo.findByIdentity({ device: device_part, team: resolved_to_team, name: name_part })`, where `resolved_to_team = to_team ?? caller.team`. The lookup is unambiguous because the `agents_identity_idx` UNIQUE INDEX on `(device, team, name)` guarantees at most one matching row.

If the lookup returns a row, the daemon SHALL proceed with the existing insert + auto-poke pipeline using the resolved `agent_id`, identical to the behaviour of `send_message_by_id` with that UUID.

The `send_message` success envelope SHALL be unchanged: `{ message_id, event_id, recipients: [<resolved_uuid>], poked, poke_skip_reasons?, retry_scheduled, retry_delays_s? }`. The `recipients[]` field SHALL always contain the resolved UUID, never the name or `name:device` literal.

Cross-team sends via `to_agent_name` SHALL set `from_team` / `to_team` on the persisted `messages` and `events` rows to reflect the resolved teams; auto-poke fanout is not suppressed by the cross-team distinction on its own. The `device_part` does NOT appear on `messages` rows — message identity is by agent UUID alone, and the device-scoped lookup is purely a resolution-time concern.

#### Scenario: Same-device same-team send via bare to_agent_name persists and auto-pokes

- **GIVEN** caller `alice` is on `(device='host-a', team='default')` with `tmux_pane_id`
- **AND** `bob` is on `(device='host-a', team='default')` with `tmux_pane_id`; bob's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** alice calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `from_agent_id=<alice.uuid>`, `to_agent_id=<bob.uuid in host-a>`, `from_team='default'`, `to_team='default'`
- **AND** response `recipients` equals `[<bob.uuid in host-a>]`
- **AND** response `poked` is `true`
- **AND** bob's pane receives the wake-up hint

#### Scenario: Cross-device same-team send via name:device

- **GIVEN** caller `alice` is on `(device='host-a', team='default')`
- **AND** `bob` is on `(device='host-b', team='default')`
- **WHEN** alice calls `send_message({to_agent_name:'bob:host-b', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id=<bob.uuid in host-b>`, `from_team='default'`, `to_team='default'`
- **AND** response `recipients` equals `[<bob.uuid in host-b>]`

#### Scenario: Bare name resolves to caller's device when both devices have agents with the same name

- **GIVEN** caller `alice` is on `(device='host-a', team='default')`
- **AND** `creator` exists on both `(device='host-a', team='default')` (uuid `X`) and `(device='host-b', team='default')` (uuid `Y`)
- **WHEN** alice calls `send_message({to_agent_name:'creator', body:'hi'})`
- **THEN** response `recipients` equals `['X']` (caller's device wins)

#### Scenario: name:device crosses both team and device

- **GIVEN** caller `alice` is on `(device='host-a', team='alpha')`
- **AND** `bob` is on `(device='host-b', team='beta')`
- **WHEN** alice calls `send_message({to_agent_name:'bob:host-b', to_team:'beta', body:'hi'})`
- **THEN** the message is persisted with `from_team='alpha'`, `to_team='beta'`, `to_agent_id=<bob.uuid in (host-b, beta)>`

#### Scenario: Success envelope recipients is always the resolved UUID

- **GIVEN** agent `bob` on `(device='host-a', team='default')` with `agent_id='uuid-B'`
- **WHEN** caller A on `(device='host-a', team='default')` calls `send_message({to_agent_name:'bob', body:'hi'})`
- **AND** caller A calls `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** both responses have `recipients === ['uuid-B']`

#### Scenario: Lookup is case-sensitive (byte-equal)

- **GIVEN** agent registered with `name='Bob'` on `(device='host-a', team='default')`
- **WHEN** caller on the same device/team calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (lowercase `bob` does not match stored `Bob`)

#### Scenario: Empty halves around colon are rejected as invalid input

- **WHEN** the caller invokes `send_message({to_agent_name:':host-b', body:'hi'})`
- **THEN** response is `{ error: 'invalid_to_agent_name' }`

- **WHEN** the caller invokes `send_message({to_agent_name:'bob:', body:'hi'})`
- **THEN** response is `{ error: 'invalid_to_agent_name' }`

### Requirement: broadcast excludes sender

`broadcast({body, subject?, auto_poke?})` SHALL fan-out to every agent in the caller's team except the caller itself, across ALL devices that contribute agents to that team. `broadcast` MUST NOT accept any `to_team`, `to_role`, `to_agent_id`, or `to_device` parameter — it is strictly "same-team, all members except sender, every device".

For every recipient, the persisted `messages` row MUST have `from_team` and `to_team` both equal to the caller's team. The paired `events` row MUST have equal `from_team` / `to_team` values. Recipient device is irrelevant to the message rows; routing uses the recipient's `agent_id`.

#### Scenario: Sender not in recipients

- **GIVEN** team `default` has agents `sess-A`, `sess-B`, `sess-C` on `device='host-a'`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`
- **AND** all resulting messages rows have `from_team=to_team='default'`

#### Scenario: Broadcast spans every device in the caller's team

- **GIVEN** the caller is on `(device='host-a', team='default')`
- **AND** team `default` has `alice` on `device='host-a'`, `bob` on `device='host-a'`, and `creator` on `device='host-b'`
- **WHEN** the caller calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains `['alice', 'bob', 'creator']` (order-insensitive; both same-device peers AND the cross-device `creator` are addressed)
- **AND** all resulting messages rows have `from_team=to_team='default'`

### Requirement: get_inbox returns messages after cursor

`get_inbox({ since_event_id?: number, limit?: number = 50 })` SHALL return messages addressed to the caller (by `to_agent_id`, or by `to_role` where the caller's role matches) with `to_team = caller.team` and `event_id > effective_since`, ordered by `event_id` ascending, capped by `limit` (max 200). Response MUST include `{ messages, has_more, last_event_id }` where `last_event_id` is the highest returned event_id (or `effective_since` if none). Each returned message MUST include `need_reply: boolean`.

The server MUST resolve `effective_since` and decide cursor advancement as follows:

1. **Argument omitted** (`since_event_id` is `undefined`): `effective_since = caller.last_processed_event_id`. After producing the response, if `last_event_id > caller.last_processed_event_id`, the daemon MUST advance the caller's row: `UPDATE agents SET last_processed_event_id = :last_event_id WHERE agent_id = :caller AND last_processed_event_id < :last_event_id`. The advance MUST happen in the same transaction as the read so that two concurrent calls cannot both see the same unread tail.
2. **Argument supplied** (any explicit number, including `0`): `effective_since = since_event_id`. The daemon MUST NOT advance the stored cursor — explicit reads are inspection / re-reads / debugging and have no side effect on `last_processed_event_id`.

Cross-team messages are delivered to the recipient's inbox normally, because the cross-team `send_message` writes the recipient's team as `to_team`.

#### Scenario: Default call advances stored cursor

- **GIVEN** caller's `last_processed_event_id = 10`
- **AND** five messages addressed to caller with event_ids 11, 12, 13, 14, 15
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains the five messages
- **AND** `last_event_id === 15`
- **AND** `has_more === false`
- **AND** the caller's `agents.last_processed_event_id` is now `15`

#### Scenario: Subsequent default call returns only newer messages

- **GIVEN** caller's `last_processed_event_id = 15` (from previous call)
- **AND** two new messages addressed to caller with event_ids 16, 17
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains exactly those two messages
- **AND** the caller's `agents.last_processed_event_id` is now `17`

#### Scenario: Default call with no new messages does not regress cursor

- **GIVEN** caller's `last_processed_event_id = 15`
- **AND** no messages addressed to caller with `event_id > 15`
- **WHEN** caller calls `get_inbox({})`
- **THEN** response is `{ messages: [], has_more: false, last_event_id: 15 }`
- **AND** the caller's `agents.last_processed_event_id` is unchanged at `15`

#### Scenario: Explicit since_event_id does not advance the stored cursor

- **GIVEN** caller's `last_processed_event_id = 50`
- **AND** messages addressed to caller with event_ids 51, 52, 53
- **WHEN** caller calls `get_inbox({ since_event_id: 0 })`
- **THEN** response contains every message addressed to caller with `event_id > 0`, including 51..53
- **AND** the caller's `agents.last_processed_event_id` is unchanged at `50`

#### Scenario: Explicit since_event_id higher than stored cursor still does not advance it

- **GIVEN** caller's `last_processed_event_id = 10`
- **AND** messages with event_ids 20, 30 addressed to caller
- **WHEN** caller calls `get_inbox({ since_event_id: 25 })`
- **THEN** response contains the message with event_id 30
- **AND** `last_event_id === 30`
- **AND** the caller's `agents.last_processed_event_id` is unchanged at `10`

#### Scenario: Cursor-based pagination has_more

- **GIVEN** caller's `last_processed_event_id = 0`
- **AND** 120 messages addressed to caller
- **WHEN** caller calls `get_inbox({ limit: 50 })`
- **THEN** returned messages count is 50
- **AND** `has_more === true`
- **AND** the caller's `agents.last_processed_event_id` is advanced to the 50th message's event_id

#### Scenario: Cross-team messages appear in recipient's inbox

- **GIVEN** caller `bob` is in team `beta` with `agent_id='uuid-B'` and `last_processed_event_id = 41`
- **AND** agent `sess-A` in team `alpha` sends `send_message({to_agent_name:'bob', to_team:'beta', body:'cross-team'})`, producing event id 42
- **WHEN** `bob` calls `get_inbox({})`
- **THEN** the response includes the message with `from_agent_id='sess-A'`, `from_team='alpha'`, `to_team='beta'`
- **AND** bob's `last_processed_event_id` is advanced to `42`

#### Scenario: Inbox exposes reply expectation

- **GIVEN** agent `sess-A` sends `send_message_by_id({to_agent_id:'sess-B', body:'FYI', need_reply:false, auto_poke:false})`
- **WHEN** `sess-B` calls `get_inbox({since_event_id: 0})`
- **THEN** the returned message has `need_reply=false`

### Requirement: Mailbox messages are deleted after 30-day retention window

The daemon's cleanup routine SHALL delete every row in `messages` whose `sent_at` is older than 30 days, together with the corresponding rows in `message_delivery_status` (keyed by `message_id`) and the underlying rows in `events` (keyed by `event_id`). Deletion MUST be performed in a single SQLite transaction in child-to-parent order: `message_delivery_status` → `messages` → `events`, so foreign-key references never become dangling mid-transaction.

The 30-day window applies uniformly to direct, broadcast, and broadcast-to-role messages, regardless of whether any recipient has read them. Offline agents that have not polled within 30 days forfeit the messages addressed to them; this is the explicit retention contract — agents must read on their own cadence.

The cleanup routine MUST NOT consult `last_processed_event_id` when deciding whether a message is deletable; the 30-day age threshold is the sole criterion for the message-and-events deletion path.

#### Scenario: 31-day-old message and its event are deleted

- **GIVEN** a message row with `sent_at = now - 31d` and its paired events row with `created_at = now - 31d`
- **AND** a corresponding `message_delivery_status` row for that `message_id`
- **WHEN** `runCleanup` runs
- **THEN** the `message_delivery_status` row is deleted
- **AND** the `messages` row is deleted
- **AND** the `events` row is deleted
- **AND** the deletions occur in a single transaction (child→parent ordering)

#### Scenario: 29-day-old message survives

- **GIVEN** a message row with `sent_at = now - 29d`
- **WHEN** `runCleanup` runs
- **THEN** the `messages` row remains
- **AND** the corresponding `events` row remains
- **AND** the corresponding `message_delivery_status` row remains

#### Scenario: 31-day-old broadcast deletes every recipient's row plus the shared event

- **GIVEN** a broadcast event with `event_id=42`, `created_at = now - 31d`, that produced three `messages` rows for recipients B, C, D (all with `sent_at = now - 31d`) and three `message_delivery_status` rows
- **WHEN** `runCleanup` runs
- **THEN** all three `message_delivery_status` rows are deleted
- **AND** all three `messages` rows are deleted
- **AND** the single `events` row with `event_id=42` is deleted

#### Scenario: Offline agent forfeits unread mail older than 30 days

- **GIVEN** agent A has `last_processed_event_id = 0` and `last_seen_at = now - 45d` (offline)
- **AND** a message addressed to A with `sent_at = now - 35d` and `event_id = 100`
- **WHEN** `runCleanup` runs
- **AND** then A reconnects and calls `get_inbox({})`
- **THEN** A does NOT see that message (it was deleted by the 30-day TTL)
- **AND** the response is `{ messages: [], has_more: false, last_event_id: 0 }` (assuming no other addressed messages)

### Requirement: Offline delivery via events outbox

Messages addressed to an agent that is currently offline SHALL be persisted in `events` and `messages` as usual. When the agent reconnects and calls `get_inbox({since_event_id: <its stored cursor>})`, it SHALL receive those messages.

This contract applies to same-team and cross-team messages alike.

#### Scenario: Message while offline, fetched after reconnect

- **GIVEN** agent `sess-A` is currently disconnected with stored cursor 5
- **WHEN** agent `sess-B` sends a message to `sess-A` creating event 6
- **AND** `sess-A` reconnects and calls `get_inbox({since_event_id: 5})`
- **THEN** the message is returned

### Requirement: Fire-and-forget delivery contract for send_message and broadcast

`send_message` MUST follow a fire-and-forget delivery contract regarding event-outbox semantics:

1. The tool MUST persist to the mailbox (and event outbox) and return synchronously (modulo the optional auto-poke quiet-guard window).
2. The tool's MCP description MUST advise callers that `auto_poke` is the default and may be opted out via `auto_poke:false`.

This Requirement applies to `send_message` only. `broadcast` and `broadcast_to_role` are governed by their own "auto-poke default with parallel fan-out" Requirements, which mandate auto-poke as default rather than fire-and-forget.

#### Scenario: send_message_by_id with auto_poke:false is pure fire-and-forget

- **GIVEN** recipient `sess-B` has a valid `tmux_pane_id` registered in caller's team
- **WHEN** caller `sess-A` calls `send_message_by_id({to_agent_id:'sess-B', body:'any', auto_poke:false})`
- **THEN** no `poke` entry, no tmux-injection event, no side effect beyond mailbox persistence occurs

### Requirement: Auto-poke retry with backoff on guard_failed

When the initial auto-poke guard returns `guard_failed` for a recipient that has a registered `tmux_pane_id`, the daemon MUST schedule up to three background retries with fixed delays: 30 seconds, 180 seconds (3 minutes), and 600 seconds (10 minutes).  Retries MUST NOT be scheduled for recipients whose skip reason is `no_pane`, `self`, or `tmux_unavailable` — only `guard_failed`.

This Requirement applies uniformly to `send_message` (including cross-team), `broadcast`, and `broadcast_to_role`.

Each retry tick MUST:

1. Look up the recipient's current `tmux_pane_id` and `last_seen_at` from the database (no team filter — `agent_id` is globally unique).
2. If the recipient no longer exists or has no pane id: mark the delivery status `failed` with `skip_reason='no_pane'` and stop retrying for that recipient.
3. If `last_seen_at > sent_at` of the originating message: mark the delivery status `skipped` with `skip_reason='recipient_active'` and stop retrying.
4. Otherwise: invoke `runQuietGuard(pane_id)`.  Pass → fire poke with the hint-format wake-up prompt AND the internal `skipGuard` flag set (the tick has already run the quiet-guard, so the poke primitive MUST NOT re-run it — this avoids a redundant second `POKE_QUIET_MS` wait), mark delivery status `delivered`, set `delivered_at`, and stop remaining retries.  Fail → increment `retry_attempts`; if attempts remain, keep status `retrying`; if no attempts remain, mark status `failed` with `skip_reason='retry_exhausted'`.

The sending tool's response (`send_message`, `broadcast`, or `broadcast_to_role`) MUST include:

- `retry_scheduled: boolean` — `true` iff the daemon scheduled at least one retry for any recipient.
- `retry_delays_s?: number[]` — the backoff sequence used (MUST equal `[30, 180, 600]` when `retry_scheduled` is `true`; MAY be absent when `false`).

The daemon MUST clear all pending retry timers on shutdown (e.g. Fastify `onClose` hook) to avoid leaking timer handles.  Retry outcomes MUST NOT write new events or messages back to the sender; they update only the wake delivery status rows.

#### Scenario: Guard_failed recipient schedules 3 retries

- **GIVEN** A and B registered with `tmux_pane_id`, same team, B's pane active, `POKE_QUIET_MS=50`
- **WHEN** A calls `send_message_by_id({ to_agent_id: B, body: "hi" })`
- **THEN** response has `poked: false`, `poke_skip_reasons: [{ agent_id: B, reason: 'guard_failed' }]`
- **AND** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has exactly one entry keyed by `${message_id}:${B}`
- **AND** the delivery status for B is `retrying` with `skip_reason='guard_failed'`

#### Scenario: First retry tick guard passes → poke fires with skipGuard, remaining cancelled

- **GIVEN** the setup above with a retry already scheduled, pointer to attempt 1
- **AND** test uses fake timers, B's pane becomes idle (the tick's guard will pass on re-check)
- **WHEN** 30 seconds of fake-time advance
- **THEN** a poke is fired at B's pane with the internal `skipGuard` flag set (the poke primitive does not re-run the guard)
- **AND** the retry map has no entry for this message/recipient
- **AND** no further timers fire
- **AND** the delivery status for B is `delivered`

#### Scenario: Recipient activity cancels pending retries

- **GIVEN** a retry scheduled at attempt 2 (after attempt 1 also guard_failed)
- **AND** fake timer at t = 35s (past attempt 1, before attempt 2's 180s)
- **WHEN** the recipient makes any MCP call that updates its `last_seen_at` (e.g. `get_inbox`)
- **AND** fake timer advances past attempt 2 (t = 235s)
- **THEN** attempt 2 ticks, observes `last_seen_at > sent_at`, and stops
- **AND** no poke fires on or after t=235s
- **AND** the retry map has no entry after the stop
- **AND** the delivery status for B is `skipped` with `skip_reason='recipient_active'`

#### Scenario: All 3 retries guard_fail, message remains in mailbox only

- **GIVEN** B's pane stays active through all three retry windows
- **WHEN** fake timer advances past 30s, 180s, 600s (total 810s)
- **THEN** no poke ever fires for this send
- **AND** the retry map has no entry after attempt 3 fails
- **AND** the message row in `messages` table for B is intact
- **AND** the delivery status for B is `failed` with `skip_reason='retry_exhausted'`

### Requirement: Send-message auto-poke default with quiet-guard

`send_message` MUST accept an optional `auto_poke: boolean` parameter.  When the parameter is omitted, the default value MUST be `true` — for same-team AND cross-team calls alike.

When `auto_poke` resolves to `true`, the daemon MUST invoke the internal poke primitive for the single recipient.  The primitive performs transport selection and fallback per "poke dispatches via transport abstraction".  The fan-out layer MUST NOT run its own transport-type-gated quiet-guard; the tmux quiet-guard is run by the poke primitive if and only if dispatch reaches the tmux paste branch (per "poke happy path delivers paste and returns before/after tails").  Consequently a recipient with a configured non-tmux transport that is currently unreachable MAY still fall back to a guarded tmux paste, and resolves to `guard_failed` when its pane is active.

The quiet-guard mechanics are unchanged: capture the pane tail, wait `POKE_QUIET_MS` milliseconds (default 2000, overridable via environment variable, positive integer), re-capture, and compare; matching captures (idle pane) allow the paste, differing captures (pane activity) yield `guard_failed` with no paste.  The message MUST still be persisted in the mailbox regardless of the poke outcome.

The daemon MUST skip the poke and record a skip reason when any of the following apply: the recipient has no reachable transport and no registered `tmux_pane_id` (reason `no_pane`), `tmux` is not available on PATH for a tmux-only recipient (reason `tmux_unavailable`), the quiet-guard detects activity on the tmux paste branch (reason `guard_failed`), or the recipient is the caller itself (reason `self`).

The `send_message` response MUST include:

- `message_id, event_id, recipients: string[]` (recipients has length exactly 1 when successful)
- `poked: boolean` — `true` iff the intended recipient was successfully poked.
- `poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>` — present with one entry when the poke was skipped.  Absent when `auto_poke` resolves to `false`.

When the caller provides `auto_poke: false` explicitly, the daemon MUST NOT invoke poke or the guard; the response MUST have `poked: false` and omit `poke_skip_reasons`.

Cross-team auto-poke is identical: the recipient's `tmux_pane_id` is looked up by `agent_id` alone (since agent_id is globally unique), and the poke is injected into that pane.

#### Scenario: Single recipient same-team, idle pane, default triggers poke

- **GIVEN** agent A and agent B are registered with `tmux_pane_id` values on the same team
- **AND** agent B's tmux pane has been idle, `POKE_QUIET_MS=100` for test speed
- **WHEN** agent A calls `send_message_by_id({ to_agent_id: B, body: "hi" })` (auto_poke omitted)
- **THEN** the message is persisted in B's mailbox with `from_team=to_team`
- **AND** the response has `poked: true`
- **AND** B's tmux pane has received the poke injection

#### Scenario: Cross-team auto-poke fires when recipient pane idle

- **GIVEN** agent `alice` in team `alpha` and agent `bob` (`agent_id=B`) in team `beta`, both with `tmux_pane_id`
- **AND** bob's pane idle, `POKE_QUIET_MS=100`
- **WHEN** alice calls `send_message({to_agent_name: 'bob', to_team: 'beta', body: "hi"})` (auto_poke omitted)
- **THEN** the message is persisted with `from_team='alpha', to_team='beta'`
- **AND** the response has `poked: true`
- **AND** bob's pane received the poke injection

#### Scenario: Recipient's pane is active, guard fails, falls back to mailbox

- **GIVEN** agent A and B same team, both with `tmux_pane_id`, B's pane actively outputting, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body:"hi"})`
- **THEN** the message is persisted
- **AND** response `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'guard_failed'}`

#### Scenario: Recipient has no transport

- **GIVEN** B registered without `tmux_pane_id` and without any configured non-tmux transport (same or cross team)
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})`
- **THEN** response `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'no_pane'}`

#### Scenario: Recipient with claude-channel delivery does not require tmux pane

- **GIVEN** B is registered with `delivery={kind:'claude-channel', channel_session_id:'csid-b'}` and no `tmux_pane_id`
- **AND** the channel proxy subscribing to `csid-b` is online
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})` (auto_poke omitted)
- **THEN** the poke primitive delivers via the claude-channel transport without reaching the tmux paste branch, so no quiet-guard runs
- **AND** the response has `poked: true`
- **AND** `poke_skip_reasons` is absent or empty

#### Scenario: Recipient with opencode binding does not require tmux pane

- **GIVEN** B is registered with `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-b'`, and no `tmux_pane_id`
- **AND** the opencode server accepts the wake prompt for `sess-b`
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})` (auto_poke omitted)
- **THEN** the poke primitive delivers via the opencode transport without reaching the tmux paste branch, so no quiet-guard runs
- **AND** the response has `poked: true`
- **AND** `poke_skip_reasons` is absent or empty

#### Scenario: Channel recipient with offline sink falls back to guarded tmux against active pane

- **GIVEN** B is registered with `delivery={kind:'claude-channel', channel_session_id:'csid-b'}` AND `tmux_pane_id='%42'`
- **AND** no sink is attached for `csid-b` (channel offline) and B has no bound opencode session
- **AND** `%42` is actively redrawing, `POKE_QUIET_MS=100` for test speed
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})` (auto_poke omitted)
- **THEN** the poke primitive falls back to the tmux branch, runs the quiet-guard, and detects activity
- **AND** the response has `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'guard_failed'}`
- **AND** `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** no paste is injected into `%42`

#### Scenario: auto_poke:false disables the behavior entirely

- **GIVEN** A and B both registered with tmux pane ids, idle pane
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi", auto_poke: false})`
- **THEN** the message persists, response `poked: false`, `poke_skip_reasons` absent, B's pane NOT injected

#### Scenario: Invalid POKE_QUIET_MS env falls back to default

- **GIVEN** `process.env.POKE_QUIET_MS = 'not-a-number'`
- **WHEN** daemon boots and handles an auto-poke send_message
- **THEN** the quiet window is 2000ms (default) and the daemon does not crash

### Requirement: Broadcast auto-poke default with parallel fan-out

`broadcast` MUST accept an optional `auto_poke: boolean` parameter. When omitted, the default MUST be `true` (matching `send_message` behavior). When the caller explicitly passes `auto_poke: false`, the daemon MUST persist the message to every recipient's mailbox and skip all guard / poke / retry logic; the response MUST have `poked: false`, omit `poke_skip_reasons`, and have `retry_scheduled: false`.

When `auto_poke` resolves to `true`, the daemon MUST:

1. Persist the message to every recipient's mailbox (one row per recipient sharing one `event_id`, all with `from_team=to_team=caller.team`).
2. For every recipient, in parallel via `Promise.all`, invoke the internal poke primitive.  The primitive performs transport selection + fallback and runs the tmux quiet-guard if and only if it reaches the tmux paste branch (per "poke dispatches via transport abstraction" and "poke happy path delivers paste and returns before/after tails").  The fan-out layer MUST NOT run its own transport-type-gated guard.  A recipient whose only reachable route is a tmux paste against an active pane resolves to `guard_failed`; a recipient with no reachable transport and no `tmux_pane_id` resolves to `no_pane`; a tmux-only recipient with `tmux` not on PATH resolves to `tmux_unavailable`; the caller resolves to `self` (broadcast already excludes sender, but defensive).
3. For every recipient that resulted in `guard_failed` AND has a `tmux_pane_id`, schedule the same 3-attempt retry-with-backoff (30s / 180s / 600s) specified in "Auto-poke retry with backoff on guard_failed".
4. The total wall-clock duration MUST approximate one `POKE_QUIET_MS` window (~2000ms default), not `N × POKE_QUIET_MS`, because guards run in parallel.

The `broadcast` response MUST include:

- `poked: boolean` — `true` iff at least one recipient was successfully poked.
- `poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>` — one entry per recipient that was attempted but skipped. Absent when `auto_poke` resolves to `false`.
- `retry_scheduled: boolean` — `true` iff at least one recipient was queued for retry.
- `retry_delays_s?: number[]` — equals `[30, 180, 600]` when `retry_scheduled` is `true`; absent otherwise.

The `broadcast` MCP tool description MUST state that auto-poke is the default, that the tool targets the caller's team only (no cross-team variant), and SHOULD reference `broadcast_to_role` as the way to restrict by role.

#### Scenario: Default broadcast pokes every idle pane in parallel

- **GIVEN** team has agents A, B, C, D all registered with `tmux_pane_id` and idle panes
- **AND** `POKE_QUIET_MS=100` for test speed
- **WHEN** A calls `broadcast({body:'status update'})` (auto_poke omitted)
- **THEN** B, C, D each have the message in their mailbox
- **AND** the response has `poked: true`
- **AND** `poke_skip_reasons` is absent or empty
- **AND** B, C, D's panes have all received poke injection
- **AND** the total call duration is < 400ms (parallel, not 3 × 100ms serial plus overhead)

#### Scenario: Default broadcast with mixed pane states reports per-recipient skip reasons

- **GIVEN** team has A, B, C with `tmux_pane_id` and D without
- **AND** B's pane is idle, C's pane is active, `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast({body:'mixed'})` (auto_poke omitted)
- **THEN** B, C, D all have the message in mailbox
- **AND** response `poked: true` (because B was poked)
- **AND** `poke_skip_reasons` contains `{agent_id: C, reason: 'guard_failed'}` and `{agent_id: D, reason: 'no_pane'}`
- **AND** `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]` (because C is in retry queue)

#### Scenario: Explicit auto_poke:false reverts to pure mailbox delivery

- **GIVEN** team has A, B, C all with idle `tmux_pane_id`
- **WHEN** A calls `broadcast({body:'low priority', auto_poke:false})`
- **THEN** B, C have the message in mailbox
- **AND** response `poked: false`, `poke_skip_reasons` absent, `retry_scheduled: false`
- **AND** no `tmux capture-pane` or `send-keys` command was issued for B or C

#### Scenario: Broadcast tool description states same-team scope and default-on auto-poke

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `broadcast`
- **THEN** the description SHOULD state that auto-poke is the default
- **AND** SHOULD reference `auto_poke:false` as the opt-out parameter
- **AND** SHOULD clarify that `broadcast` is same-team only and point at `broadcast_to_role` for role filtering

#### Scenario: Default broadcast with active panes schedules retries identical to send_message

- **GIVEN** team has A, B, C with `tmux_pane_id`, B and C panes both active, `POKE_QUIET_MS=50`
- **WHEN** A calls `broadcast({body:'urgent'})` (auto_poke omitted)
- **THEN** B and C have the message in mailbox
- **AND** response `poked: false`, `poke_skip_reasons` contains both guard_failed entries
- **AND** `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has 2 entries (one per recipient)

### Requirement: Auto-poke prompt is a wake-up hint, not the message body

When `send_message`, `broadcast`, or `broadcast_to_role` triggers the internal auto-poke path (either during the initial fan-out or in any retry tick scheduled by the guard_failed backoff), the prompt injected into the recipient's tmux pane MUST be a short wake-up hint that identifies the sender, names the intended recipient, and points the recipient at `get_inbox`. The prompt MUST NOT contain any substring of the message `body` the caller passed.

The prompt format MUST be:

```
新邮件 from {sender_identifier} → {target_name}@{target_team}, 请调 get_inbox 查看
```

Where `sender_identifier` is:

- `{display_name} ({agent_id})` when the sender agent has a non-empty `display_name` in the `agents` table
- `{agent_id[:8]}` when `display_name` is `null`, empty, or the agent row cannot be resolved (defensive fallback)

And `{target_name}@{target_team}` names the agent row the poke was addressed to, so that a recipient which receives a hint but finds an empty `get_inbox` can identify in one step whether the wake-up was meant for it.  When the target row cannot be resolved, the target segment together with its ` → ` separator SHALL be omitted rather than rendered with placeholders.

`name` and `team` carry no upper length bound, so the length cap below is enforced at render time by the same omission: when including the target segment would push the prompt past the cap, the whole segment and its ` → ` separator SHALL be dropped rather than truncated to a partial label.

For cross-team `send_message`, the sender_identifier is looked up by `from_agent_id` regardless of team — no team prefix is added to the sender segment (recipient can inspect `from_team` via `get_inbox`).

The total prompt length MUST NOT exceed 200 characters.  Neither the sender's `display_name` nor the target's `name` / `team` carries a schema length cap, so the hint SHALL shed content to stay within the cap in this order: first the ` → {target_name}@{target_team}` segment, then the sender's `display_name` in favour of `{agent_id[:8]}`.  Dropping only the target segment does not bound the result and MUST NOT be treated as enforcing the cap.

The rule applies to every poke issued by the daemon via the `autoPokeImpl` path, including:

1. Initial poke fired during `send_message` auto-poke (same team or cross team, single recipient).
2. Initial poke fired during `broadcast` auto-poke fan-out.
3. Initial poke fired during `broadcast_to_role` auto-poke fan-out.
4. Retry pokes fired by `poke-retry.ts` ticks after a prior `guard_failed`.

The rule does NOT constrain the `poke` MCP tool itself when callers invoke it directly.

#### Scenario: send_message auto-poke injects hint, not body (same team)

- **GIVEN** agents A (display_name="lead-opus") and B (display_name="worker-kimi", team `core`) are registered in the same team, both with `tmux_pane_id`
- **AND** B's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "please investigate bug #42 in the auth module"})` with default auto_poke
- **THEN** the message is persisted to B's mailbox with the full body
- **AND** the poke prompt injected into B's pane equals `"新邮件 from lead-opus (<A's agent_id>) → worker-kimi@core, 请调 get_inbox 查看"`
- **AND** the injected prompt does NOT contain `"bug #42"` or any other substring of the body

#### Scenario: Cross-team send_message auto-poke names the target's own team

- **GIVEN** agent A (display_name="lead-alpha") in team `alpha`, agent with `name='bob'` in team `beta` with idle pane
- **WHEN** A calls `send_message({to_agent_name: 'bob', to_team: 'beta', body: "secret: token=xyz"})` with default auto_poke
- **THEN** bob's pane receives exactly `"新邮件 from lead-alpha (<A's agent_id>) → bob@beta, 请调 get_inbox 查看"`
- **AND** the prompt does NOT contain `"token"` or any body substring

#### Scenario: Hint identifies the intended target when the pane host differs

- **GIVEN** a poke addressed to agent `tester-2` in team `webdot` reaches a tmux pane
- **WHEN** the hint is rendered
- **THEN** it contains `→ tester-2@webdot`
- **AND** whoever reads that pane can tell the wake-up was addressed to `tester-2@webdot` without querying another team's `list_agents`

#### Scenario: broadcast_to_role auto-poke names each recipient individually

- **GIVEN** sender A (display_name="captain"), recipients B (`name='b'`) and C (`name='c'`) in team `svc` with role `backend`, both with `tmux_pane_id` and idle panes, `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast_to_role({to_role: 'backend', body: "sensitive config: API_KEY=sk-xyz"})` with default auto_poke
- **THEN** both B and C have the message in mailbox
- **AND** B's pane receives `"新邮件 from captain (<A's agent_id>) → b@svc, 请调 get_inbox 查看"`
- **AND** C's pane receives the same format with `→ c@svc`
- **AND** neither pane contains `"API_KEY"`, `"sk-xyz"`, or any body substring

#### Scenario: Retry tick reuses hint format, not the captured body

- **GIVEN** agent A sends `send_message` to B whose pane is active (guard fails) → retry scheduled
- **AND** 30 seconds later B's pane becomes idle, the first retry tick fires and guard passes
- **WHEN** the retry fires the poke via `autoPokeImpl`
- **THEN** the poke prompt is the hint format including the `→ {target_name}@{target_team}` segment, NOT the original body

#### Scenario: Sender without display_name falls back to agent_id[:8]

- **GIVEN** sender A registered with `display_name = null` and `agent_id = "abc12345-6789-..."`, recipient B (`name='b'`, team `t`) idle
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "anything"})` with default auto_poke
- **THEN** the poke prompt equals `"新邮件 from abc12345 → b@t, 请调 get_inbox 查看"`

#### Scenario: Unresolvable target omits the target segment

- **GIVEN** a poke whose target row cannot be resolved at hint-build time
- **WHEN** the hint is rendered
- **THEN** it equals `"新邮件 from {sender_identifier}, 请调 get_inbox 查看"` with no ` → ` separator and no placeholder text

#### Scenario: Long identities stay within the length cap

- **GIVEN** a sender display_name and a target name/team that are long but still leave the full hint within 200 characters
- **WHEN** the hint is rendered
- **THEN** the target segment is present and the total length does not exceed 200 characters
- **AND** when the labels are long enough that the full hint would exceed 200 characters, the target segment and its ` → ` separator are dropped and the total length still does not exceed 200 characters

#### Scenario: An oversized sender name is shed too, not just the target segment

- **GIVEN** a sender whose `display_name` is 500 characters and a short target name and team
- **WHEN** the hint is rendered
- **THEN** its total length does not exceed 200 characters
- **AND** the sender renders as `{agent_id[:8]}` with no part of the oversized display_name present

#### Scenario: All three tools' descriptions document the hint-only contract

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `send_message`, `broadcast`, and `broadcast_to_role`
- **THEN** each description SHOULD state that auto-poke injects only a short wake-up hint (e.g. "only injects a SHORT wake-up hint" or "短提醒") and NOT the message body
- **AND** each description SHOULD reference `get_inbox` as the retrieval path

### Requirement: poke dispatches via transport abstraction

`poke({target_agent_id, prompt})` SHALL perform transport selection and fallback as follows:

1. Look up the target row: `SELECT channel_session_id, opencode_base_url, opencode_session_id, tmux_pane_id, team FROM agents WHERE agent_id = ?`.
2. If the target does not exist, return `{error: 'unknown_target'}`.
3. Self-poke and cross-team checks remain unchanged; `allowCrossTeam` internal flag still governs auto-poke bypass.
4. If `channel_session_id` is non-null AND the daemon's `ChannelWakeFanout` has a live sink attached for that id, call the internal `sendChannelWake(channel_session_id, {content, meta})`.  On success, return `{ok: true, transport_used: 'claude-channel', channel_session_id}`.
5. Otherwise, if both `opencode_base_url` and `opencode_session_id` are non-null, call the internal opencode transport helper.  On success, return `{ok: true, transport_used: 'opencode-server', base_url, session_id}`.
6. If steps 4-5 did not return success, AND `tmux_pane_id` is non-null, perform the existing tmux-based poke flow, which runs the quiet-guard before pasting UNLESS the internal `skipGuard` flag is set (per "poke happy path delivers paste and returns before/after tails").  On success, return `{ok: true, pane_id, pane_tail_before, pane_tail_after, transport_used: 'tmux-poke'}`.  When the guard detects pane activity (and `skipGuard` is not set), return `{error: 'guard_failed', transport_used: 'tmux-poke'}` without pasting.  On other tmux error, return the classified error with `transport_used: 'tmux-poke'`.
7. If none of the three transports is configured, return `{error: 'no_transport_available', detail: {channel_subscribed: <bool>, opencode_bound: <bool>, tmux_pane_set: <bool>}}`.

The tool MUST NOT fan a wake-up via multiple transports for a single poke call.  Successful Claude channel delivery short-circuits opencode and tmux, and successful opencode delivery short-circuits tmux.

#### Scenario: poke prefers claude-channel over opencode and tmux

- **GIVEN** target agent `bob` has `channel_session_id='csid-bob'`, `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-bob'`, and `tmux_pane_id='%99'`
- **AND** the channel proxy subscribing to `csid-bob` is online
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ok: true, transport_used: 'claude-channel', channel_session_id: 'csid-bob'}`
- **AND** the daemon does NOT call the opencode transport helper
- **AND** no `tmux` command is executed

#### Scenario: poke uses opencode when channel sink absent and opencode bound

- **GIVEN** target `bob` has `channel_session_id='csid-bob'`, `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-bob'`, and `tmux_pane_id='%99'`
- **AND** no sink is attached for `csid-bob`
- **AND** the opencode server is reachable and accepts the prompt for `sess-bob`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ok: true, transport_used: 'opencode-server', base_url: 'http://127.0.0.1:4096', session_id: 'sess-bob'}`
- **AND** no `tmux` command is executed

#### Scenario: poke falls back to tmux when opencode not bound and pane idle

- **GIVEN** target `bob` has `channel_session_id=NULL`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and `tmux_pane_id='%99'`
- **AND** `%99` stays idle through the quiet-guard window, so the guard passes
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the daemon executes the tmux paste-then-enter flow on pane `%99`
- **AND** the response is `{ok: true, transport_used: 'tmux-poke', pane_id: '%99', pane_tail_before: ..., pane_tail_after: ...}`

#### Scenario: tmux fallback guards an active pane and returns guard_failed

- **GIVEN** target `bob` has `channel_session_id='csid-bob'` but no live sink for it, `opencode_base_url=NULL`, and `tmux_pane_id='%99'`
- **AND** `%99` is actively redrawing during the quiet-guard window
- **AND** the poke is invoked without `skipGuard`
- **WHEN** `alice` pokes `bob`
- **THEN** the dispatch falls through steps 4-5 to the tmux branch, runs the quiet-guard, and detects activity
- **AND** the response is `{error: 'guard_failed', transport_used: 'tmux-poke'}`
- **AND** no `paste-buffer` / `send-keys` command is executed on `%99`

#### Scenario: poke returns no_transport_available when no route is configured

- **GIVEN** target `bob` has `channel_session_id=NULL`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and `tmux_pane_id=NULL`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{error: 'no_transport_available', detail: {channel_subscribed: false, opencode_bound: false, tmux_pane_set: false}}`
- **AND** no tmux command is executed

#### Scenario: poke response envelope carries expanded transport_used values

- **GIVEN** any poke call that succeeds via one transport
- **WHEN** the response envelope is inspected
- **THEN** the envelope contains a `transport_used` field whose value is one of `'claude-channel'`, `'opencode-server'`, or `'tmux-poke'`

### Requirement: Fan-out routing delivers to all team members

`broadcast` and `send_message({to_role})` SHALL enumerate their full member set and deliver a mailbox row to every member, with NO filtering by `last_seen_at` recency or liveness — identical to direct-send delivery semantics. Specifically:

1. `broadcast({ body })` — every agent in the caller's team across all devices, except the caller itself.
2. `send_message({ to_role })` — every agent whose `role` matches in the caller's team.

An idle or offline member (regardless of `last_seen_at`) MUST still receive its mailbox row and event. The auto-poke wake attempt remains best-effort and is gated only by the existing pane / transport checks (`no_pane`, `guard_failed`, `tmux_unavailable`) and retry rules — those skips are orthogonal to liveness and unchanged.

The daemon SHALL return `{ error: "unknown_recipient" }` from a fan-out ONLY when the enumerated member set is genuinely empty: for `broadcast`, when the caller is the sole member of its team; for `to_role`, when no agent in the team holds that role. An empty set MUST NOT arise merely because members are idle.

#### Scenario: Broadcast delivers to every team member including idle ones

- **GIVEN** team "default" has agents A (sender, `last_seen_at = now`), B (`last_seen_at = now - 1 min`), C (`last_seen_at = now - 10 min`), D (`last_seen_at = now - 3 days`)
- **WHEN** A calls `broadcast({ body: "status update" })`
- **THEN** the response `recipients` array contains exactly `[B, C, D]` (order-insensitive) — none is excluded for idleness
- **AND** B, C, and D each have a new row in `messages` for this broadcast
- **AND** all resulting messages rows have `from_team = to_team = 'default'`

#### Scenario: to_role delivers to every matching agent including idle ones

- **GIVEN** team "default" has agents F1 (`role=frontend`, `last_seen_at = now - 1 min`), F2 (`role=frontend`, `last_seen_at = now - 2 hours`), F3 (`role=frontend`, `last_seen_at = now`)
- **WHEN** A calls `send_message({ to_role: 'frontend', body: "hi frontends" })`
- **THEN** `recipients` contains exactly `[F1, F2, F3]`
- **AND** F2 has a mailbox entry for this event despite being idle
- **AND** the `events` row has `payload.recipients = [F1, F2, F3]`

#### Scenario: Broadcast with the sender as sole team member returns unknown_recipient

- **GIVEN** team "solo" contains only agent A (the sender)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: to_role with no agent under the role returns unknown_recipient

- **GIVEN** no agent in team "default" holds role `archivist`
- **WHEN** caller A calls `send_message({ to_role: 'archivist', body: "anything" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: Idle members are still addressed (no idle-based emptiness)

- **GIVEN** team "default" has agents A (sender) and B (`last_seen_at = now - 6 min`)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response `recipients` array contains exactly `[B]`
- **AND** B has a new mailbox row for this broadcast (it is NOT treated as an empty fan-out)

#### Scenario: MCP tool descriptions reflect all-member fan-out

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `broadcast` or `send_message`
- **THEN** the descriptions MUST NOT claim that fan-out skips recipients idle for more than 5 minutes
- **AND** the `broadcast` description states that it delivers to every team member except the sender

### Requirement: send_message supports cross-team delivery when to_team is explicit

`send_message({to_agent_name, to_team, body, subject?, auto_poke?})` with `to_team` explicitly set to a value different from the caller's team SHALL deliver the message to the agent named `to_agent_name` in team `to_team`, provided that agent exists there.

The daemon MUST:

1. Resolve `to_team` = provided `to_team` value (or caller's team if omitted).
2. Look up the target agent row via `AgentsRepo.findByIdentity({ team: resolved_to_team, name: to_agent_name })`.
3. If no row matches, return `{ error: 'unknown_recipient' }`.
4. Persist a `messages` row with `from_team = caller.team`, `to_team = resolved to_team`, `from_agent_id = caller.agent_id`, `to_agent_id = resolved UUID`, `to_role = null`.
5. Persist a paired `events` row with matching `from_team` / `to_team`.
6. Proceed with auto-poke (subject to `auto_poke` parameter) using the same quiet-guard + retry-backoff mechanism as same-team delivery.

Cross-team delivery MUST NOT require any additional parameter (no `cross_team:true`, no permission token).  Explicit `to_team` is itself the signal of intent.

`send_message_by_id` does NOT support cross-team delivery; it is same-team only.  Cross-team 1→1 sends MUST use `send_message` with `to_agent_name`.

#### Scenario: Cross-team private message is delivered

- **GIVEN** caller `alice` in team `alpha`, target with `name='bob'` genuinely in team `beta` with `agent_id='uuid-bob'`, bob has an idle pane
- **WHEN** `alice` calls `send_message({to_agent_name:'bob', to_team:'beta', body:'cross-team ping'})`
- **THEN** response has `recipients: ['uuid-bob']`, `poked: true`, no `error`
- **AND** the `messages` row has `from_team='alpha', to_team='beta', from_agent_id=<alice.uuid>, to_agent_id='uuid-bob'`
- **AND** the paired `events` row has `from_team='alpha', to_team='beta', actor_agent_id=<alice.uuid>`
- **AND** bob's pane received the wake-up hint

#### Scenario: Cross-team `to_team` equal to caller's team is identical to omission

- **GIVEN** caller in team `alpha`, target with `name='bob'` in team `alpha`
- **WHEN** the caller invokes `send_message({to_agent_name:'bob', to_team:'alpha', body:'hi'})`
- **THEN** behavior is byte-identical to `send_message({to_agent_name:'bob', body:'hi'})`
- **AND** the resulting row has `from_team=to_team='alpha'`

#### Scenario: Cross-team target not found in specified team returns unknown_recipient

- **GIVEN** agent named `bob` exists in team `gamma`, not in team `beta`
- **WHEN** caller in team `alpha` calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no `messages` or `events` row is written

### Requirement: broadcast_to_role tool fans out to same-team role

The daemon SHALL expose an MCP tool `broadcast_to_role({to_role, body, subject?, auto_poke?})` that materializes one `messages` row per agent in the caller's team whose `role = to_role`, sharing a single `event_id`.  Sender is excluded from recipients.  The fan-out spans every device that contributes role-matching agents to the caller's team.  All rows MUST have `from_team = to_team = caller.team` and `to_role = to_role` set; `to_agent_id` is set to the specific agent id (same pattern as the paired rows produced by the removed `send_message({to_role})` behavior, just relocated).

If no agent in the caller's team matches `to_role` on any device, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event.

`broadcast_to_role` MUST NOT accept a `to_team` parameter or a `to_device` parameter — it is strictly same-team, all-devices.  The tool's MCP description MUST explicitly state this constraint.

Auto-poke, quiet-guard, retry-backoff, parallel fan-out, and hint-only poke body requirements apply identically to `broadcast_to_role` as they do to `broadcast` (see the Broadcast and Auto-poke requirements above).

The response shape MUST be:

```
{
  message_id: string,
  event_id: number,
  recipients: string[],           // agent_id list
  poked: boolean,
  poke_skip_reasons?: Array<{agent_id, reason}>,
  retry_scheduled: boolean,
  retry_delays_s?: number[]
}
```

#### Scenario: Two role-matching agents in team receive fan-out

- **GIVEN** agents `sess-F1` and `sess-F2` both have `role='frontend'` in team `default`, caller `sess-X` also in team `default`
- **WHEN** `sess-X` calls `broadcast_to_role({to_role:'frontend', body:'ship status'})`
- **THEN** `recipients` contains `['sess-F1', 'sess-F2']` (order-insensitive)
- **AND** two `messages` rows appear with identical `event_id`, `from_team=to_team='default'`, `to_role='frontend'`
- **AND** `recipients` does NOT include `sess-X` even if `sess-X` also has `role='frontend'` (sender always excluded)

#### Scenario: Role fan-out spans devices in the caller's team

- **GIVEN** team `default` has `worker-A` on `device='host-a'` with `role='worker'` and `worker-B` on `device='host-b'` with `role='worker'`
- **AND** the caller is on `(device='host-a', team='default')` with `role='lead'`
- **WHEN** the caller calls `broadcast_to_role({to_role:'worker', body:'task'})`
- **THEN** `recipients` contains both `worker-A` and `worker-B` (cross-device fan-out)

#### Scenario: No matching role returns unknown_recipient

- **GIVEN** no agent in team `default` has `role='nonexistent'` on any device
- **WHEN** caller calls `broadcast_to_role({to_role:'nonexistent', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no `messages` or `events` row is written

#### Scenario: Default auto-poke on broadcast_to_role fires for all idle-pane recipients in parallel

- **GIVEN** three role=`worker` agents in same team as caller, all with `tmux_pane_id` and idle panes, `POKE_QUIET_MS=100`
- **WHEN** caller calls `broadcast_to_role({to_role:'worker', body:'task ready'})` (auto_poke omitted)
- **THEN** response has `poked: true`, `poke_skip_reasons` absent or empty, `retry_scheduled: false`
- **AND** total call duration < 400ms (parallel, not 3 × 100ms)
- **AND** each recipient's pane received the wake-up hint

#### Scenario: broadcast_to_role does not accept to_team parameter

- **WHEN** a client calls `broadcast_to_role({to_role:'x', to_team:'beta', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_team`)

#### Scenario: broadcast_to_role does not accept to_device parameter

- **WHEN** a client calls `broadcast_to_role({to_role:'x', to_device:'host-b', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_device`)

#### Scenario: broadcast_to_role tool description states same-team scope

- **GIVEN** client fetches `tools/list`
- **WHEN** it reads the `description` of `broadcast_to_role`
- **THEN** the description SHOULD state the tool is strictly same-team across all devices
- **AND** SHOULD reference `send_message({to_team})` as the only cross-team path (and only for 1→1)
- **AND** SHOULD describe auto-poke default, quiet-guard, and retry-backoff consistent with `broadcast`

### Requirement: send_message is 1→1 private message by name

`send_message({to_agent_name, to_team?, subject?, body, auto_poke?, need_reply?})` MUST accept `to_agent_name` (the target's `name` field in the `agents` table) as the required recipient key. The MCP tool schema MUST reject any request carrying `to_agent_id`, `to_role`, or other unknown fields (Zod `.strict()`).

`send_message` MUST accept an optional `to_team` parameter. When `to_team` is omitted, the daemon SHALL default it to the caller's team. When `to_team` is provided and equals the caller's team, behavior is identical to omission. When `to_team` is provided and differs from the caller's team, the call constitutes a cross-team private message. See "send_message supports cross-team delivery when to_team is explicit".

The `send_message` MCP tool description MUST state: 除非用户明确指定 `to_team`, 不要跨 team 沟通.  The description MUST also reference `broadcast_to_role` as the way to address a role, `broadcast` as the way to reach the whole team, and `send_message_by_id` as the UUID-based variant.

#### Scenario: send_message rejects to_agent_id at the schema layer

- **WHEN** caller calls `send_message({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_agent_id`)
- **AND** no new event row is created
- **AND** no new messages row is created

#### Scenario: send_message without to_agent_name is a schema error

- **WHEN** caller calls `send_message({body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call (missing required `to_agent_name`)
- **AND** no new event row is created

#### Scenario: send_message with to_agent_name persists via resolved UUID

- **GIVEN** agent with `name='bob'` exists in the caller's team with `agent_id='uuid-B'`
- **WHEN** caller calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id='uuid-B'`
- **AND** response `recipients` equals `['uuid-B']`

#### Scenario: send_message tool description mentions to_agent_name and send_message_by_id

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHALL reference `to_agent_name` as the addressing key
- **AND** SHALL reference `send_message_by_id` as the UUID-based sibling tool
- **AND** SHALL retain the "除非用户明确指定 `to_team`, 不要跨 team 沟通" guardrail

### Requirement: send_message_by_id is 1→1 private message by UUID

`send_message_by_id({to_agent_id, subject?, body, auto_poke?, need_reply?})` MUST accept `to_agent_id` (the target agent's UUID) as the required recipient key. The MCP tool schema MUST reject any request carrying `to_agent_name`, `to_team`, `to_role`, or other unknown fields (Zod `.strict()`).

`send_message_by_id` is same-team only: the recipient row's `team` MUST equal the caller's team. If the recipient does not exist OR the recipient's team differs from the caller's team, the daemon MUST return `{ error: 'unknown_recipient' }`. Cross-team 1→1 sends MUST use `send_message` with `to_agent_name` + explicit `to_team`.

All downstream behavior — mailbox persistence, event row pairing, auto-poke default, quiet-guard, retry backoff, hint-only poke body, delivery status persistence — MUST be byte-identical to `send_message`. The success envelope (`{message_id, event_id, recipients: [<to_agent_id>], poked, poke_skip_reasons?, retry_scheduled, retry_delays_s?}`) MUST be identical.

The `send_message_by_id` MCP tool description MUST state that it is same-team only and point to `send_message` + `to_team` as the cross-team path.

#### Scenario: send_message_by_id rejects to_agent_name at the schema layer

- **WHEN** caller calls `send_message_by_id({to_agent_id:'uuid-B', to_agent_name:'bob', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_agent_name`)

#### Scenario: send_message_by_id rejects to_team at the schema layer

- **WHEN** caller calls `send_message_by_id({to_agent_id:'uuid-B', to_team:'beta', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_team`)

#### Scenario: send_message_by_id same-team send persists and auto-pokes

- **GIVEN** agent `sess-B` exists in the caller's team with `agent_id='uuid-B'` and an idle pane
- **WHEN** caller calls `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id='uuid-B'`, `from_team=to_team=caller.team`
- **AND** response `recipients` equals `['uuid-B']`

#### Scenario: send_message_by_id targeting a cross-team agent returns unknown_recipient

- **GIVEN** caller in team `alpha`, agent `sess-B` with `agent_id='uuid-B'` exists in team `beta`
- **WHEN** caller calls `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no `messages` or `events` row is written

### Requirement: send_message resolves to_agent_name via (team, name) lookup

When `send_message` is called with `to_agent_name`, the daemon SHALL resolve the recipient UUID via `AgentsRepo.findByIdentity({ team: resolved_to_team, name: to_agent_name })`, where `resolved_to_team = to_team ?? caller.team`. The lookup is unambiguous because the `agents_identity_idx` UNIQUE INDEX on `(team, name)` guarantees at most one matching row.

If the lookup returns a row, the daemon SHALL proceed with the existing insert + auto-poke pipeline using the resolved `agent_id`, identical to the behaviour of `send_message_by_id` with that UUID.

The `send_message` success envelope SHALL be unchanged: `{ message_id, event_id, recipients: [<resolved_uuid>], poked, poke_skip_reasons?, retry_scheduled, retry_delays_s? }`. The `recipients[]` field SHALL always contain the resolved UUID, never the name.

Cross-team sends via `to_agent_name` SHALL set `from_team` / `to_team` on the persisted `messages` and `events` rows to reflect the resolved teams; auto-poke fanout is not suppressed by the cross-team distinction on its own.

#### Scenario: Same-team send via to_agent_name persists and auto-pokes

- **GIVEN** agents `alice` (caller) and `bob` both in team 'default', both with `tmux_pane_id`
- **AND** bob's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** alice calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `from_agent_id=<alice.uuid>`, `to_agent_id=<bob.uuid>`, `from_team='default'`, `to_team='default'`
- **AND** response `recipients` equals `[<bob.uuid>]`
- **AND** response `poked` is `true`
- **AND** bob's pane receives the wake-up hint

#### Scenario: Cross-team send via to_agent_name and explicit to_team

- **GIVEN** agent `alice` in team 'alpha' (caller), agent `bob` in team 'beta'
- **WHEN** alice calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** the message is persisted with `from_team='alpha'`, `to_team='beta'`, `to_agent_id=<bob.uuid in beta>`
- **AND** response `recipients` equals `[<bob.uuid in beta>]`

#### Scenario: Success envelope recipients is always the resolved UUID

- **GIVEN** agent `bob` in team 'default' with `agent_id='uuid-B'` and `name='bob'`
- **WHEN** caller A calls `send_message({to_agent_name:'bob', body:'hi'})`
- **AND** caller A calls `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** both responses have `recipients === ['uuid-B']`

#### Scenario: Lookup is case-sensitive (byte-equal)

- **GIVEN** agent registered with `name='Bob'` in team 'default'
- **WHEN** caller calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (lowercase `bob` does not match stored `Bob`)

### Requirement: send_message carries reply expectation

`send_message` SHALL accept an optional `need_reply: boolean` parameter.  When omitted, `need_reply` MUST default to `true`.  When provided, the daemon MUST persist the exact boolean value on the created `messages` row.

The `send_message` MCP tool description MUST document that private messages default to expecting a reply, and that callers can set `need_reply:false` for FYI/no-response-needed messages.

`need_reply` is a mailbox contract visible to the recipient.  It MUST NOT change delivery, auto-poke, retry, or routing behavior.

#### Scenario: send_message defaults to needing reply

- **GIVEN** agents `sess-A` and `sess-B` are in the same team
- **WHEN** `sess-A` calls `send_message_by_id({to_agent_id:'sess-B', body:'question', auto_poke:false})`
- **THEN** the created `messages` row has `need_reply=1`

#### Scenario: send_message can opt out of reply expectation

- **GIVEN** agents `sess-A` and `sess-B` are in the same team
- **WHEN** `sess-A` calls `send_message_by_id({to_agent_id:'sess-B', body:'FYI', need_reply:false, auto_poke:false})`
- **THEN** the created `messages` row has `need_reply=0`

#### Scenario: send_message description documents need_reply

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHALL mention `need_reply`
- **AND** SHALL state that `need_reply:false` means no reply is expected

### Requirement: Fan-out messages are no-reply by default

`broadcast` and `broadcast_to_role` SHALL persist `need_reply=false` for every created `messages` row.  These tools MUST NOT accept a `need_reply` input parameter in this change.

#### Scenario: broadcast rows are marked no-reply

- **GIVEN** team `default` has agents `sess-A`, `sess-B`, and `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands', auto_poke:false})`
- **THEN** every created `messages` row has `need_reply=0`

#### Scenario: broadcast_to_role rows are marked no-reply

- **GIVEN** team `default` has two agents with role `worker`
- **WHEN** caller calls `broadcast_to_role({to_role:'worker', body:'status', auto_poke:false})`
- **THEN** every created `messages` row has `need_reply=0`

### Requirement: Message wake delivery status is persisted

For every successful `send_message`, `broadcast`, or `broadcast_to_role` recipient row, the daemon SHALL persist one wake delivery status row keyed by `(message_id, agent_id)`.  The row MUST represent only the auto-poke wake-hint state, not mailbox persistence.

The status row MUST include:

- `message_id`
- `agent_id`
- `wake_status`, one of `delivered`, `retrying`, `skipped`, `failed`
- `skip_reason`, nullable, using existing skip reasons plus `auto_poke_disabled`, `recipient_active`, and `retry_exhausted`
- `retry_attempts`, integer, default `0`
- `updated_at`
- `delivered_at`, nullable

When `auto_poke:false` is used, the daemon MUST write `wake_status='skipped'` and `skip_reason='auto_poke_disabled'` for each recipient.

#### Scenario: Immediate auto-poke success records delivered
- **GIVEN** agent A sends `send_message_by_id({to_agent_id: B, body: "hi"})`
- **AND** B has an idle delivery transport
- **WHEN** the send succeeds and auto-poke succeeds immediately
- **THEN** the status row for `(message_id, B)` has `wake_status='delivered'`
- **AND** `delivered_at` is not null
- **AND** `skip_reason` is null

#### Scenario: auto_poke false records disabled skip
- **GIVEN** agent A sends `send_message_by_id({to_agent_id: B, body: "hi", auto_poke:false})`
- **WHEN** the send succeeds
- **THEN** the status row for `(message_id, B)` has `wake_status='skipped'`
- **AND** `skip_reason='auto_poke_disabled'`
- **AND** no wake delivery transport is invoked

#### Scenario: Guard failed records retrying
- **GIVEN** agent A sends a message to B and B's pane is active
- **WHEN** the initial quiet-guard fails and retry is scheduled
- **THEN** the status row for `(message_id, B)` has `wake_status='retrying'`
- **AND** `skip_reason='guard_failed'`
- **AND** `retry_attempts=0`

### Requirement: Sender can query delivery status

The daemon SHALL expose a read-only MCP tool named `get_delivery_status` that accepts `{ message_id: string }`.  The caller MUST be the sender of the requested message; otherwise the daemon MUST return `{ error: 'unknown_message' }` without exposing recipient status.

On success, the tool SHALL return:

- `message_id`
- `statuses: Array<{ agent_id, wake_status, skip_reason?, retry_attempts, updated_at, delivered_at? }>`

#### Scenario: Sender reads status for a direct message
- **GIVEN** agent A sent message `m1` to agent B
- **WHEN** A calls `get_delivery_status({message_id:'m1'})`
- **THEN** the response includes exactly one status row for B
- **AND** the row reports B's current `wake_status`

#### Scenario: Non-sender cannot read status
- **GIVEN** agent A sent message `m1` to agent B
- **AND** agent C is registered
- **WHEN** C calls `get_delivery_status({message_id:'m1'})`
- **THEN** the response is `{ error: 'unknown_message' }`

#### Scenario: Broadcast sender reads per-recipient statuses
- **GIVEN** agent A sent broadcast message `m1` to agents B and C
- **WHEN** A calls `get_delivery_status({message_id:'m1'})`
- **THEN** the response includes one status row for B and one status row for C

### Requirement: send_message tool description forbids pre-verifying the recipient via list_agents

The `send_message` MCP tool description (the by-name variant; see `src/mcp/tools.ts` `SEND_MESSAGE_DESC`) SHALL explicitly direct callers not to pre-verify the recipient's existence via `list_agents` before issuing the send. The description's prose may be reworded, but it MUST contain all of:

1. A directive forbidding pre-verification (e.g., the substring `DO NOT` paired with `list_agents` and the notion of pre-verification, or equivalent jussive prose).
2. A statement that miss is signalled cleanly by the `unknown_recipient` return value, so callers understand the recovery path is "try send, then handle the error" rather than "verify, then send".
3. A note that this rule applies to both same-team and cross-team sends — same-team pre-verification is wasted work, cross-team pre-verification via `list_agents` is structurally impossible because `list_agents` is caller-team scoped.

The directive language SHALL use jussive form (DO NOT / MUST NOT) rather than advisory hedges, for the same reason as the `list_agents` description requirement.

This Requirement applies to `send_message` only. `send_message_by_id`, `broadcast`, and `broadcast_to_role` are out of scope for this change.

#### Scenario: send_message description forbids list_agents pre-verification

- **GIVEN** the MCP server has registered the `send_message` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains the literal substring `list_agents`
- **AND** the description contains directive prose forbidding pre-verification (case-insensitive match on `DO NOT` together with `pre` within the same sentence as `list_agents`, or an equivalent MUST NOT formulation)

#### Scenario: send_message description references unknown_recipient as the miss signal

- **GIVEN** the MCP server has registered the `send_message` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains the literal substring `unknown_recipient`

#### Scenario: send_message description covers both same-team and cross-team pre-check rule

- **GIVEN** the MCP server has registered the `send_message` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description's prose makes clear that the no-pre-verification rule applies to both same-team and cross-team sends (e.g., by naming both cases explicitly, or by stating the rule in unqualified universal terms)

### Requirement: A retry tick that injects nothing is not recorded as delivered

A retry tick scheduled after `guard_failed` re-checks the recipient at fire time, and by then the pane may belong to somebody else.  The tick SHALL consult the outcome of the poke it fires rather than assuming the fire succeeded.

The tick SHALL record `wake_status='delivered'` only for an outcome that reports success.  For compatibility with callers whose poke function returns nothing, a `void` outcome SHALL be read as delivered.  **Every unsuccessful outcome SHALL be excluded from `delivered`, whatever its reason** — enumerating one reason and letting the rest fall through to the delivered branch is the specific defect this forbids.

Unsuccessful outcomes resolve as follows:

- `pane_reassigned`, `no_pane`, `tmux_unavailable` → record `wake_status='skipped'` with that reason and stop retrying, because none of them reverts on a timer (the same reasoning that already stops `no_pane`).
- `guard_failed`, or any reason the daemon does not recognise → keep the existing backoff and terminate at `retry_exhausted` if attempts run out.  An unknown failure SHALL NOT invent a new terminal status and SHALL NOT be recorded as delivered.

Recording a delivery for a tick that performed no injection is the specific defect this forbids: it reports a wake-up that the recipient never received, which is indistinguishable from a real delivery in `get_delivery_status`.

#### Scenario: Pane taken over between the initial send and the retry tick

- **GIVEN** an auto-poke that resolved to `guard_failed` and scheduled retries
- **AND** the recipient's pane is bound to a different agent before the first tick fires
- **WHEN** the tick fires and its poke returns `pane_reassigned`
- **THEN** the delivery status is `skipped` with `skip_reason='pane_reassigned'`
- **AND** it is never recorded as `delivered`
- **AND** no further retry attempt is scheduled for that recipient

#### Scenario: Other unsuccessful outcomes are also kept out of delivered

- **GIVEN** a scheduled retry whose tick fires
- **WHEN** its poke returns an unsuccessful outcome of `tmux_unavailable` or `no_pane`
- **THEN** the delivery status is `skipped` with that reason and retrying stops
- **AND** when the outcome is unsuccessful with no recognised reason, the backoff continues and terminates at `retry_exhausted`
- **AND** in none of these cases is `delivered` ever recorded

#### Scenario: A successful retry still records delivered

- **GIVEN** the same setup where the pane is still held by the recipient
- **WHEN** the tick fires and its poke succeeds
- **THEN** the delivery status is `delivered` with `delivered_at` set

