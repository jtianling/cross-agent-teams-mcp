# rest-fallback-api Specification

## Purpose
TBD - created by archiving change add-rest-fallback-api. Update Purpose after archive.
## Requirements
### Requirement: Loopback-only REST lifeboat surface

The daemon SHALL expose four REST endpoints on its existing HTTP port under the `/api/` prefix, as a fallback for agents whose MCP client transport is unavailable and for local operator maintenance:

- `POST /api/send`
- `GET /api/inbox`
- `GET /api/agents`
- `DELETE /api/agents/:agent_id`

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

A `/api/*` call MUST NOT create, mutate, close, or take over any in-memory MCP session; MUST NOT change any `(device, team, name) → connection_id` binding held by `RegisterAgentService`; and MUST NOT attach, detach, or rebind any delivery sink (SSE fanout, channel-wake fanout, or tmux pane binding). It operates purely at the data layer (the `agents`, `messages`, and events tables) on behalf of an ALREADY-REGISTERED `agent_id`.

Consequently, a REST call is safe regardless of whether the named agent currently has a live MCP session: it never disturbs a live session and never performs the cross-session `register_agent` takeover that raw MCP-over-`curl` would.

The REST surface MUST NOT expose `register_agent` or any registration/identity-binding operation. An agent that has never registered has no `agent_id` and therefore cannot be named as a sender or inbox owner.

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

### Requirement: POST /api/send sends as an existing agent, reusing the MCP send path

`POST /api/send` SHALL accept a JSON body `{ from: { team, name }, to: { team, name } | { agent_id }, subject?, body, need_reply?, auto_poke? }`.

The daemon MUST resolve `from` by looking up the registered agent whose `(team, name)` matches on the local device. If no such registered agent exists, the daemon MUST reject the request (e.g. `unknown_sender`) and MUST NOT insert a message. It MUST then run the SAME message-send logic used by the `send_message` MCP tool (`SendMessageService`): resolve the recipient by `(to.team, to.name)` or `to.agent_id`, insert the message and its event, and — unless `auto_poke` is `false` — fan out the delivery poke to the recipient exactly as the MCP tool does. The response body MUST be the same JSON result shape the `send_message` tool returns (message id, event id, recipients, poke outcome).

`need_reply` and `auto_poke` MUST default to the same values as the MCP tool (`need_reply` defaults true, `auto_poke` defaults true).

#### Scenario: Send to a recipient by team and name

- **GIVEN** registered agents `alice(default)` and `bob(default)` exist, and `bob` has a deliverable transport
- **WHEN** a loopback caller `POST /api/send` with `{ from: {team:"default",name:"alice"}, to: {team:"default",name:"bob"}, body:"hi" }`
- **THEN** a message row from `alice`'s agent_id to `bob`'s agent_id is inserted
- **AND** `bob` is poked via his delivery transport
- **AND** the response contains the message id, event id, and recipients, matching the `send_message` tool result shape

#### Scenario: Unknown sender is rejected with no insert

- **WHEN** a loopback caller `POST /api/send` with `from = { team:"default", name:"ghost" }` where no registered agent `ghost(default)` exists
- **THEN** the request is rejected (e.g. `unknown_sender`)
- **AND** no message row is inserted

#### Scenario: Unknown recipient returns the same error as the tool

- **WHEN** a loopback caller `POST /api/send` targets a `(team, name)` that is not a registered agent
- **THEN** the response reports `unknown_recipient` (the same outcome the `send_message` tool produces) with no side effects

#### Scenario: auto_poke false inserts without poking

- **WHEN** a loopback caller `POST /api/send` with `auto_poke: false`
- **THEN** the message is inserted and the recipient is NOT poked
- **AND** the response reflects `poked: false`, matching the tool behavior

### Requirement: GET /api/inbox reads an agent's inbox, reusing the MCP inbox path

`GET /api/inbox` SHALL accept query parameters `team`, `name`, and optional `since_event_id`. The daemon MUST resolve the caller agent by `(team, name)` on the local device; if none exists it MUST reject the request. It MUST then read the inbox using the SAME logic as the `get_inbox` MCP tool (`GetInboxService`):

