## ADDED Requirements

### Requirement: Read is derived from the recipient's inbox cursor and never stored

The daemon SHALL define "a message has been read by its recipient" as the predicate `agents.last_processed_event_id >= messages.event_id`, evaluated at query time against the recipient's current cursor.

This predicate MUST NOT be materialized into a stored column, and the daemon MUST NOT add a hook to `get_inbox` to record it.  `get_inbox` already advances `last_processed_event_id` inside the same transaction that returns the rows, so the cursor is the sole source of truth and no second write can drift from it.

The predicate is the daemon's only evidence of receipt.  Wake delivery status (`wake_status`, `delivered_at`) describes the auto-poke dispatch call and MUST NOT be interpreted as receipt: it reports that a transport accepted the wake-up, not that any agent consumed it.

The predicate is a comparison of two event ids, so it is only sound while `event_id` is monotonic and never reused.  `events.event_id` is declared `INTEGER PRIMARY KEY AUTOINCREMENT`, which makes SQLite keep the high-water mark in `sqlite_sequence` rather than reusing the largest free rowid.  That matters because cleanup deletes aged `events` rows: under a plain rowid alias the ids would restart from `1` after a purge, and an agent whose cursor sat at a high value would then evaluate every NEW message as already read — a permanent, silent loss strictly worse than any failure this capability addresses.  The `AUTOINCREMENT` declaration MUST NOT be removed.

The predicate further requires that nothing but `get_inbox` and the fresh-registration INSERT ever writes the cursor.  A schema migration that rewrote cursors on startup used to violate this — it advanced any agent still at `0` to `MAX(event_id)` on every daemon boot, which marked pending mail as read behind the recipient's back and silently disabled this capability's own alert.  Removing it is the `fix-cursor-watermark-data-loss` change; the invariant is stated normatively in `agent-registry` under "Schema apply MUST NOT modify any agent's inbox cursor".

#### Scenario: Cursor past the event id reads as read

- **GIVEN** agent A sent message `m1` to agent B, and `m1` has `event_id=42`
- **WHEN** B's `agents.last_processed_event_id` is `42` or greater
- **THEN** the daemon evaluates `m1` as read by B

#### Scenario: Cursor behind the event id reads as unread

- **GIVEN** agent A sent message `m1` to agent B, and `m1` has `event_id=42`
- **WHEN** B's `agents.last_processed_event_id` is `41`
- **THEN** the daemon evaluates `m1` as unread by B

#### Scenario: A delivered wake status is not receipt

- **GIVEN** agent A sent message `m1` to agent B and the auto-poke recorded `wake_status='delivered'`
- **WHEN** B's `agents.last_processed_event_id` is still behind `m1`'s `event_id`
- **THEN** the daemon evaluates `m1` as unread by B

#### Scenario: Event ids are never reused after a retention purge

- **WHEN** the daemon applies the storage schema
- **THEN** `events.event_id` is declared `AUTOINCREMENT`
- **AND** an event inserted after older events were deleted receives an id greater than every id ever issued

#### Scenario: No read column is added to the schema

- **WHEN** the daemon applies the storage schema
- **THEN** neither `messages` nor `message_delivery_status` contains a column recording whether a message was read

### Requirement: send_message waits synchronously for a read acknowledgement

`send_message` and `send_message_by_id` SHALL accept an optional `await_ack_s: integer` parameter controlling a synchronous wait for the read predicate after the mailbox row is written and auto-poke has been dispatched.

- Omitted MUST default to `10` seconds.
- `0` MUST disable the wait entirely.
- The schema MUST reject any value below `0` or above `30` at the tool boundary.  The `30` second ceiling exists so the wait cannot outlive the calling harness's own tool-call timeout: a harness timeout surfaces to the sending agent as a tool error even though the mailbox row was already written, which invites a duplicate resend.

During the wait the daemon MUST poll the read predicate and return as soon as it holds.  On success or on expiry the tool response MUST include an `ack` object:

- `ack.status`: `"read"` when the predicate held before expiry, `"not_yet"` otherwise
- `ack.waited_ms`: integer milliseconds actually waited

`await_ack_s: 0` MUST produce `ack.status='not_yet'` with `ack.waited_ms=0` rather than omitting `ack`, so callers never have to distinguish "no wait requested" from "field missing".

