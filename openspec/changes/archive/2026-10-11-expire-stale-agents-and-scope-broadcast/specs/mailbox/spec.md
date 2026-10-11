## MODIFIED Requirements

### Requirement: Fan-out routing delivers to all team members

`broadcast` and `broadcast_to_role` SHALL enumerate their full member set and then deliver a mailbox row to every RECENTLY ACTIVE member only. A member is recently active when its `agents.last_seen_at >= now - 7 days`. `last_seen_at` is refreshed by any tool invocation of that agent, including `get_inbox`, so reading mail counts as activity. Specifically:

1. `broadcast({ body })` — every recently active agent in the caller's team across all devices, except the caller itself.
2. `broadcast_to_role({ to_role })` — every recently active agent whose `role` matches in the caller's team, except the caller itself.

A member that is not recently active MUST NOT receive a `messages` row for the fan-out, MUST NOT appear in `recipients` or in the event's `payload.recipients`, MUST NOT be poked, and MUST NOT get a `message_delivery_status` row. The 7-day window is the ONLY liveness filter: the fan-out MUST NOT consult `online`, pane presence, or transport state when selecting recipients. Among recently active members, the auto-poke wake attempt remains best-effort and is gated only by the existing pane / transport checks (`no_pane`, `guard_failed`, `tmux_unavailable`) and retry rules.

A successful fan-out response MUST carry `skipped_inactive: number`, the count of enumerated members excluded by the 7-day window (`0` when none).

The daemon SHALL return `{ error: "unknown_recipient" }` from a fan-out when no recently active member remains: for `broadcast`, when the caller is the sole member of its team or every other member is inactive; for `broadcast_to_role`, when no agent in the team holds that role or every holder is inactive. When the set is empty only because members were excluded by the window, the error payload MUST also carry `skipped_inactive` with that count. No `messages` or `events` row is written in either case.

Direct sends are NOT fan-outs and are NOT subject to the window — see "Direct send ignores the activity window".

#### Scenario: Broadcast delivers to recently active members and skips the rest

- **GIVEN** team "default" has agents A (sender, `last_seen_at = now`), B (`last_seen_at = now - 1 min`), C (`last_seen_at = now - 3 days`), D (`last_seen_at = now - 8 days`)
- **WHEN** A calls `broadcast({ body: "status update" })`
- **THEN** the response `recipients` array contains exactly `[B, C]` (order-insensitive)
- **AND** the response has `skipped_inactive: 1`
- **AND** B and C each have a new row in `messages` for this broadcast; D has none
- **AND** the `events` row has `payload.recipients = [B, C]`
- **AND** all resulting messages rows have `from_team = to_team = 'default'`

#### Scenario: broadcast_to_role skips inactive role holders

- **GIVEN** team "default" has agents F1 (`role=frontend`, `last_seen_at = now - 1 min`), F2 (`role=frontend`, `last_seen_at = now - 2 hours`), F3 (`role=frontend`, `last_seen_at = now - 10 days`)
- **WHEN** A calls `broadcast_to_role({ to_role: 'frontend', body: "hi frontends" })`
- **THEN** `recipients` contains exactly `[F1, F2]`
- **AND** the response has `skipped_inactive: 1`
- **AND** F3 has no mailbox entry for this event

#### Scenario: A member exactly inside the window is addressed

- **GIVEN** team "default" has agents A (sender) and B (`last_seen_at = now - 6 days 23 hours`)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response `recipients` array contains exactly `[B]`
- **AND** the response has `skipped_inactive: 0`

#### Scenario: Reading mail keeps a member inside the window

- **GIVEN** agent B has `last_seen_at = now - 8 days`
- **WHEN** B calls `get_inbox`
- **AND** afterwards A (same team) calls `broadcast({ body: "hello" })`
- **THEN** `recipients` contains B

#### Scenario: Broadcast with the sender as sole team member returns unknown_recipient

- **GIVEN** team "solo" contains only agent A (the sender)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: Broadcast where every other member is inactive returns unknown_recipient with a count