- When `since_event_id` is OMITTED, the read MUST advance the agent's stored `last_processed_event_id` cursor (a real read), matching the MCP default.
- When `since_event_id` is SUPPLIED (any integer, including 0), the read MUST be read-only inspection and MUST NOT advance the stored cursor.

The response body MUST be the same JSON shape the `get_inbox` tool returns (`messages`, `has_more`, `last_event_id`).

#### Scenario: Default read advances the cursor

- **GIVEN** agent `alice(default)` has unread messages and stored cursor `C`
- **WHEN** a loopback caller `GET /api/inbox?team=default&name=alice` (no `since_event_id`)
- **THEN** the unread messages past `C` are returned
- **AND** `alice`'s stored `last_processed_event_id` is advanced to the highest returned event id

#### Scenario: Explicit since_event_id is read-only

- **GIVEN** agent `alice(default)` has stored cursor `C`
- **WHEN** a loopback caller `GET /api/inbox?team=default&name=alice&since_event_id=0`
- **THEN** messages after event id 0 are returned for inspection
- **AND** `alice`'s stored `last_processed_event_id` is unchanged

#### Scenario: Unknown inbox owner is rejected

- **WHEN** a loopback caller `GET /api/inbox?team=default&name=ghost` where no such registered agent exists
- **THEN** the request is rejected and no cursor is created or advanced

### Requirement: GET /api/agents lists a team's agents

`GET /api/agents` SHALL accept a `team` query parameter and return the agents in that team, using the same data the `list_agents` MCP tool returns (team-scoped). It MUST NOT return cross-team agents.

#### Scenario: List a team's agents

- **GIVEN** team `default` has registered agents `alice` and `bob`, and team `other` has `carol`
- **WHEN** a loopback caller `GET /api/agents?team=default`
- **THEN** the response lists `alice` and `bob`
- **AND** does NOT include `carol`

### Requirement: REST auth and error responses

Every `/api/*` request MUST satisfy the same token authentication as `/mcp`: when the daemon was started with `--token`, a request missing or mismatching the token (via `Authorization: Bearer <token>` or `token=<token>` query) MUST be rejected with HTTP 401. When no token is configured, requests are accepted (subject still to the loopback gate).

REST error responses (401 auth, 403 remote, 4xx validation, `unknown_sender` / `unknown_recipient`) SHALL use a plain JSON body describing the error. Because the consumers are HTTP/`curl` clients rather than a strict JSON-RPC deserializer, a plain `{ "error": <code> }` body is acceptable here (this surface is not subject to the MCP JSON-RPC transport-poisoning constraint that governs `/mcp`).

#### Scenario: Missing token is rejected when a token is configured

- **GIVEN** the daemon was started with `--token s3cret`
- **WHEN** a loopback caller issues `POST /api/send` without the token
- **THEN** the response status is 401

#### Scenario: Loopback gate is checked independently of the token

- **GIVEN** the daemon was started with `--token s3cret`
- **WHEN** a remote caller presents the correct token to `/api/send`
- **THEN** the response status is 403 (loopback gate), because remote callers have no REST API regardless of token

### Requirement: Loopback-trust identity is an accepted tradeoff

Because `/api/*` resolves the sender by asserted `(team, name)` rather than a session-bound proven identity, the REST surface MUST remain restricted to loopback origin AND MUST NOT expose `register_agent` or any other identity-binding / session-mutating operation — these two constraints together bound the blast radius. Under them, any local process that can reach the loopback interface (and present the token, if configured) can act as ANY local agent with no takeover and no visible signal; this is an ACCEPTED tradeoff, consistent with the project's existing local-trust model (local agents already mutually trust one another and a local process can already impersonate in-band).

#### Scenario: Any local process may act as any local agent

- **GIVEN** the token (if any) is presented and the request is from loopback
- **WHEN** a local process `POST /api/send` naming `from = { team, name }` of an agent it does not "own"
- **THEN** the message is sent as that agent (accepted under the local-trust model), with no takeover of that agent's session

### Requirement: Inbox cursor-advance CSRF exposure is a bounded accepted risk