All pre-existing response fields (`message_id`, `event_id`, `recipients`, `poked`, `poke_skip_reasons`, `retry_scheduled`, `retry_delays_s`) MUST be returned unchanged; `ack` is purely additive.

The 10-second default belongs to the MCP tool schema, NOT to the underlying send service, which MUST treat an absent value as no wait at all.  This Requirement governs the two named MCP tools; other entry points into the same service — the REST fallback `POST /api/send`, and direct in-process callers — pass no value and therefore return `ack: {status: 'not_yet', waited_ms: 0}` without waiting.  That divergence is deliberate: the default exists to help an agent decide whether to end its turn, and a non-agent HTTP client has no such decision to make, so charging it ten seconds of wall clock on every send to a recipient that was never going to read would be pure cost.  The response SHAPE is identical either way, which is why `await_ack_s: 0` must still emit `ack` rather than omitting it.

Watchdog arming is NOT subject to this divergence: it happens on the shared send path, so a REST send with `need_reply` still arms the 15-minute alert.

#### Scenario: Recipient reads within the wait window

- **GIVEN** agent A calls `send_message_by_id({to_agent_id: B, body:'hi'})` with `await_ack_s` omitted
- **WHEN** B's cursor advances past the message's `event_id` two seconds into the wait
- **THEN** the tool returns `ack.status='read'`
- **AND** `ack.waited_ms` is less than `10000`

#### Scenario: Recipient does not read within the wait window

- **GIVEN** agent A calls `send_message_by_id({to_agent_id: B, body:'hi', await_ack_s: 1})`
- **WHEN** B's cursor never advances past the message's `event_id`
- **THEN** the tool returns `ack.status='not_yet'`
- **AND** `ack.waited_ms` is at least `1000`

#### Scenario: Wait disabled by zero

- **GIVEN** agent A calls `send_message_by_id({to_agent_id: B, body:'hi', await_ack_s: 0})`
- **WHEN** the send succeeds
- **THEN** the tool returns `ack.status='not_yet'` and `ack.waited_ms=0`
- **AND** the daemon performs no polling

#### Scenario: Out-of-range wait is rejected at the boundary

- **WHEN** a caller invokes `send_message({to_agent_name:'bob', body:'hi', await_ack_s: 31})`
- **THEN** the call is rejected by input validation
- **AND** no `messages` row is created

#### Scenario: Existing response fields are preserved

- **GIVEN** agent A calls `send_message_by_id({to_agent_id: B, body:'hi'})`
- **WHEN** the send succeeds
- **THEN** the response still contains `message_id`, `event_id`, `recipients`, `poked`, and `retry_scheduled`

### Requirement: not_yet is not a verdict and the tool descriptions must say so

`ack.status='not_yet'` means only "not read during the few seconds this call waited".  It MUST NOT be presented as a timeout, a failure, or a delivery verdict, and the daemon MUST NOT derive any behavior from it.  The unread verdict belongs exclusively to the 15-minute watchdog, which reaches the sender on its own.

The MCP descriptions of `send_message` and `send_message_by_id` SHALL each contain all of:

1. A statement that `not_yet` does not mean failure and that the caller MUST NOT change its behavior on the strength of it.
2. A statement that a genuinely unread message causes the daemon to ATTEMPT a separate alert poke to the sender.  This statement MUST be qualified in two ways, because the same description tells the caller not to poll and an unqualified promise would send an agent that trusted it straight back into the silent stall:
   - By `need_reply`: the alert exists only for reply-expecting sends, and the description MUST say a `need_reply:false` send gets no alert.
   - By reliability: the description MUST NOT assert the alert will reach the caller.  It MUST convey that a transient failure is retried for a bounded period while a hard failure is abandoned silently.  Wording that states or implies the alert always arrives is a defect even though the daemon really does try.
3. A statement that the mailbox row is written before the wait begins, so any timeout or error MUST NOT be read as "the message was not sent" and the caller MUST NOT resend.

#### Scenario: send_message description carries the not_yet caveats

- **WHEN** a client fetches the MCP tool list via `tools/list`
- **THEN** the `description` of `send_message` states that `not_yet` is not a failure
- **AND** states that an unread message triggers a separate alert to the sender
- **AND** states that the mailbox row is already written so the caller must not resend

#### Scenario: send_message_by_id description carries the not_yet caveats

