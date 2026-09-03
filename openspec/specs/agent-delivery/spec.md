# agent-delivery Specification

## Purpose

Define the shared delivery contract used to persist, expose, and dispatch agent wake-up transports.
## Requirements
### Requirement: DeliverySpec discriminated union defines the delivery channel contract

The system SHALL define a type `DeliverySpec` as a discriminated union on a literal `kind` field.  `DeliverySpec` is the single type used to represent an agent's poke delivery channel in memory, on the wire (MCP tool params / responses), and as the logical contract persisted in the `agents` table.

The `kind` field SHALL be one of: `'none'`, `'claude-channel'`, `'codex-appserver'`, `'opencode-server'`, `'kimi-server'`.  The full set is closed; new kinds require a new change proposal.

Kind-specific shape:

- `{ kind: 'none' }` — no payload; indicates the agent has no configured delivery channel.  Poke attempts SHALL fall back to tmux (if `tmux_pane_id` is set) or fail with `no_transport_available`.
- `{ kind: 'claude-channel'; channel_session_id: string }` — payload is a single opaque identifier produced by a `cross-agent-teams-channel` proxy's `subscribe_channel_wake` call.  `channel_session_id` MUST be a trimmed non-empty string.
- `{ kind: 'codex-appserver'; thread_id: string; ws_url: string; auth_token_ref?: string }` — payload identifies a Codex `app-server` thread and the websocket to reach it.  `thread_id` MUST be a UUID string.  `ws_url` MUST be a `ws://` or `wss://` URL.  `auth_token_ref`, when present, MUST be a non-empty string denoting a reference, not an inline secret.
- `{ kind: 'opencode-server'; session_id: string; base_url: string; auth_token_ref?: string }` — payload identifies an opencode HTTP server session and the base URL to reach it.  `session_id` MUST be a trimmed non-empty string starting with `ses`.  `base_url` MUST be an `http://` or `https://` URL.  `auth_token_ref`, when present, MUST be a non-empty string denoting a reference, not an inline secret.
- `{ kind: 'kimi-server'; session_id: string; base_url: string; auth_token_ref?: string }` — payload identifies a Kimi Code server session and the base URL to reach it.  `session_id` MUST be a trimmed non-empty string.  `base_url` MUST be an `http://` or `https://` URL.  `auth_token_ref`, when present, MUST be a non-empty string denoting a reference, not an inline secret.

#### Scenario: kind 'none' has no payload

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'none'`
- **THEN** it has no other fields

#### Scenario: kind 'claude-channel' carries channel_session_id

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'claude-channel'`
- **THEN** it has field `channel_session_id: string` and that string is trimmed non-empty

