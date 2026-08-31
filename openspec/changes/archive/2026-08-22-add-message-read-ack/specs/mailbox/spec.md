## MODIFIED Requirements

### Requirement: Messages table schema and event projection

The database SHALL contain a `messages` table: `id TEXT PRIMARY KEY`, `event_id INTEGER NOT NULL REFERENCES events(event_id)`, `from_team TEXT NOT NULL`, `to_team TEXT NOT NULL`, `from_agent_id TEXT NOT NULL`, `to_agent_id TEXT`, `to_role TEXT`, `subject TEXT`, `body TEXT NOT NULL`, `need_reply INTEGER NOT NULL DEFAULT 1`, `sent_at TEXT NOT NULL`, `ack_deadline_at TEXT`, `ack_alerted_at TEXT`. Every message write MUST be paired with an `events` row of `event_type='message_sent'`, and that events row's `from_team` / `to_team` MUST equal the message row's `from_team` / `to_team` respectively.

For same-team writes (`broadcast`, `broadcast_to_role`, same-team `send_message`), `from_team` MUST equal `to_team`. For cross-team `send_message`, `from_team` and `to_team` MAY differ.

`ack_deadline_at` and `ack_alerted_at` are both nullable and both hold ISO-8601 timestamps. `ack_deadline_at` carries the unread-watchdog deadline and is written only for reply-expecting private sends; `ack_alerted_at` records that the watchdog has finished examining the row and MUST NOT be re-examined. Existing databases MUST be migrated additively — both columns are added as nullable with no default, so every pre-existing row reads as "no watchdog armed" and no historical message can produce a retroactive alert.

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

#### Scenario: messages table exposes the watchdog columns

- **WHEN** the daemon applies the storage schema
- **THEN** the `messages` table contains an `ack_deadline_at` column and an `ack_alerted_at` column
- **AND** both columns are nullable

#### Scenario: Pre-existing rows are migrated without arming a watchdog

- **GIVEN** a database written before this change, holding `messages` rows with `need_reply=1`
- **WHEN** the daemon applies the storage migration
- **THEN** every pre-existing row has `ack_deadline_at` NULL
- **AND** no unread alert is emitted for any pre-existing row

### Requirement: Fire-and-forget delivery contract for send_message and broadcast

`send_message` MUST follow a fire-and-forget delivery contract regarding event-outbox semantics:

1. The tool MUST persist to the mailbox (and event outbox) and return synchronously, modulo two bounded waits that MUST NOT alter what was persisted: the optional auto-poke quiet-guard window, and the optional read-acknowledgement wait governed by `await_ack_s` (see the `message-read-ack` capability).
2. The tool's MCP description MUST advise callers that `auto_poke` is the default and may be opted out via `auto_poke:false`.
3. The mailbox row MUST be written before either wait begins, so an interrupted or timed-out call never means the message was not sent. Neither wait MAY roll back, delete, or amend the persisted row.

This Requirement applies to `send_message` only. `broadcast` and `broadcast_to_role` are governed by their own "auto-poke default with parallel fan-out" Requirements, which mandate auto-poke as default rather than fire-and-forget.

#### Scenario: send_message_by_id with auto_poke:false is pure fire-and-forget

- **GIVEN** recipient `sess-B` has a valid `tmux_pane_id` registered in caller's team
- **WHEN** caller `sess-A` calls `send_message_by_id({to_agent_id:'sess-B', body:'any', auto_poke:false, await_ack_s:0})`
- **THEN** no `poke` entry, no tmux-injection event, no side effect beyond mailbox persistence occurs

#### Scenario: An expired acknowledgement wait leaves the mailbox row intact

- **GIVEN** caller `sess-A` calls `send_message_by_id({to_agent_id:'sess-B', body:'any', await_ack_s:1})`
- **WHEN** `sess-B` never reads the message and the wait expires
- **THEN** the `messages` row persists unchanged
- **AND** the recipient still sees the message on its next `get_inbox`

### Requirement: send_message carries reply expectation

`send_message` SHALL accept an optional `need_reply: boolean` parameter.  When omitted, `need_reply` MUST default to `true`.  When provided, the daemon MUST persist the exact boolean value on the created `messages` row.

The `send_message` MCP tool description MUST document that private messages default to expecting a reply, and that callers can set `need_reply:false` for FYI/no-response-needed messages.

`need_reply` is a mailbox contract visible to the recipient.  It MUST NOT change delivery, auto-poke, retry, or routing behavior.  It has exactly one behavioral consequence, introduced by the `message-read-ack` capability: `need_reply=1` on a private send arms the 15-minute unread watchdog, and `need_reply=0` does not.  That consequence is confined to whether the SENDER is later alerted about its own message; it MUST NOT change how, whether, or when the message is delivered to the recipient, and two messages differing only in `need_reply` MUST receive identical delivery, auto-poke, retry, and routing treatment.

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

#### Scenario: need_reply does not change delivery treatment

- **GIVEN** agents `sess-A` and `sess-B` are in the same team and `sess-B` has a registered pane
- **WHEN** `sess-A` sends one message with `need_reply:true` and one with `need_reply:false`, all other inputs equal
- **THEN** both sends dispatch the same auto-poke with the same wake-up hint
- **AND** both record equivalent wake delivery status
- **AND** they differ only in `need_reply` and in whether `ack_deadline_at` is set

### Requirement: Sender can query delivery status

The daemon SHALL expose a read-only MCP tool named `get_delivery_status` that accepts `{ message_id: string }`.  The caller MUST be the sender of the requested message; otherwise the daemon MUST return `{ error: 'unknown_message' }` without exposing recipient status.

On success, the tool SHALL return:

- `message_id`
- `statuses: Array<{ agent_id, wake_status, skip_reason?, retry_attempts, updated_at, delivered_at?, read }>`

`read` is a boolean computed at query time from the read predicate defined by the `message-read-ack` capability (`agents.last_processed_event_id >= messages.event_id`).  It MUST NOT be read from a stored column.  A recipient whose agent row no longer exists MUST report `read: false`.

The tool description MUST state that `wake_status` describes only the auto-poke dispatch while `read` is the receipt, so the two are not interchangeable.

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

#### Scenario: Status reports read once the recipient's cursor advances
- **GIVEN** agent A sent message `m1` to agent B
- **WHEN** B's `last_processed_event_id` has passed `m1`'s `event_id`
- **AND** A calls `get_delivery_status({message_id:'m1'})`
- **THEN** the status row for B has `read: true`

#### Scenario: A delivered wake status can still report unread
- **GIVEN** agent A sent message `m1` to agent B and the auto-poke recorded `wake_status='delivered'`
- **WHEN** B's cursor has not passed `m1`'s `event_id`
- **AND** A calls `get_delivery_status({message_id:'m1'})`
- **THEN** the status row for B has `wake_status='delivered'` and `read: false`

#### Scenario: Vanished recipient reports unread
- **GIVEN** agent A sent message `m1` to agent B
- **AND** agent B's row no longer exists
- **WHEN** A calls `get_delivery_status({message_id:'m1'})`
- **THEN** the status row for B has `read: false`