- **WHEN** a client fetches the MCP tool list via `tools/list`
- **THEN** the `description` of `send_message_by_id` states that `not_yet` is not a failure
- **AND** states that an unread message triggers a separate alert to the sender
- **AND** states that the mailbox row is already written so the caller must not resend

#### Scenario: The alert promise is qualified by need_reply

- **WHEN** a client fetches the MCP tool list via `tools/list`
- **THEN** the `description` of each send tool ties the 15-minute alert to `need_reply`
- **AND** states that a `need_reply:false` send receives no such alert

#### Scenario: The alert is described as an attempt, not a guarantee

- **WHEN** a client fetches the MCP tool list via `tools/list`
- **THEN** the `description` of each send tool presents the alert as an attempt
- **AND** states that a transient failure is retried for a bounded period
- **AND** states that a hard failure is abandoned without retrying
- **AND** contains no claim that the alert always reaches the caller

### Requirement: A 15-minute unread watchdog is armed only for reply-expecting private sends

When `send_message` or `send_message_by_id` creates a row with `need_reply=1`, the daemon SHALL persist `messages.ack_deadline_at` set to the send time plus 15 minutes.

The daemon MUST leave `ack_deadline_at` NULL for every other write:

- rows created with `need_reply=0`
- every row created by `broadcast`
- every row created by `broadcast_to_role`

Fan-out is excluded because its rows are already `need_reply=0` by contract and its semantics are FYI: alerting per unread recipient would emit one alert per silent member of a team.

Arming MUST be independent of `auto_poke` and of `await_ack_s`: a message sent with auto-poke disabled or with the wait disabled still arms the watchdog, because the watchdog reports on receipt, not on dispatch.

#### Scenario: Reply-expecting private send arms the watchdog

- **WHEN** agent A calls `send_message_by_id({to_agent_id: B, body:'question'})`
- **THEN** the created `messages` row has `ack_deadline_at` set to `sent_at` plus 15 minutes

#### Scenario: No-reply private send does not arm the watchdog

- **WHEN** agent A calls `send_message_by_id({to_agent_id: B, body:'FYI', need_reply:false})`
- **THEN** the created `messages` row has `ack_deadline_at` NULL

#### Scenario: Broadcast does not arm the watchdog

- **WHEN** agent A calls `broadcast({body:'all-hands'})`
- **THEN** every created `messages` row has `ack_deadline_at` NULL

#### Scenario: Role fan-out does not arm the watchdog

- **WHEN** agent A calls `broadcast_to_role({to_role:'worker', body:'status'})`
- **THEN** every created `messages` row has `ack_deadline_at` NULL

#### Scenario: Disabled auto-poke still arms the watchdog

- **WHEN** agent A calls `send_message_by_id({to_agent_id: B, body:'question', auto_poke:false})`
- **THEN** the created `messages` row has `ack_deadline_at` set to `sent_at` plus 15 minutes

### Requirement: The watchdog survives a daemon restart

The unread watchdog MUST NOT be scheduled with an in-process timer alone.  Its deadline is persisted on the `messages` row, and the daemon SHALL evaluate due rows both at startup and periodically thereafter.

An in-memory `setTimeout` schedule is explicitly rejected for this mechanism: the existing auto-poke retry schedule (`src/mcp/poke-retry.ts`) is exactly that, holds no database state, and performs no startup scan, so a daemon restart silently discards every pending tick.  A 15-minute window makes that failure mode routine, and it would strike precisely when the feature is most needed — a sender that trusts the watchdog sleeps more willingly than one that does not.

A deadline that came due while the daemon was down MUST be evaluated on the next scan rather than skipped.

A scan MAY bound how many due rows it examines per pass, so long as the remainder stays due for the following pass.  Two consequences MUST be accepted rather than papered over: with a backlog larger than the bound, the overflow waits one more interval; and because rows are ordered by `ack_deadline_at`, which a retry release does not change, rows being retried keep sorting ahead of newer ones and can hold the front of the queue for up to the retry window.

The retry window is anchored to `ack_deadline_at`, not to the first attempt.  A daemon that was down past `ack_deadline_at + 10 minutes` therefore gives each backlog alert exactly one attempt, and a transient failure on that attempt is treated as terminal.  This is a deliberate consequence of deriving the bound from stored state instead of an attempt counter: the restart path gets the alert, but not the retry protection.

#### Scenario: Deadline that elapsed while the daemon was down still alerts