Because `GET /api/inbox` advances the reader's cursor by default and "loopback" includes a browser on the same machine, a cross-site web page could cause the browser to issue a state-changing `GET /api/inbox` (a CSRF). When the daemon runs with `--token`, the token gate blocks this entirely (the cross-site request lacks the token → 401 before any cursor advance). When no token is configured, this exposure is ACCEPTED as bounded: the attacker cannot read the response (CORS) and cannot send or impersonate; the only effect is that the named agent's cursor advances, so it may miss unread messages. The daemon MUST therefore keep the loopback + token gate as the mitigation and MUST NOT expose any data-reading or state-mutating REST operation whose cross-site abuse would exceed this bound. Deployments that cannot accept even the missed-message effect MUST run the daemon with `--token`.

#### Scenario: Token blocks the cross-site cursor advance

- **GIVEN** the daemon was started with `--token`
- **WHEN** a request to `GET /api/inbox` arrives without the token
- **THEN** it is rejected with 401 and the agent's `last_processed_event_id` is NOT advanced

### Requirement: DELETE /api/agents/:agent_id removes a single registry row

The daemon SHALL expose `DELETE /api/agents/:agent_id`, which removes exactly the `agents` row whose `agent_id` equals the path parameter.

The target SHALL be addressed by `agent_id` only. The endpoint MUST NOT resolve its target through `(localDevice, team, name)` the way `POST /api/send` and `GET /api/inbox` resolve theirs, because rows carrying a device label other than the daemon's `localDevice` are legitimate removal targets and would be unreachable under that resolution.

On success the response status SHALL be 200 with body `{ deleted: true, agent_id, team, name }`, echoing the identity of the row that was removed.

When no row matches the given `agent_id`, the response status SHALL be 404 with body `{ error: 'unknown_agent' }` — the same error string `unregister_self` returns for the same condition. The endpoint MUST NOT report success for a target that did not exist.

Removal SHALL be performed through the same transactional helper used by `unregister_self`, so that both entry points share one removal code path.

The endpoint MUST NOT gate removal on whether the target appears live. In particular it MUST NOT consult the `online` flag: that flag is derived from `isAgentLive`, which for runtimes registering without `runtime_ui_pid` and without `tmux_pane_id` (kimi-code) falls through to a multi-day `last_seen_at` window and therefore reads `true` long after the agent is gone.

#### Scenario: Removing an existing row

- **GIVEN** an agent `alice` in team `default` is registered with `agent_id` `A`
- **WHEN** a loopback caller issues `DELETE /api/agents/A`
- **THEN** the response status is 200 with `{ deleted: true, agent_id: "A", team: "default", name: "alice" }`
- **AND** `GET /api/agents?team=default` no longer lists `alice`

#### Scenario: Removing an unknown id reports 404

- **GIVEN** no agent row has `agent_id` `does-not-exist`
- **WHEN** a loopback caller issues `DELETE /api/agents/does-not-exist`
- **THEN** the response status is 404 with `{ error: 'unknown_agent' }`

#### Scenario: Repeating a removal reports 404

- **GIVEN** a loopback caller has already removed `agent_id` `A` successfully
- **WHEN** the same caller issues `DELETE /api/agents/A` again
- **THEN** the response status is 404 with `{ error: 'unknown_agent' }`

#### Scenario: A row on a foreign device label can be removed

- **GIVEN** the daemon's `localDevice` is `jt`
- **AND** an agent row exists in team `default` with device `other-host` and `agent_id` `B`
- **WHEN** a loopback caller issues `DELETE /api/agents/B`
- **THEN** the response status is 200 and the row is removed

#### Scenario: An apparently-online row can be removed

- **GIVEN** an agent row whose computed `online` flag is `true`
- **WHEN** a loopback caller issues `DELETE /api/agents/` for that row's id
- **THEN** the removal succeeds and is not refused on liveness grounds


### Requirement: POST /api/runtime/kimi/commit refreshes a kimi identity's coordinates for its launcher

