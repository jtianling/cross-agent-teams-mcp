## MODIFIED Requirements

### Requirement: Loopback-only REST lifeboat surface

The daemon SHALL expose six REST endpoints on its existing HTTP port under the `/api/` prefix.  Four are fallback or operator-maintenance endpoints for agents whose MCP client transport is unavailable:

- `POST /api/send`
- `GET /api/inbox`
- `GET /api/agents`
- `DELETE /api/agents/:agent_id`

Two are sessionless launcher control endpoints for OpenCode runtime recovery:

- `POST /api/runtime/opencode/reserve`
- `POST /api/runtime/opencode/commit`

These endpoints MUST be reachable ONLY from a loopback origin. Any request whose classified origin is `remote` (non-loopback peer address, per the daemon's existing `classifyPeerAddress` / `req.xatsPeer` classification) MUST be rejected with HTTP 403 and MUST NOT perform any data-layer action. Remote callers have no REST API by design.

The endpoints are additive: they MUST NOT alter the behavior, framing, or availability of `POST/GET/DELETE /mcp` or `GET /health`.

#### Scenario: Loopback request reaches the REST API

- **GIVEN** the daemon is running and a caller connects from `127.0.0.1`
- **WHEN** the caller issues `GET /api/agents?team=default`
- **THEN** the request is served (not 403) and returns the team's agents

#### Scenario: Remote request is refused

- **GIVEN** the daemon is bound so a non-loopback peer can connect (e.g. `0.0.0.0:9100`)
- **WHEN** a caller from `10.0.0.42` issues any `/api/*` request
- **THEN** the response status is 403
- **AND** no message is inserted, no cursor is advanced, and no agent state changes

#### Scenario: Remote caller cannot remove an agent row

- **GIVEN** the daemon is bound so a non-loopback peer can connect
- **AND** an agent row exists with `agent_id` `A`
- **WHEN** a caller from a remote address issues `DELETE /api/agents/A` with a valid bearer token
- **THEN** the response status is 403
- **AND** the row for `A` still exists

#### Scenario: MCP and health endpoints are unaffected

- **WHEN** the REST endpoints are mounted
- **THEN** `POST /mcp`, `GET /mcp`, `DELETE /mcp`, and `GET /health` behave exactly as before

### Requirement: REST calls have zero session and delivery side-effects

The lifeboat endpoints `POST /api/send`, `GET /api/inbox`, `GET /api/agents`, and `DELETE /api/agents/:agent_id` MUST NOT create, mutate, close, or take over
any in-memory MCP session; MUST NOT change any `(device, team, name) →
connection_id` binding held by `RegisterAgentService`; and MUST NOT attach,
detach, or rebind any delivery sink.  They operate at the data layer on behalf
of an already-registered agent or operator.

The OpenCode runtime control endpoints are the only exception to the zero
delivery-mutation rule.  They SHALL mutate only the target row fields owned by
`OpencodeRuntimeRecoveryService`: the runtime generation fence and the exact
OpenCode delivery commit.  They MUST NOT create an unknown agent row, bind the
REST caller as an agent, create or close an MCP session, change a connection
ledger entry, attach a delivery sink or perform a registration takeover.

Consequently, a lifeboat call remains safe regardless of whether the named
agent has a live MCP session.  A runtime commit likewise leaves the REST caller
unbound and relies on the exact OpenCode session to reconnect itself.

The REST surface MUST NOT expose `register_agent` or any operation that binds
the HTTP caller to an identity.  An agent that has never registered has no row;
runtime reserve reports `need_register` and commit reports the matching service
error without creating one.

#### Scenario: Sending via REST does not disturb the sender's live MCP session

- **GIVEN** agent `alice` in team `default` has a live MCP session `S1` with an attached delivery binding
- **WHEN** a loopback caller issues `POST /api/send` with `from = { team: "default", name: "alice" }`
- **THEN** the message is sent as `alice`
- **AND** session `S1` is still present in the daemon's `sessions` map with its delivery binding intact (no takeover, no force-close)

#### Scenario: REST send while the agent's MCP session is dead

- **GIVEN** agent `alice`'s MCP session has already been closed, but her `agents` row still exists
- **WHEN** a loopback caller issues `POST /api/send` with `from = { team: "default", name: "alice" }`
- **THEN** the message is sent as `alice` (resolved from the persisted `agents` row)
- **AND** no MCP session is created for `alice`

#### Scenario: Runtime commit leaves the REST caller unbound

- **WHEN** a loopback caller commits a reserved OpenCode runtime through REST
- **THEN** only the target row's recovery-owned delivery fields may change
- **AND** the response reports `connection_bound:false`
- **AND** no MCP session or connection ledger binding is created for the REST caller