- **GIVEN** agent A sent message `m1` to agent B with `ack_deadline_at` in the future
- **AND** the daemon stops before that deadline and restarts after it
- **WHEN** the daemon runs its startup scan
- **AND** B's cursor has not passed `m1`'s `event_id`
- **THEN** the daemon emits the unread alert for `m1`

#### Scenario: Watchdog state is readable from the database alone

- **GIVEN** agent A sent message `m1` to agent B with `need_reply=1`
- **WHEN** the daemon process is inspected after a restart
- **THEN** the pending watchdog for `m1` is recoverable from the `messages` row without any in-process state

### Requirement: A due watchdog alerts the sender exactly once and only while unread

When a scan finds a row whose `ack_deadline_at` is in the past and whose `ack_alerted_at` is NULL, the daemon SHALL evaluate the read predicate for the recipient:

1. Read → the daemon MUST emit no alert.  It MUST set `ack_alerted_at` so the row is not re-examined.
2. Unread → the daemon MUST poke the **sender** with the unread alert, then set `ack_alerted_at`.

`ack_alerted_at` MUST be set in both outcomes, so a message can never produce a second alert.

If the sender's agent row no longer exists, the daemon MUST emit no alert and MUST still set `ack_alerted_at`.

An alert whose poke fails MUST be classified before the row is given up:

- **Transient** — `guard_failed`, `kimi_session_busy`, `channel_sink_failed`.  The daemon MUST release its claim (`ack_alerted_at` back to NULL) so a later sweep retries, for as long as `now` is within 10 minutes of `ack_deadline_at`.  The alert travels the ordinary poke path and therefore passes the quiet guard, so a sender that is merely mid-turn when the watchdog fires produces `guard_failed`; abandoning there would drop the alert for the most ordinary reason imaginable and recreate the silent stall this capability exists to remove.
- **Terminal, or past the 10-minute window** — the claim stands and no further attempt is made.  A thrown exception is terminal too: it carries no classifiable reason.

The retry bound MUST NOT require an attempt counter: the window is derived from the already-stored `ack_deadline_at`, and how many attempts fit inside it follows from the sweep interval.

Claiming across the poke is what makes concurrent sweeps unable to double-alert; releasing afterwards is what keeps a momentary failure from being recorded as a verdict.

A FAILED alert is recorded only in the daemon log; a successful one is recorded nowhere at all.  `get_delivery_status` does not expose it, because `message_delivery_status` is keyed by `(message_id, recipient)` and describes the wake-up sent to the RECIPIENT, not the alert sent to the sender.  Nothing in the message row distinguishes "alerted successfully" from "alert abandoned"; `ack_alerted_at` records only that the watchdog stopped examining the row.

**Known limitation — a crash between claim and release abandons that alert.**  The claim is taken before the poke, so a process that dies mid-alert leaves the row claimed and no later sweep reconsiders it.  This is the price of making double-alerting impossible without a second state column.

#### Scenario: Unread at deadline pokes the sender

- **GIVEN** message `m1` from A to B has a past `ack_deadline_at` and NULL `ack_alerted_at`
- **WHEN** the scan runs and B's cursor has not passed `m1`'s `event_id`
- **THEN** the daemon pokes A with the unread alert
- **AND** sets `m1.ack_alerted_at`

#### Scenario: Read at deadline emits nothing

- **GIVEN** message `m1` from A to B has a past `ack_deadline_at` and NULL `ack_alerted_at`
- **WHEN** the scan runs and B's cursor has passed `m1`'s `event_id`
- **THEN** the daemon pokes no one
- **AND** sets `m1.ack_alerted_at`

#### Scenario: A message alerts at most once

- **GIVEN** message `m1` already has a non-NULL `ack_alerted_at`
- **WHEN** a later scan runs and `m1` is still unread
- **THEN** the daemon pokes no one

#### Scenario: Vanished sender suppresses the alert without stranding the row

- **GIVEN** message `m1` from A to B is due and unread
- **AND** agent A's row no longer exists
- **WHEN** the scan runs
- **THEN** the daemon pokes no one
- **AND** sets `m1.ack_alerted_at`

#### Scenario: A terminally failed alert poke is not retried

- **GIVEN** message `m1` from A to B is due and unread
- **WHEN** the scan runs and the poke to A fails with `pane_dead`
- **THEN** the daemon sets `m1.ack_alerted_at`
- **AND** schedules no further attempt for `m1`