- **GIVEN** team "default" has agents A (sender), B (`last_seen_at = now - 8 days`), C (`last_seen_at = now - 20 days`)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response is `{ error: "unknown_recipient", skipped_inactive: 2 }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: to_role with no agent under the role returns unknown_recipient

- **GIVEN** no agent in team "default" holds role `archivist`
- **WHEN** caller A calls `broadcast_to_role({ to_role: 'archivist', body: "anything" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: MCP tool descriptions reflect the activity window

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `broadcast` or `broadcast_to_role`
- **THEN** the description states that only members active within the last 7 days are addressed
- **AND** it mentions the `skipped_inactive` count
- **AND** it states that `send_message` reaches a specific agent regardless of the window

### Requirement: broadcast excludes sender

`broadcast({body, subject?, auto_poke?})` SHALL fan-out to every recently active agent (see "Fan-out routing delivers to all team members") in the caller's team except the caller itself, across ALL devices that contribute agents to that team. `broadcast` MUST NOT accept any `to_team`, `to_role`, `to_agent_id`, or `to_device` parameter — it is strictly "same-team, all recently active members except sender, every device".

For every recipient, the persisted `messages` row MUST have `from_team` and `to_team` both equal to the caller's team. The paired `events` row MUST have equal `from_team` / `to_team` values. Recipient device is irrelevant to the message rows; routing uses the recipient's `agent_id`.

#### Scenario: Sender not in recipients

- **GIVEN** team `default` has recently active agents `sess-A`, `sess-B`, `sess-C` on `device='host-a'`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`
- **AND** all resulting messages rows have `from_team=to_team='default'`

#### Scenario: Broadcast spans every device in the caller's team

- **GIVEN** the caller is on `(device='host-a', team='default')`
- **AND** team `default` has recently active `alice` on `device='host-a'`, `bob` on `device='host-a'`, and `creator` on `device='host-b'`
- **WHEN** the caller calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains `['alice', 'bob', 'creator']` (order-insensitive; both same-device peers AND the cross-device `creator` are addressed)
- **AND** all resulting messages rows have `from_team=to_team='default'`

### Requirement: broadcast_to_role tool fans out to same-team role

The daemon SHALL expose an MCP tool `broadcast_to_role({to_role, body, subject?, auto_poke?})` that materializes one `messages` row per recently active agent (see "Fan-out routing delivers to all team members") in the caller's team whose `role = to_role`, sharing a single `event_id`.  Sender is excluded from recipients.  The fan-out spans every device that contributes role-matching agents to the caller's team.  All rows MUST have `from_team = to_team = caller.team` and `to_role = to_role` set; `to_agent_id` is set to the specific agent id (same pattern as the paired rows produced by the removed `send_message({to_role})` behavior, just relocated).

If no recently active agent in the caller's team matches `to_role` on any device, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event; when role holders exist but all are inactive, the payload also carries `skipped_inactive`.

`broadcast_to_role` MUST NOT accept a `to_team` parameter or a `to_device` parameter — it is strictly same-team, all-devices.  The tool's MCP description MUST explicitly state this constraint.

Auto-poke, quiet-guard, retry-backoff, parallel fan-out, and hint-only poke body requirements apply identically to `broadcast_to_role` as they do to `broadcast` (see the Broadcast and Auto-poke requirements above).

The response shape MUST be:

```
{
  message_id: string,
  event_id: number,
  recipients: string[],           // agent_id list
  skipped_inactive: number,       // role holders excluded by the 7-day window
  poked: boolean,
  poke_skip_reasons?: Array<{agent_id, reason}>,
  retry_scheduled: boolean,
  retry_delays_s?: number[]
}
```

#### Scenario: Two role-matching agents in team receive fan-out

- **GIVEN** recently active agents `sess-F1` and `sess-F2` both have `role='frontend'` in team `default`, caller `sess-X` also in team `default`
- **WHEN** `sess-X` calls `broadcast_to_role({to_role:'frontend', body:'ship status'})`
- **THEN** `recipients` contains `['sess-F1', 'sess-F2']` (order-insensitive)
- **AND** `skipped_inactive` is `0`
- **AND** two `messages` rows appear with identical `event_id`, `from_team=to_team='default'`, `to_role='frontend'`
- **AND** `recipients` does NOT include `sess-X` even if `sess-X` also has `role='frontend'` (sender always excluded)

#### Scenario: Role fan-out spans devices in the caller's team

- **GIVEN** team `default` has recently active `worker-A` on `device='host-a'` with `role='worker'` and `worker-B` on `device='host-b'` with `role='worker'`
- **AND** the caller is on `(device='host-a', team='default')` with `role='lead'`
- **WHEN** the caller calls `broadcast_to_role({to_role:'worker', body:'task'})`
- **THEN** `recipients` contains both `worker-A` and `worker-B` (cross-device fan-out)

#### Scenario: No matching role returns unknown_recipient

- **GIVEN** no agent in team `default` has `role='nonexistent'` on any device
- **WHEN** caller calls `broadcast_to_role({to_role:'nonexistent', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no `messages` or `events` row is written

#### Scenario: Only inactive role holders returns unknown_recipient with a count

- **GIVEN** the only agent in team `default` with `role='worker'` has `last_seen_at = now - 9 days`
- **WHEN** caller calls `broadcast_to_role({to_role:'worker', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient', skipped_inactive: 1 }`
- **AND** no `messages` or `events` row is written

#### Scenario: Default auto-poke on broadcast_to_role fires for all idle-pane recipients in parallel

- **GIVEN** three recently active role=`worker` agents in same team as caller, all with `tmux_pane_id` and idle panes, `POKE_QUIET_MS=100`
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

## ADDED Requirements

### Requirement: Direct send ignores the activity window

`send_message` and `send_message_by_id` (and their REST equivalent `POST /api/send`) SHALL NOT consult the recipient's `last_seen_at`. As long as the recipient's `agents` row exists, the daemon MUST write the `messages` row and event, exactly as before. Because agent rows expire only after 30 days without activity, a directly addressed agent remains reachable for the full 30 days after it was last seen.

#### Scenario: Direct send reaches an agent idle for longer than the broadcast window

- **GIVEN** agent B in team `default` has `last_seen_at = now - 20 days`
- **WHEN** agent A (same team) calls `send_message({ to_agent_name: 'B', body: 'ping' })`
- **THEN** the response carries a `message_id` and `recipients = [B]`
- **AND** B has a new `messages` row
- **AND** a later `get_inbox` by B returns that message

#### Scenario: Direct send by id reaches an idle agent

- **GIVEN** agent B has `last_seen_at = now - 29 days`
- **WHEN** agent A calls `send_message_by_id({ to_agent_id: B, body: 'ping' })`
- **THEN** B has a new `messages` row
