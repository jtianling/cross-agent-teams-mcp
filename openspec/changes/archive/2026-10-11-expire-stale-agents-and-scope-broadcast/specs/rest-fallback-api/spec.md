## ADDED Requirements

### Requirement: REST send and inbox count as agent activity

`POST /api/send` SHALL refresh `agents.last_seen_at` of the resolved sender, and `GET /api/inbox` SHALL refresh `agents.last_seen_at` of the resolved inbox owner, to the current timestamp whenever the request resolves an existing agent and the underlying service call does not fail.  Sending and reading mail through the REST surface are actions taken on behalf of that agent, so they MUST keep it inside both the 7-day fan-out activity window and the 30-day registration expiry, exactly like the equivalent MCP tool calls.

This is a data-layer write on the `agents` row only and does not relax "REST calls have zero session and delivery side-effects".  Requests that fail validation or name an unknown agent MUST NOT touch any row.  `GET /api/agents`, `DELETE /api/agents/:agent_id`, and the `/api/runtime/*` routes are unchanged: they are not agent activity and MUST NOT refresh `last_seen_at`.

#### Scenario: REST send refreshes the sender's last_seen_at

- **GIVEN** agent `alice` in team `default` has `last_seen_at = now - 10 days`
- **WHEN** a loopback caller issues `POST /api/send` with `from = { team: "default", name: "alice" }` and a valid recipient
- **THEN** the message is sent
- **AND** `alice`'s `last_seen_at` is within the last second

#### Scenario: REST inbox refreshes the owner's last_seen_at

- **GIVEN** agent `alice` in team `default` has `last_seen_at = now - 10 days`
- **WHEN** a loopback caller issues `GET /api/inbox?team=default&name=alice`
- **THEN** the inbox is returned
- **AND** `alice`'s `last_seen_at` is within the last second

#### Scenario: Listing agents is not activity

- **GIVEN** agent `alice` in team `default` has `last_seen_at = now - 10 days`
- **WHEN** a loopback caller issues `GET /api/agents?team=default`
- **THEN** `alice`'s `last_seen_at` is unchanged