#### Scenario: A transiently failed alert is retried on the next sweep

- **GIVEN** message `m1` from A to B is due and unread
- **AND** `now` is within 10 minutes of `m1.ack_deadline_at`
- **WHEN** the scan runs and the poke to A fails with `guard_failed`
- **THEN** `m1.ack_alerted_at` is left NULL
- **AND** a later scan attempts the alert again
- **AND** that later attempt can still succeed

#### Scenario: A transient failure past the retry window is abandoned

- **GIVEN** message `m1` from A to B is due and unread
- **AND** `now` is more than 10 minutes past `m1.ack_deadline_at`
- **WHEN** the scan runs and the poke to A fails with `guard_failed`
- **THEN** the daemon sets `m1.ack_alerted_at`
- **AND** schedules no further attempt for `m1`

#### Scenario: A thrown alert dispatch is treated as terminal

- **GIVEN** message `m1` from A to B is due and unread
- **WHEN** the scan runs and the alert dispatch throws
- **THEN** the daemon sets `m1.ack_alerted_at`
- **AND** schedules no further attempt for `m1`

### Requirement: The unread alert must not read as new mail

The unread alert is injected through the same poke transport as a wake-up hint, so it MUST be written so a sender cannot mistake it for one.  The existing wake-up hint is `新邮件 from <sender> → <recipient_name>@<recipient_team>, 请调 get_inbox 查看`; an alert shaped like that would send the woken agent to `get_inbox`, where it finds nothing.

The alert text SHALL contain all of:

1. An explicit statement that this is a delivery alert and NOT new mail, and that `get_inbox` is not needed.
2. The recipient identity as `<name>@<team>` and the unread interval, so the sender knows which conversation stalled.
3. The recipient's last recorded wake delivery `skip_reason` (or an explicit marker when there is none).  This is what lets the sender distinguish "the pane was taken over, a human must re-register it" from "every poke succeeded but the recipient's agent is stuck" — the two demand different follow-ups.
4. A statement that the recipient may be unreachable and that the sender should decide whether to take the work over itself.

5. The stalled message's `subject`, with an explicit placeholder when it is absent or empty.  A sender may have several messages outstanding to the same recipient, and without the subject the alert cannot say which one stalled.  This is a deliberate divergence from the wake-up hint, which carries neither subject nor body: that hint goes to the RECIPIENT, who can just read its inbox, whereas the alert goes to the message's own AUTHOR.  Safety does not rest on that semantic argument — the alert is dispatched through the same pane-ownership recheck as ordinary mail, so a reassigned pane is refused by mechanism.

The alert MUST NOT include the original message body.

#### Scenario: Alert states it is not new mail

- **WHEN** the daemon emits an unread alert to sender A
- **THEN** the injected text states that it is a delivery alert and not new mail
- **AND** states that `get_inbox` is not required

#### Scenario: Alert names the recipient and the stall

- **WHEN** the daemon emits an unread alert for a message to `bob` in team `alpha`
- **THEN** the injected text contains `bob@alpha`
- **AND** states that the message has gone unread for 15 minutes

#### Scenario: Alert carries the last skip reason

- **GIVEN** the recipient's wake delivery status has `skip_reason='pane_reassigned'`
- **WHEN** the daemon emits the unread alert
- **THEN** the injected text contains `pane_reassigned`

#### Scenario: Alert marks an absent skip reason explicitly

- **GIVEN** the recipient's wake delivery status has `skip_reason` NULL because the poke was delivered
- **WHEN** the daemon emits the unread alert
- **THEN** the injected text states explicitly that there is no skip reason rather than omitting the field

#### Scenario: Alert names which message stalled

- **GIVEN** message `m1` carries subject `deploy review`
- **WHEN** the daemon emits the unread alert for `m1`
- **THEN** the injected text contains `deploy review`

#### Scenario: Alert marks an absent subject explicitly

- **GIVEN** message `m1` was sent with no subject
- **WHEN** the daemon emits the unread alert for `m1`
- **THEN** the injected text states explicitly that there is no subject rather than leaving the field blank

#### Scenario: Alert never carries the message body

- **GIVEN** message `m1` has body `secret-payload`
- **WHEN** the daemon emits the unread alert for `m1`
- **THEN** the injected text does not contain `secret-payload`