#### Scenario: kind 'codex-appserver' carries thread_id and ws_url

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'codex-appserver'`
- **THEN** it has fields `thread_id: string` (UUID), `ws_url: string` (ws:// or wss://), and optionally `auth_token_ref: string`

#### Scenario: kind 'opencode-server' carries session_id and base_url

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'opencode-server'`
- **THEN** it has fields `session_id: string` (trimmed non-empty, starting with `ses`), `base_url: string` (http:// or https://), and optionally `auth_token_ref: string`

#### Scenario: kind 'kimi-server' carries session_id and base_url

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'kimi-server'`
- **THEN** it has fields `session_id: string` (trimmed non-empty), `base_url: string` (http:// or https://), and optionally `auth_token_ref: string`

### Requirement: DeliverySpec persistence maps to two columns

The `agents` table SHALL persist `DeliverySpec` as two columns: `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT NULL`, a JSON string.  The mapping is:

- `spec.kind === 'none'` → `delivery_kind='none'`, `delivery_payload=NULL`
- `spec.kind !== 'none'` → `delivery_kind=spec.kind`, `delivery_payload=JSON.stringify(rest of spec without the kind field)`

Reading a row SHALL reconstruct `DeliverySpec` by taking `delivery_kind` as `kind`. Read-side validation is symmetric to write-side validation:

- If `kind === 'none'`, the result is `{kind: 'none'}`.
- If `kind` is not one of the supported kinds (`'none'`, `'claude-channel'`, `'codex-appserver'`, `'opencode-server'`, `'kimi-server'`), reading SHALL fail with `corrupt_delivery_payload`.
- Otherwise, `delivery_payload` SHALL be parsed as JSON. If the JSON parse fails, reading SHALL fail with `corrupt_delivery_payload`.
- For `kind === 'claude-channel'`, the parsed payload SHALL contain a non-empty string `channel_session_id`. Missing or empty fails with `corrupt_delivery_payload`.
- For `kind === 'codex-appserver'`, the parsed payload SHALL contain non-empty strings `thread_id` and `ws_url`. If `auth_token_ref` is present it SHALL be a non-empty string. Any violation fails with `corrupt_delivery_payload`.
- For `kind === 'opencode-server'`, the parsed payload SHALL contain a non-empty string `session_id` (starting with `ses`) and a non-empty string `base_url`. If `auth_token_ref` is present it SHALL be a non-empty string. Any violation fails with `corrupt_delivery_payload`.
- For `kind === 'kimi-server'`, the parsed payload SHALL contain a non-empty string `session_id` and a non-empty string `base_url`. If `auth_token_ref` is present it SHALL be a non-empty string. Any violation fails with `corrupt_delivery_payload`.

#### Scenario: Writing kind 'none' sets payload to NULL

- **GIVEN** a `DeliverySpec` `{kind: 'none'}`
- **WHEN** written to the `agents` row
- **THEN** `delivery_kind='none'` and `delivery_payload IS NULL`

#### Scenario: Writing kind 'claude-channel' serializes channel_session_id into payload

- **GIVEN** a `DeliverySpec` `{kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **WHEN** written to the `agents` row
- **THEN** `delivery_kind='claude-channel'` and `delivery_payload` is the JSON string `'{"channel_session_id":"csid-abc"}'`

#### Scenario: Reading back a kind 'claude-channel' row reconstructs the spec

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":"csid-abc"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'claude-channel', channel_session_id: 'csid-abc'}`

#### Scenario: Reading a non-'none' row with unparseable payload fails fast

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='not-json'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a row with unknown delivery_kind fails fast

- **GIVEN** an `agents` row with `delivery_kind='irc'` and any `delivery_payload`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a claude-channel row missing channel_session_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='{}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a claude-channel row with empty channel_session_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":""}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a codex-appserver row missing thread_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='codex-appserver'` and `delivery_payload='{"ws_url":"ws://127.0.0.1:8799"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a codex-appserver row missing ws_url fails fast

- **GIVEN** an `agents` row with `delivery_kind='codex-appserver'` and `delivery_payload='{"thread_id":"11111111-1111-4111-8111-111111111111"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a codex-appserver row with auth_token_ref preserves optional field

- **GIVEN** an `agents` row with `delivery_kind='codex-appserver'` and `delivery_payload='{"thread_id":"11111111-1111-4111-8111-111111111111","ws_url":"wss://example/app","auth_token_ref":"env:TOKEN"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'wss://example/app', auth_token_ref: 'env:TOKEN'}`

#### Scenario: Writing kind 'opencode-server' serializes session_id and base_url into payload

- **GIVEN** a `DeliverySpec` `{kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **WHEN** written to the `agents` row
- **THEN** `delivery_kind='opencode-server'` and `delivery_payload` is the JSON string `'{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888"}'`

#### Scenario: Reading back a kind 'opencode-server' row reconstructs the spec

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`

#### Scenario: Reading an opencode-server row preserves optional auth_token_ref

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888","auth_token_ref":"OPENCODE_SERVER_PASSWORD"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD'}`

#### Scenario: Reading an opencode-server row missing session_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"base_url":"http://127.0.0.1:18888"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading an opencode-server row with session_id not starting with 'ses' fails fast

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"abc","base_url":"http://127.0.0.1:18888"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading an opencode-server row missing base_url fails fast

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_abc"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Writing kind 'kimi-server' serializes session_id and base_url into payload

- **GIVEN** a `DeliverySpec` `{kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627'}`
- **WHEN** written to the `agents` row
- **THEN** `delivery_kind='kimi-server'` and `delivery_payload` is the JSON string `'{"session_id":"session_abc","base_url":"http://127.0.0.1:58627"}'`

#### Scenario: Reading back a kind 'kimi-server' row reconstructs the spec

- **GIVEN** an `agents` row with `delivery_kind='kimi-server'` and `delivery_payload='{"session_id":"session_abc","base_url":"http://127.0.0.1:58627"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627'}`

#### Scenario: Reading a kimi-server row preserves optional auth_token_ref

- **GIVEN** an `agents` row with `delivery_kind='kimi-server'` and `delivery_payload='{"session_id":"session_abc","base_url":"http://127.0.0.1:58627","auth_token_ref":"KIMI_SERVER_TOKEN"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627', auth_token_ref: 'KIMI_SERVER_TOKEN'}`

#### Scenario: Reading a kimi-server row missing session_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='kimi-server'` and `delivery_payload='{"base_url":"http://127.0.0.1:58627"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a kimi-server row missing base_url fails fast

- **GIVEN** an `agents` row with `delivery_kind='kimi-server'` and `delivery_payload='{"session_id":"session_abc"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

### Requirement: DeliverySpec validation rejects unknown kinds at write time

Write paths, including `register_agent`, `bind_channel`, and any future MCP tool that accepts a `delivery` field, SHALL validate `DeliverySpec` and reject any `kind` outside the supported write surface.

The write validator SHALL accept:

- `{kind: 'none'}`
- `{kind: 'claude-channel', channel_session_id: ...}`
- `{kind: 'codex-appserver', thread_id: <UUID>, ws_url: <ws:// or wss:// URL>, auth_token_ref?: <trimmed non-empty string>}`
- `{kind: 'opencode-server', session_id: <trimmed non-empty string starting with 'ses'>, base_url: <http:// or https:// URL>, auth_token_ref?: <trimmed non-empty string>}`
- `{kind: 'kimi-server', session_id: <trimmed non-empty string>, base_url: <http:// or https:// URL>, auth_token_ref?: <trimmed non-empty string>}`

The validator SHALL reject invalid inputs with `{ error: 'invalid_delivery', reason: <machine-readable reason> }`.

Supported `reason` values in this change are:

- `unknown_kind`
- `missing_channel_session_id`
- `invalid_thread_id`
- `invalid_ws_url`
- `invalid_auth_token_ref`
- `invalid_session_id`
- `invalid_base_url`

#### Scenario: Write validator accepts kind 'none'

- **WHEN** a write path receives `delivery={kind: 'none'}`
- **THEN** it returns `{ ok: { kind: 'none' } }`

#### Scenario: Write validator accepts kind 'claude-channel'

- **WHEN** a write path receives `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **THEN** it returns `{ ok: { kind: 'claude-channel', channel_session_id: 'csid-abc' } }`

#### Scenario: Write validator accepts kind 'codex-appserver'

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN'}`
- **THEN** it returns `{ ok: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN' } }`

#### Scenario: Write validator accepts kind 'opencode-server'

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD'}`
- **THEN** it returns `{ ok: { kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD' } }`

#### Scenario: Write validator accepts kind 'kimi-server'

- **WHEN** a write path receives `delivery={kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627', auth_token_ref: 'KIMI_SERVER_TOKEN'}`
- **THEN** it returns `{ ok: { kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627', auth_token_ref: 'KIMI_SERVER_TOKEN' } }`

#### Scenario: Write validator rejects unknown kind

- **WHEN** a write path receives `delivery={kind: 'irc'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'unknown_kind'}`

#### Scenario: Write validator rejects kind 'claude-channel' missing channel_session_id

- **WHEN** a write path receives `delivery={kind: 'claude-channel'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'missing_channel_session_id'}`

#### Scenario: Write validator rejects kind 'codex-appserver' with invalid thread_id

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: 'not-a-uuid', ws_url: 'ws://127.0.0.1:8799'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_thread_id'}`

#### Scenario: Write validator rejects kind 'codex-appserver' with invalid ws_url

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'http://127.0.0.1:8799'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_ws_url'}`

#### Scenario: Write validator rejects kind 'codex-appserver' with blank auth_token_ref

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: '   '}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_auth_token_ref'}`

#### Scenario: Write validator rejects kind 'opencode-server' with invalid session_id (not starting 'ses')

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'abc', base_url: 'http://127.0.0.1:18888'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_session_id'}`

#### Scenario: Write validator rejects kind 'opencode-server' with empty session_id

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: '', base_url: 'http://127.0.0.1:18888'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_session_id'}`

#### Scenario: Write validator rejects kind 'opencode-server' with invalid base_url

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'not-a-url'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_base_url'}`

#### Scenario: Write validator rejects kind 'opencode-server' with ws:// base_url

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'ws://127.0.0.1:18888'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_base_url'}`

#### Scenario: Write validator rejects kind 'opencode-server' with blank auth_token_ref

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: '   '}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_auth_token_ref'}`

#### Scenario: Write validator rejects kind 'kimi-server' with empty session_id

- **WHEN** a write path receives `delivery={kind: 'kimi-server', session_id: '', base_url: 'http://127.0.0.1:58627'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_session_id'}`

#### Scenario: Write validator rejects kind 'kimi-server' with invalid base_url

- **WHEN** a write path receives `delivery={kind: 'kimi-server', session_id: 'session_abc', base_url: 'ws://127.0.0.1:58627'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_base_url'}`

#### Scenario: Write validator rejects kind 'kimi-server' with blank auth_token_ref

- **WHEN** a write path receives `delivery={kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627', auth_token_ref: '   '}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_auth_token_ref'}`

### Requirement: Poke dispatch routes by delivery.kind

The daemon's poke dispatcher SHALL select the backend transport based on the target agent's `delivery.kind` value, with the following routing:

- `kind === 'claude-channel'` → deliver via `ChannelWakeFanout` using `delivery.channel_session_id`, per `claude-channel-transport` spec; if no subscribed sink exists and `tmux_pane_id` is set, it MAY fall back to tmux injection, subject to "Tmux injection verifies the pane's current host".
- `kind === 'none'` → fall back to tmux injection if `tmux_pane_id` is set, subject to "Tmux injection verifies the pane's current host"; otherwise fail with `no_transport_available`.
- `kind === 'codex-appserver'` → deliver via the Codex websocket dispatcher defined in `codex-appserver-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.
- `kind === 'opencode-server'` → deliver via the opencode HTTP dispatcher defined in `opencode-server-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.
- `kind === 'kimi-server'` → deliver via the kimi HTTP dispatcher defined in `kimi-server-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.

Every tmux fallback reachable from any route, including the legacy tmux-only path taken when no `ChannelWakeFanout` is supplied, SHALL pass host verification first.

#### Scenario: Route kind 'claude-channel' to ChannelWakeFanout

- **GIVEN** target agent has `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` and a sink attached under `csid-abc`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the sink is invoked exactly once with the poke payload

#### Scenario: Unsubscribed channel falls back to tmux only when the pane verifies

- **GIVEN** target agent has `delivery={kind: 'claude-channel', channel_session_id: 'csid-dead'}` with no attached sink and `tmux_pane_id='%19'`
- **WHEN** the daemon dispatches a poke and `%19` passes host verification
- **THEN** the poke is injected into `%19`
- **AND** when `%19` instead fails host verification, nothing is injected and the reason is `pane_reassigned`

#### Scenario: Route kind 'none' to tmux when pane is set

- **GIVEN** target agent has `delivery={kind: 'none'}` and `tmux_pane_id='%42'` that passes host verification
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the poke is injected via tmux to pane `%42`

#### Scenario: Route kind 'none' with no tmux returns no_transport_available

- **GIVEN** target agent has `delivery={kind: 'none'}` and `tmux_pane_id IS NULL`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the dispatcher returns `{error: 'no_transport_available'}`

#### Scenario: Route kind 'codex-appserver' to Codex dispatcher

- **GIVEN** target agent has `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the Codex dispatcher with that `thread_id` and `ws_url`

#### Scenario: Codex dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}`
- **AND** the Codex dispatcher fails with `{ error: 'codex_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'codex_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically

#### Scenario: Route kind 'opencode-server' to opencode dispatcher

- **GIVEN** target agent has `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the opencode dispatcher with that `session_id` and `base_url`

#### Scenario: opencode dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **AND** the opencode dispatcher fails with `{ error: 'opencode_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'opencode_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically

#### Scenario: Route kind 'kimi-server' to kimi dispatcher

- **GIVEN** target agent has `delivery={kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the kimi dispatcher with that `session_id` and `base_url`

#### Scenario: kimi dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627'}`
- **AND** the kimi dispatcher fails with `{ error: 'kimi_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'kimi_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically

### Requirement: Legacy channel_session_id access derives from delivery

While the legacy `channel_session_id` column remains on the `agents` table for backward compatibility, the daemon SHALL treat it as a read-only derived value when exposed through `AgentsRepo` and `list_agents`.  The derivation rule is:

- If `delivery.kind === 'claude-channel'`, the derived `channel_session_id` equals `delivery.channel_session_id`.
- Otherwise the derived `channel_session_id` is `null`.

No write path in this change SHALL `UPDATE agents.channel_session_id = ...`; all writes go through the `delivery_kind` / `delivery_payload` pair.

#### Scenario: derived channel_session_id for claude-channel delivery

- **GIVEN** an agent with `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **WHEN** reading the derived `channel_session_id`, via `AgentsRepo` or `list_agents`
- **THEN** the value is `'csid-abc'`

#### Scenario: derived channel_session_id is null for other kinds

- **GIVEN** an agent with `delivery={kind: 'none'}` or `delivery={kind: 'codex-appserver', ...}`
- **WHEN** reading the derived `channel_session_id`
- **THEN** the value is `null`

### Requirement: Tmux injection verifies the pane's current host

Before injecting into a tmux pane on behalf of a target agent row, the daemon SHALL verify that the pane is still hosted by that agent.  The verification SHALL run at the single point where every route converges on tmux injection, so that it applies uniformly to the `poke` tool, to `send_message` / `broadcast` / `broadcast_to_role` auto-poke, to retry ticks, and to every transport's tmux fallback.

The target row is read before dispatch reaches this point, so the pane may have changed hands in between.  The daemon SHALL therefore re-read current ownership from the database and reject when the row no longer holds that `(device, tmux_pane_id)`, rather than trusting the row it was handed.  This makes "Pane binding is exclusive per device with last-writer-wins" an enforced precondition of injection instead of a steady-state argument.

This ownership read SHALL be repeated immediately before the first tmux write, after the quiet-guard has run.  A single check at dispatch entry is not sufficient: the predicate awaits process/tty lookups and the quiet-guard parks for `POKE_QUIET_MS` (2 seconds by default), which is ample time for a takeover to land.  The final read SHALL be synchronous and SHALL have no `await` between it and the write it guards, so no takeover can be interleaved after it.  The residual window is then the write syscall itself, which cannot be closed without holding a lock across tmux; this is accepted and is orders of magnitude smaller than the guard window it replaces.

The predicate then resolves in order, first match wins:

1. **Target row's `device` is not the local device** → NOT verified.  A remote row's `tmux_pane_id` numbers a pane on that host and is meaningless against the local tmux server.
2. **`runtime_ui_pid` is set and that process does not exist** → NOT verified.
3. **`runtime_ui_pid` is set and that process exists** → verified iff the pid's controlling tty equals the pane's `#{pane_tty}`, or the pid equals the pane's `#{pane_pid}`.  A live process is not proof it still occupies this pane.
4. **`runtime_ui_pid` is `NULL`** → verified iff the pane exists in the current tmux pane set AND no other agent row claims the same `(device, tmux_pane_id)` while itself passing rule 2 or 3.  Agent types that legitimately carry no pid (codex, opencode) MUST NOT be rejected outright, but a row loses to a peer whose live host on that pane has been positively confirmed.

When the predicate does not verify, the daemon SHALL NOT inject, and SHALL report the skip reason `pane_reassigned`.  The mailbox row for the target SHALL still be written — verification governs the physical wake-up only, never message persistence.

When `tmux` is unavailable, rules 3 and 4 cannot be evaluated.  Unknown ownership SHALL NOT be treated as verified: the daemon SHALL NOT inject, and SHALL report the existing `tmux_unavailable` reason rather than `pane_reassigned`.  A snapshot query can fail transiently while the subsequent paste would still have reached a pane, so failing open here would inject on exactly the state the predicate exists to rule out.

The daemon MAY take a single tmux pane snapshot per fan-out round and evaluate every recipient against it, rather than querying tmux once per recipient.

#### Scenario: Dead host pid skips injection

- **GIVEN** target agent A on the local device with `tmux_pane_id='%19'` and `runtime_ui_pid` naming a process that no longer exists
- **AND** pane `%19` exists and is currently occupied by a different agent B
- **WHEN** the daemon dispatches a poke to A
- **THEN** nothing is injected into `%19`
- **AND** the skip reason for A is `pane_reassigned`
- **AND** B's pane tail is unchanged

#### Scenario: Live host on the matching pane is injected normally

- **GIVEN** target agent A on the local device with `tmux_pane_id='%19'` and `runtime_ui_pid` naming a running process whose controlling tty is pane `%19`'s tty
- **WHEN** the daemon dispatches a poke to A
- **THEN** the poke is injected into `%19` exactly as before this change

#### Scenario: Live pid sitting on a different pane skips injection

- **GIVEN** target agent A with `tmux_pane_id='%19'` and `runtime_ui_pid` naming a running process whose controlling tty belongs to pane `%31`
- **WHEN** the daemon dispatches a poke to A
- **THEN** neither `%19` nor `%31` is injected
- **AND** the skip reason for A is `pane_reassigned`

#### Scenario: Remote-device row never injects locally

- **GIVEN** target agent A whose `device` is `gx` (not the local device) and whose row carries `tmux_pane_id='%9'`
- **AND** pane `%9` exists on the local tmux server
- **WHEN** the daemon dispatches a poke to A
- **THEN** `%9` is not injected
- **AND** the skip reason for A is `pane_reassigned`

#### Scenario: Pid-less row loses to a confirmed live host on the same pane

- **GIVEN** target agent A with `tmux_pane_id='%7'` and `runtime_ui_pid IS NULL`
- **AND** another row B with the same `device` and `tmux_pane_id='%7'` whose `runtime_ui_pid` is alive on `%7`'s tty
- **WHEN** the daemon dispatches a poke to A
- **THEN** `%7` is not injected
- **AND** the skip reason for A is `pane_reassigned`

#### Scenario: Pid-less row on an uncontested live pane still injects

- **GIVEN** target agent A with `tmux_pane_id='%23'` and `runtime_ui_pid IS NULL`
- **AND** no other row claims `%23` on the same device
- **AND** pane `%23` exists
- **WHEN** the daemon dispatches a poke to A
- **THEN** the poke is injected into `%23`

#### Scenario: An unqueryable tmux performs zero writes

- **GIVEN** the tmux pane snapshot cannot be obtained
- **WHEN** the daemon dispatches a poke to a target with `tmux_pane_id` set
- **THEN** no tmux write of any kind is issued — not the quiet-guard capture, not the paste
- **AND** the reported reason is `tmux_unavailable`, not `pane_reassigned` and not a success

#### Scenario: A takeover that lands during the quiet-guard still blocks the write

- **GIVEN** a target that passes host verification at dispatch entry
- **AND** another agent binds the same pane while the quiet-guard is parked
- **WHEN** the guard completes and the poke is about to write
- **THEN** the pre-write ownership read observes the takeover
- **AND** no tmux write occurs and the reason is `pane_reassigned`

#### Scenario: Every tmux route reports the same reason for the same state

- **GIVEN** a target whose pane cannot be verified because tmux is unqueryable
- **WHEN** the poke arrives through the fan-out dispatcher, through a transport's tmux fallback, or through the legacy path taken when no `ChannelWakeFanout` is supplied
- **THEN** all three report `tmux_unavailable`
- **AND** none of them surfaces an internal verdict value in its place

#### Scenario: A pane that changed hands after the target row was read

- **GIVEN** target agent A's row was read while it held `tmux_pane_id='%19'`
- **AND** agent B subsequently binds `%19`, which clears A's binding per last-writer-wins
- **WHEN** the daemon dispatches the already-in-flight poke to A
- **THEN** the current binding is re-read, A is found to no longer hold `%19`
- **AND** nothing is injected and the skip reason is `pane_reassigned`

#### Scenario: Mailbox row is written even when injection is skipped

- **GIVEN** target agent A whose pane fails verification
- **WHEN** a sender calls `send_message` to A with default `auto_poke`
- **THEN** the message is persisted to A's mailbox with the full body
- **AND** the response reports `poked: false` with reason `pane_reassigned`
- **AND** A reads the message on its next `get_inbox` after it comes back online

#### Scenario: Verification covers direct send_message, not only broadcast

- **GIVEN** target agent A whose pane fails verification
- **WHEN** a sender calls `send_message_by_id({to_agent_id: A, ...})`
- **THEN** no injection occurs and the reason is `pane_reassigned`
- **AND** the same holds when the poke originates from `broadcast`, `broadcast_to_role`, a retry tick, or a direct `poke` tool call

### Requirement: Recovery poke is scheduled when an identity-key pre-registration hits a known identity

When a `pre_register_codex_pane` call carrying an `identity_key` is accepted, the daemon SHALL immediately look up the key via the existing device-scoped `findByIdentityKey`.  On a hit whose holder row's runtime process is dead (or unknown), the daemon SHALL schedule a recovery poke for that pane.  On a miss, or when the holder row's `runtime_ui_pid` process is still alive, the daemon SHALL NOT schedule a recovery poke (the alive case is logged at debug level).  Pre-registrations without `identity_key` SHALL never trigger recovery-poke scheduling.

#### Scenario: Known identity with dead holder schedules a poke
- **GIVEN** agent row `aoe-codex(aoe)` holds `identity_key="K1"` and its
  `runtime_ui_pid` process is no longer running
- **WHEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1"})` is accepted
- **THEN** the daemon schedules a recovery poke for pane `%1972` on behalf of `aoe-codex(aoe)`

#### Scenario: Unknown key schedules nothing
- **WHEN** a pre-reg arrives with `identity_key="K9"` matching no agent row
- **THEN** no recovery poke is scheduled
- **AND** the pre-reg row is stored normally for later auto-bind key attach

#### Scenario: Live holder skips scheduling
- **GIVEN** agent row `aoe-codex(aoe)` holds `identity_key="K1"` and its runtime process is alive
- **WHEN** a pre-reg arrives for another pane with `identity_key="K1"`
- **THEN** no recovery poke is scheduled
- **AND** the skip is logged at debug level

### Requirement: Recovery poke first send is gated on codex process detection

The scheduled recovery poke MUST NOT be sent while the pre-registered pane may still be running a shell.  The daemon SHALL poll (bounded interval) the pane's tty using the same probing primitives as codex auto-bind (`tmux list-panes`, `ps -t <tty>`, codex `--remote` process recognition, argv containing `xats.agent_id="<stored uuid>"`), and SHALL send the first poke only after a matching codex process is detected; a candidate line whose STAT contains `T`, `t`, or `Z` (stopped, traced, or zombie) SHALL NOT count as a detection — the shell owns the tty again — and the auto-bind candidate filter that shares these primitives SHALL apply the full foreground-carrier acceptance (STAT, command with stored uuid, and `pgid == tpgid`; see the agent-registry auto-bind requirement).  A wrapper-launched codex produces MULTIPLE matching lines on one tty (for example a `node .../bin/codex --remote` process-group leader plus its native child); detection SHALL collapse same-process-group matches exactly like auto-bind: all matches sharing one pgid whose group is the tty's foreground group (`pgid == tpgid` on every matching line) count as ONE detection whose pid is the group leader (`pid == pgid`) — wrapper plus child is one candidate, leader pid wins.  A same-group set without a leader line detects nothing (fail-closed), and matches spanning DIFFERENT pgids remain ambiguous and detect nothing; a non-collapsing multi-line outcome SHALL be logged at debug level once per schedule generation per reason with the pane id, matching-line count, and distinct-pgid count — never argv contents, never the key value.  The write-time carrier proof evaluates the chosen (leader) pid's own ps line, which MAY be the wrapper form (`node ... codex --remote ...`); sibling group members on the same tty do not affect the per-pid classification.  A probe infrastructure exception (pane listing or tty process listing) SHALL be logged at debug level once per stage per schedule — naming the pane, the stage, and the error class, with the identity key value redacted from the message — so a broken probe is distinguishable from ordinary not-yet-detected polling; the key value SHALL never appear in any log line.  Each poll iteration SHALL first check row currency (full-snapshot, see the lifecycle requirement) and SHALL re-resolve the holder via `findByIdentityKey`, requiring the same `agent_id`, `team`, and `name` as at schedule time and a still-dead holder process (holder-side liveness keeps the conservative `process.kill(pid, 0)` semantics, EPERM reads as alive); on a miss, any change, or a holder back alive, the schedule SHALL be cancelled with a debug log that never contains the key value.  Every send attempt SHALL run the quiet guard FIRST; only after the guard passes SHALL the daemon re-probe the codex process (a vanished process or a changed pid cancels the send without pasting), re-check row currency, re-resolve the holder, and run pane-host verification.  The paste SHALL additionally carry the prompt-readiness predicate defined by the codex-targeted injection requirement, so that a pane which is quiet for a reason other than an idle codex composer — a blocking startup menu being the observed case — is refused before anything is written.  The paste SHALL go through the shared tmux poke primitive carrying a composite synchronous confirm predicate — schedule generation not cancelled, row snapshot still current, holder tuple unchanged and still dead, and a TARGET-side foreground-carrier proof — which the primitive SHALL evaluate synchronously before anything is written (pre-capture), immediately before the paste, AND once more immediately before the Enter keypress: a failure before the paste aborts with nothing written, and a failure between paste and Enter aborts with a distinct `ownership_lost` error, leaving the pasted text unexecuted (pasted-but-unexecuted is acceptable; executing it is not).  The foreground-carrier proof SHALL demand positive evidence via a synchronous, bounded-timeout `ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=` probe: the detected codex pid present on the pane's tty with a STAT containing none of `T`/`t`/`Z`, its current command line still matching codex `--remote` with the stored `xats.agent_id="<uuid>"` (guarding against PID reuse), and its process group equal to the tty's foreground process group (`pgid == tpgid`).  Pid liveness alone (`process.kill(pid, 0)`) SHALL NOT satisfy the target-side predicate: a SIGSTOP-ed codex keeps the pid alive while the shell is foreground.  ANY probe error, timeout, EPERM, missing column, or otherwise unknown state SHALL read as not-safe: no paste, no Enter.  The poke content SHALL be built from the freshly resolved holder at send time.  Transient refusals SHALL NOT retire the schedule generation and SHALL NOT enter any long-backoff retry ladder.  Three refusals are transient: a quiet-guard failure on a send attempt (the common case right after a codex restart, while the TUI is still drawing its boot screen), a write-checkpoint refusal with nothing yet written whose ONLY failing leg is the foreground-carrier proof observing a live-but-backgrounded codex (present on the tty, STAT free of `T`/`t`/`Z`, command still matching with the stored uuid, but `pgid != tpgid`), and a prompt-readiness refusal, which is reported under its own reason and MUST NOT be folded into the quiet-guard one.  Any of these refusals returns the pane's schedule to the detection polling loop with the SAME generation token (no new generation, exactly one live schedule entry per pane, so overwrite/consumption cancellation still targets it); every subsequent poll iteration repeats the FULL detect, guard, re-probe, re-verify, paste sequence, so the retry cadence is the probe interval, bounded by the pre-reg row lifecycle — polling continues until the row expires, is overwritten, or is consumed.  A refusal observed by a cancelled or superseded generation resumes nothing and MUST NOT touch a newer generation's schedule.  Recovery lifecycle logging SHALL carry an ISO timestamp on every line: scheduling (with the holder identity), the first detection of a codex pid (once per distinct pid per generation), each transient-resume transition (at most once per consecutive streak of one reason — the streak marker resets when that stage passes again, so a relapse logs anew), delivery, and terminal cancellations with their reason; no line ever contains the key value or argv contents.  All other send outcomes remain terminal for the generation as before: delivered, `ownership_lost` after the paste (even on a carrier refusal), a vanished or restarted codex process, a stale row, holder drift, a probe hard error, and cancellation.

#### Scenario: No poke while the pane still runs a shell
- **GIVEN** a scheduled recovery poke for pane `%1972`
- **AND** the pane's tty shows no codex `--remote` process with the stored uuid on argv
- **WHEN** the poll interval elapses repeatedly
- **THEN** no paste reaches pane `%1972`

#### Scenario: Detection unlocks the first send
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **WHEN** a codex `--remote` process whose argv contains `xats.agent_id="U1"` appears on the pane's tty
- **THEN** the daemon runs the quiet guard, then re-probes the process, re-checks the row and holder, verifies the pane host, and pastes the recovery poke
- **AND** a quiet-guard failure returns the schedule to the polling loop instead of entering any retry ladder

#### Scenario: A wrapper+child pair detects the leader and delivers
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **AND** the pane's tty lists `39074 39074 39074 Ss+ node .../bin/codex --remote ... xats.agent_id="U1"` and `41846 39074 39074 S+ .../bin/codex --remote ... xats.agent_id="U1"` (both foreground, one process group), in either line order
- **WHEN** a poll iteration runs
- **THEN** detection collapses the pair to pid `39074` (the group leader)
- **AND** the send path verifies pane `%1972` against pid `39074` and pastes, with the write-time carrier proof accepting the wrapper-form leader line

#### Scenario: Matches in different process groups detect nothing
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **AND** the pane's tty lists two `codex --remote` processes carrying `xats.agent_id="U1"` in DIFFERENT process groups
- **WHEN** poll iterations run repeatedly
- **THEN** no detection occurs and nothing is pasted into `%1972`
- **AND** exactly one debug line per schedule generation names the pane, the matching-line count, and the distinct-pgid count (never argv contents or the key value)

#### Scenario: A leaderless same-group set is never a detection
- **GIVEN** the pane's tty lists two matching lines sharing one foreground pgid, neither of which has `pid == pgid`
- **WHEN** poll iterations run
- **THEN** detection fails closed and nothing is pasted

#### Scenario: Codex exit during the quiet guard cancels the send
- **GIVEN** a detected codex process for pane `%1972` and a passing quiet guard
- **WHEN** the codex process exits (or restarts under a new pid) before the post-guard re-probe
- **THEN** nothing is pasted into `%1972`
- **AND** the cancellation is logged without the key value

#### Scenario: Codex exit after the post-guard re-probe blocks the paste
- **GIVEN** a send attempt whose post-guard re-probe and pane-host verification passed
- **WHEN** the codex process exits before the primitive's pre-paste confirm runs
- **THEN** the composite confirm returns false and nothing is pasted into the pane

#### Scenario: Codex exit between paste and Enter aborts execution
- **GIVEN** a recovery poke whose content was already pasted into pane `%1972`
- **WHEN** the detected codex process exits during the paste settle window, before Enter is sent
- **THEN** the Enter keypress is not sent and the attempt reports `ownership_lost`
- **AND** the pasted-but-unexecuted text is never executed by the daemon

#### Scenario: A stopped codex with a foreground shell never receives a send
- **GIVEN** a scheduled recovery poke for pane `%1972` with stored uuid `U1`
- **AND** the pane's tty lists `91131 1 T codex --remote ... xats.agent_id="U1"` and `555 1 S+ -zsh`
- **WHEN** poll iterations and any send attempt run
- **THEN** nothing is ever pasted into `%1972` (the stopped codex is not a detection, and the write-time carrier proof rejects it)

#### Scenario: A zombie codex process blocks the send
- **GIVEN** a send attempt whose foreground probe shows the detected pid with a STAT containing `Z`
- **WHEN** any of the primitive's synchronous confirms runs
- **THEN** the confirm fails and neither paste nor Enter is issued

#### Scenario: PID reuse is caught by the command-line re-check
- **GIVEN** a send attempt whose detected pid now maps to a different command line (no codex `--remote`, or a different `xats.agent_id`)
- **WHEN** any of the primitive's synchronous confirms runs
- **THEN** the confirm fails and neither paste nor Enter is issued

#### Scenario: A foreground-probe error blocks the send
- **GIVEN** a send attempt whose synchronous `ps` probe fails (error, timeout, or EPERM)
- **WHEN** any of the primitive's synchronous confirms runs
- **THEN** the unknown state reads as not-safe and neither paste nor Enter is issued

#### Scenario: Probe infrastructure errors are logged once and redacted
- **GIVEN** a scheduled recovery poke whose tty process listing keeps throwing an error message embedding the identity key value
- **WHEN** poll iterations continue
- **THEN** exactly one debug line for that stage is logged naming the pane, the stage, and the error class
- **AND** the identity key value is replaced by `[redacted]` and never appears in any log line

#### Scenario: Holder drift before send cancels the schedule
- **GIVEN** a scheduled recovery poke for pane `%1972` resolved to holder `aoe-codex(aoe)`
- **WHEN** before the send `identity_key="K1"` no longer resolves to the same agent row (moved, deleted, or renamed) or the holder process is alive again
- **THEN** the schedule is cancelled and no poke is sent
- **AND** the skip is logged without the key value

#### Scenario: A backgrounded codex at send time returns the schedule to polling
- **GIVEN** a send attempt for pane `%1972` whose write-time carrier proof refuses at a pre-write checkpoint because the detected codex is live on the tty but not the foreground group (`pgid != tpgid`)
- **AND** the pre-reg row is still current and the holder still resolves unchanged and dead
- **WHEN** the refusal aborts with nothing written
- **THEN** the schedule generation is not retired: the pane re-enters the polling loop with the same generation
- **AND** polling keeps retrying on the normal interval until the row expires, is overwritten, or is consumed

#### Scenario: Foregrounding within the TTL delivers on a later iteration
- **GIVEN** a recovery schedule returned to polling by a backgrounded-codex refusal
- **WHEN** the codex process becomes the tty's foreground group again before row expiry
- **THEN** a later poll iteration delivers the recovery poke exactly once

#### Scenario: Expiry while still backgrounded retires the schedule
- **GIVEN** a recovery schedule returned to polling by a backgrounded-codex refusal
- **WHEN** the pre-reg row expires before the codex returns to the foreground
- **THEN** polling stops, the generation is retired, and no poke is sent

#### Scenario: A quiet-guard failure resumes polling and delivers on the next iteration
- **GIVEN** a recovery poke for pane `%1972` whose first send fails the quiet guard because the codex TUI is still drawing its boot screen
- **WHEN** the refusal aborts with nothing written
- **THEN** the schedule returns to the detection polling loop with the same generation
- **AND** the next poll iteration (one probe interval later, not a 30s ladder rung) repeats the full guard, re-probe, re-verify, paste sequence and delivers exactly once when the pane is quiet

#### Scenario: Repeated guard failures poll until row expiry
- **GIVEN** a recovery schedule whose quiet guard keeps failing on every iteration
- **WHEN** the pre-reg row expires before the guard ever passes
- **THEN** polling stops, the generation is retired, and no poke is sent

#### Scenario: A transient refusal on a superseded generation resumes nothing
- **GIVEN** an old-generation send attempt whose quiet guard failed or whose carrier proof observed a backgrounded codex
- **WHEN** an overwriting pre-register retires that generation before the refusal unwinds
- **THEN** the old generation resumes no polling and pastes nothing
- **AND** the new generation's schedule survives untouched

#### Scenario: Polling-resumed attempts repeat the full send sequence
- **GIVEN** a recovery schedule returned to polling by a transient refusal
- **WHEN** a later poll iteration fires
- **THEN** the attempt runs detection, guard, codex process re-probe, row currency re-check, holder re-resolution, and pane-host verification before pasting
- **AND** a stale row, missing process, or drifted holder retires the generation instead of pasting

#### Scenario: Expiry terminates polling
- **GIVEN** a scheduled recovery poke whose pre-reg row has `expires_at` in the past
- **WHEN** the next poll iteration runs
- **THEN** polling stops and no poke is sent

#### Scenario: A blocking startup menu never receives the recovery Enter

- **GIVEN** a scheduled recovery poke for pane `%9` whose codex process is detected
- **AND** the pane is displaying a blocking startup menu whose default action would terminate codex
- **WHEN** the send attempt runs and the quiet guard passes on the motionless menu
- **THEN** the prompt-readiness predicate refuses and nothing is pasted into `%9`
- **AND** the schedule returns to the detection polling loop with the same generation token

#### Scenario: A prompt-readiness refusal is logged apart from a quiet-guard failure

- **GIVEN** a recovery schedule whose send attempts are refused by the prompt-readiness predicate on every poll iteration
- **WHEN** the refusals repeat
- **THEN** the resume transition is logged under a reason naming the readiness refusal, never as a quiet-guard failure
- **AND** the streak logs at most once, resetting when the predicate passes again

### Requirement: Codex tmux fallback demands the foreground-carrier proof at every write checkpoint

When a poke to a target whose EFFECTIVE agent type resolves to codex falls back to tmux injection and the target row has a bound `runtime_ui_pid`, the pre-write ownership confirm that the shared tmux poke primitive evaluates at ALL THREE write checkpoints (pre-capture, immediately before the paste, and immediately before the Enter keypress) SHALL — in addition to the DB ownership read — require the TARGET-side foreground-carrier proof for that `runtime_ui_pid` on the pane's tty: the pane tty resolved synchronously, then a synchronous bounded-timeout `ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=` probe showing the pid with a STAT containing none of `T`/`t`/`Z`, a current command still matching codex `--remote` (the stored pre-reg uuid is not available on this path; the command-level match suffices), and `pgid == tpgid`.  ANY probe error, timeout, or unresolvable pane tty SHALL read as not-safe: nothing is captured, pasted, or executed.  The effective agent type SHALL be resolved with the SAME semantics the transport dispatcher routes by: the stored `agent_type` when present, otherwise inferred from the delivery kind (`codex-appserver` implies codex) — so legacy rows with `agent_type=NULL` and a codex-appserver delivery are covered and cannot bypass the proof on their tmux fallback.  Targets whose effective type resolves to codex but without a bound `runtime_ui_pid`, and targets whose effective type is not codex, SHALL keep the existing DB-only confirm behavior (the analogous hazard for claude/other TUI targets is a known follow-up, out of scope for this change).

#### Scenario: A backgrounded codex with a foreground shell never receives a wake
- **GIVEN** a codex agent row bound to pane `%10` with `runtime_ui_pid=12345`
- **AND** the pane's tty lists `12345 12345 555 S codex --remote ...` and `555 555 555 S+ -zsh`
- **WHEN** an ordinary poke to that agent falls back to tmux injection
- **THEN** the wake is not pasted and no Enter is sent

#### Scenario: A codex backgrounded during the paste settle window loses the Enter
- **GIVEN** a codex tmux fallback whose pre-capture and pre-paste confirms passed
- **WHEN** the codex process is backgrounded (the shell takes the tty's foreground group) before the pre-Enter confirm
- **THEN** the Enter keypress is not sent and the attempt reports `ownership_lost`
- **AND** the pasted-but-unexecuted text is never executed by the daemon

#### Scenario: A foreground codex passes all three checkpoints
- **GIVEN** a codex agent row bound to a pane whose `runtime_ui_pid` is the pane tty's foreground `codex --remote` process
- **WHEN** an ordinary poke falls back to tmux injection
- **THEN** the carrier probe is evaluated at each of the three checkpoints
- **AND** the wake is pasted and executed normally

#### Scenario: A legacy NULL agent_type row with a codex-appserver delivery still demands the proof
- **GIVEN** a legacy agent row with `agent_type=NULL`, a `codex-appserver` delivery, a bound pane and `runtime_ui_pid=12345`
- **AND** the pane's tty lists the codex backgrounded (`12345 12345 555 S codex --remote ...`) with a foreground shell
- **WHEN** the app-server dispatch fails with an ordinary error and the poke falls back to tmux injection
- **THEN** the effective agent type resolves to codex and the carrier proof is required
- **AND** the wake is neither pasted nor executed

#### Scenario: A carrier-probe failure blocks the write
- **GIVEN** a codex tmux fallback whose synchronous tty resolution or ps probe fails (error, timeout, or missing tty)
- **WHEN** any of the primitive's confirms runs
- **THEN** the unknown state reads as not-safe and neither paste nor Enter is issued

#### Scenario: Non-codex targets keep the DB-only confirm
- **GIVEN** a claude-code agent row bound to a pane
- **WHEN** a poke falls back to tmux injection
- **THEN** the write checkpoints run the existing DB ownership confirm without consulting any carrier probe

### Requirement: Recovery poke wording guides re-registration with the recovered identity

The recovery poke content SHALL be a daemon-side fixed template that identifies itself as a cross-agent-teams recovery notice, states the recovered `(team, name)`, and instructs the codex agent to call `register_agent` with `agent_type="codex"`, that `name` and `team`, and `thread_id` read from `$CODEX_THREAD_ID`.  The template MUST NOT contain the `identity_key` value.

#### Scenario: Wording carries identity but never the key
- **GIVEN** a recovery poke on behalf of `aoe-codex(aoe)` triggered by `identity_key="K1"`
- **WHEN** the poke content is composed
- **THEN** it names `aoe-codex` and team `aoe` and instructs a `register_agent` call with `thread_id` from `$CODEX_THREAD_ID`
- **AND** the string `K1` does not appear in the content

### Requirement: Recovery poke scheduling follows the pre-reg row lifecycle

Recovery-poke schedules SHALL be keyed by `pane_id` and cancelled when their pre-reg row leaves the pending state: consumption by auto-bind (the codex agent registered, poked or not) cancels the schedule; an overwriting `pre_register_codex_pane` call for the same pane cancels the old schedule and re-evaluates scheduling from the new row; expiry terminates polling.  Row currency SHALL be judged on the full row snapshot — `xats_agent_id`, `identity_key`, and `expires_at` equality — so a same-value overwrite with a refreshed expiry counts as a new generation and terminates the old one.  Each schedule generation SHALL carry a unique generation token (`codex-recovery:<pane_id>:<generation>`, never reused).  Cancellation SHALL be combined and generation-scoped: consumption, overwrite, and shutdown remove the pending probe schedule and retire exactly the CURRENT generation's token — an in-flight send observes the retirement at its next cancellation checkpoint (every await boundary re-checks it) and neither pastes nor resumes polling — while a superseded (stale) schedule or send MAY only retire its own generation and MUST NOT delete, mutate, or resume a newer generation's schedule.  On daemon shutdown, all recovery schedules SHALL be cancelled before the database closes, and an in-flight send SHALL abort at its next cancellation checkpoint.  Schedules are in-memory: they do not survive a daemon restart, and this is accepted (window bounded by the pre-reg TTL).

#### Scenario: Self-registration cancels the pending poke
- **GIVEN** a scheduled recovery poke for pane `%1972` not yet sent
- **WHEN** the codex agent in that pane registers successfully and auto-bind consumes the pre-reg row
- **THEN** the schedule for `%1972` is cancelled and no recovery poke is ever sent to `%1972`

#### Scenario: Overwrite re-evaluates scheduling
- **GIVEN** a scheduled recovery poke for pane `%1972` based on `identity_key="K1"`
- **WHEN** a new `pre_register_codex_pane` call for `%1972` arrives without `identity_key`
- **THEN** the `K1` schedule is cancelled
- **AND** no new schedule is created for the key-less row

#### Scenario: Same-value overwrite with a fresh expiry is a new generation
- **GIVEN** a scheduled recovery poke for pane `%1972` with `xats_agent_id="U1"` and `identity_key="K1"`
- **WHEN** a new `pre_register_codex_pane` call for `%1972` arrives with the identical `U1`/`K1` but a refreshed `expires_at`
- **THEN** the old schedule is cancelled
- **AND** a fresh schedule is created from the new row
- **AND** the pane never receives a double send from both generations

#### Scenario: A stale suspended send cannot act on the new generation
- **GIVEN** an old-generation send for pane `%1972` suspended inside its quiet guard
- **AND** an overwriting pre-register that created a new-generation schedule for the same pane
- **WHEN** the old send resumes
- **THEN** it performs no paste and resumes no polling
- **AND** the new generation's schedule survives untouched

#### Scenario: Daemon shutdown cancels schedules and in-flight sends
- **GIVEN** a pending recovery probe timer and an in-flight recovery send for pane `%1972`
- **WHEN** the daemon shuts down
- **THEN** the probe timer and the pane's generation token are cancelled before the database closes
- **AND** the in-flight send aborts at its next checkpoint without pasting

### Requirement: Codex-targeted tmux injection demands positive evidence of an idle composer

A tmux injection aimed at a codex pane SHALL NOT be written unless the pane presents positive evidence that it is sitting at an idle codex composer.  The quiet guard is not that evidence: it establishes only that the pane tail did not change across `POKE_QUIET_MS`, and a blocking TUI menu awaiting a keypress is quieter than a live prompt.  Because the injection ends in an unconditional `Enter`, a pane that is quiet for any other reason receives that keypress as an answer to whatever it is actually asking.

The predicate SHALL be an allowlist over the pane's rendered tail — it recognises the codex composer — and SHALL NOT be a denylist of known-dangerous screens.  A denylist is bound to the wording of the specific screens enumerated and leaves every other blocking prompt (a package-manager confirmation, an ssh host-key prompt, a credential prompt) accepted by default.  The two error directions are not symmetric: an allowlist that wrongly refuses leaves the pane unrecovered, which is logged, retried, and bounded by the pre-registration row's expiry, whereas an acceptance that is wrong executes an irreversible keypress in a pane the daemon does not understand.

The predicate SHALL be supplied by the codex-side callers as an option on the shared tmux poke primitive, evaluated after the quiet guard and the pre-write ownership read, on the pane tail the primitive already captures before writing, and before the buffer is loaded.  A caller that supplies no predicate SHALL be unaffected: the shared quiet guard's own behaviour SHALL NOT change, because it also serves panes whose ready state is not a codex composer.

A refusal SHALL report a reason distinct from the quiet-guard failure, and SHALL leave the pane untouched — no buffer loaded, no paste, no `Enter`.  The distinction is required because this predicate has a failure mode the quiet guard does not: were the composer's rendering to change, every codex pane would be refused at once, and a shared reason would describe that outage as "the screen was still changing" and send diagnosis in the wrong direction.

Any error, timeout, or otherwise unreadable capture underlying the predicate SHALL read as not-ready, consistent with the fail-closed rule the write-checkpoint probes already follow.

#### Scenario: A blocking startup menu is refused

- **GIVEN** a codex-targeted injection for a pane whose tail shows a blocking startup menu awaiting a keypress
- **AND** the tail is unchanged across the quiet window, so the quiet guard passes
- **WHEN** the send attempt runs
- **THEN** the prompt-readiness predicate refuses and nothing is written into the pane — no buffer, no paste, no `Enter`
- **AND** the refusal is reported under its own reason, not the quiet-guard one

#### Scenario: An idle composer is accepted

- **GIVEN** a codex-targeted injection for a pane whose tail presents an idle codex composer
- **WHEN** the send attempt runs and every ownership and carrier check passes
- **THEN** the predicate accepts and the paste proceeds through the unchanged write sequence

#### Scenario: A caller supplying no predicate is unaffected

- **GIVEN** a tmux injection aimed at a non-codex pane, dispatched without a readiness predicate
- **WHEN** the send attempt runs
- **THEN** the primitive behaves exactly as before, gated by the quiet guard and the ownership reads alone

#### Scenario: An unreadable capture reads as not-ready

- **GIVEN** a codex-targeted injection whose pre-write pane capture errors or times out
- **WHEN** the send attempt runs
- **THEN** the state reads as not-ready and neither paste nor `Enter` is issued