The daemon SHALL expose a loopback-only `POST /api/runtime/kimi/commit` accepting `{ protocol_version, identity_key, base_url, session_id }` that updates which kimi session an already-registered identity is delivered to, and SHALL NOT create an identity (it has no `name` and cannot).

The route exists because the agent cannot do this itself: kimi never scopes `XATS_IDENTITY_KEY` per session, so under a server-hosted engine an agent reading its own environment gets another pane's key. Only the launcher knows which key belongs to which pane, and this route is how it says so without the key entering the pane.

The daemon SHALL resolve the target row by `identity_key` first, and when no row holds that key, by `(base_url, session_id)` — adopting the key onto the single matching row. The fallback is what lets a key reach a row at all, since the agent registers itself without one.

It SHALL probe-validate the live session (`validateKimiSession` semantics) and persist the new delivery ONLY when the requested coordinates differ from the stored ones, reporting `probed: false` on the idempotent path so a caller cannot read `state: "committed"` as proof the session is alive. It SHALL check for another row claiming the requested coordinates on EVERY call including the idempotent one, since this is the only place the one-session-one-row rule can be enforced without locking a pane out of registering.

The route SHALL NOT refresh `last_seen_at` (a launcher action is not agent activity, and the poke retry path reads that column as "the recipient was active"), SHALL NOT alter any MCP connection binding, and SHALL NOT expose or accept a `runtime_generation` — there is no reserve step and no fence, and the field's absence is the signal.

Outcomes are `{ ok: true, state: "committed", changed, probed, agent_id, name, team, base_url, session_id }`; `{ ok: true, need_register: true }` when neither lookup resolves; `session_not_found` (retryable); and `protocol_version_mismatch`, `agent_type_conflict`, `missing_auth_token`, `session_claimed_by_other_agent` (all fail closed, never retried).

#### Scenario: The first commit adopts the key onto the row the coordinates name

- **GIVEN** a registered kimi agent `k1` with delivery `{base_url: B, session_id: S1}` and no `identity_key`
- **WHEN** a loopback caller commits `{identity_key: K, base_url: B, session_id: S1}`
- **THEN** the response is `ok: true` with `changed: false` and `probed: false`
- **AND** row `k1` holds `identity_key` `K`
- **AND** no kimi session was probed

#### Scenario: A later commit moves the identity to a new session

- **GIVEN** row `k1` holds `identity_key` `K` and delivery `{base_url: B, session_id: S1}`
- **WHEN** a loopback caller commits `{identity_key: K, base_url: B, session_id: S2}`
- **THEN** the session `S2` is probed and the row's delivery becomes `{B, S2}`
- **AND** the response carries `changed: true` and `probed: true`
- **AND** `(B, S1)` no longer resolves to any row

#### Scenario: A refused probe leaves the working coordinates in place

- **GIVEN** row `k1` holds `identity_key` `K` and delivery `{base_url: B, session_id: S1}`
- **AND** the kimi server reports `S2` missing or archived
- **WHEN** a loopback caller commits `{identity_key: K, base_url: B, session_id: S2}`
- **THEN** the response is `session_not_found` and the row still delivers to `S1`

#### Scenario: Coordinates already claimed by another agent are refused

- **GIVEN** row `k1` holds `identity_key` `K`, and a different row `k2` claims `(B, S2)`
- **WHEN** a loopback caller commits `{identity_key: K, base_url: B, session_id: S2}`
- **THEN** the response is `session_claimed_by_other_agent` naming `k2`
- **AND** `k1` still holds the key and neither row's delivery changed

#### Scenario: An unknown key with unknown coordinates never creates a row

- **GIVEN** no local row holds `identity_key` `K` and none claims `(B, S1)`
- **WHEN** a loopback caller commits `{identity_key: K, base_url: B, session_id: S1}`
- **THEN** the response is `{ok: true, need_register: true, state: "unregistered"}`
- **AND** no agent row is created

#### Scenario: A commit does not make the agent look active

- **GIVEN** row `k1` holds `identity_key` `K` with a recorded `last_seen_at`
- **WHEN** a loopback caller commits new coordinates for `K`
- **THEN** `last_seen_at` is unchanged
