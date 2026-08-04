## ADDED Requirements

### Requirement: Daemon exposes thin OpenCode runtime REST control adapters

The daemon SHALL expose `POST /api/runtime/opencode/reserve` and
`POST /api/runtime/opencode/commit` on its existing HTTP port.  The handlers
MUST call the existing OpenCode runtime recovery service and MUST NOT duplicate
generation fencing, CAS, exact-session probing, delivery commit or recovery
prompt logic.

The reserve body MUST be the strict object
`{identity_key,runtime_generation,protocol_version}`.  The commit body MUST be
the strict object
`{identity_key,runtime_generation,protocol_version,base_url,session_id}`.
`identity_key` MUST be non-blank, `runtime_generation` MUST be a positive safe
integer, `protocol_version` MUST be present and integral, `base_url` MUST be a
canonicalizable HTTP(S) URL without query, fragment or userinfo, and
`session_id` MUST be non-blank and start with `ses`.  Unknown or missing fields
MUST be rejected before the service runs.

#### Scenario: Valid reserve reaches the existing service

- **WHEN** a loopback caller posts a schema-valid reserve body
- **THEN** the adapter calls `OpencodeRuntimeRecoveryService.reserve` with the exact parsed fields
- **AND** it returns the service outcome without rewriting domain fields

#### Scenario: Valid commit reaches the existing service

- **WHEN** a loopback caller posts a schema-valid commit body with exact `base_url` and `session_id`
- **THEN** the adapter calls `OpencodeRuntimeRecoveryService.commit` with the exact parsed fields
- **AND** it returns the service outcome without binding the REST connection

#### Scenario: Strict schema rejects an unknown field

- **WHEN** either request contains an unknown field or omits `protocol_version`
- **THEN** the daemon returns HTTP 400 with `ok:false`,
  `error: "invalid_request"` and a stable `detail` without request field names
  or values
- **AND** the recovery service is not called

### Requirement: Runtime control preserves service outcomes behind an HTTP boundary

After a request passes schema validation and enters the recovery service, the daemon SHALL return HTTP 200 for both successful and unsuccessful domain
outcomes, and the JSON body SHALL preserve the existing service result.  This
includes fresh reserve `need_register`, idempotent or changed reserve,
successful commit, protocol mismatch, stale generation, conflicts and probe or
recovery-prompt failures.

Malformed JSON or schema input SHALL return HTTP 400 with `ok:false`,
`error: "invalid_request"` and a stable `detail` without request field names or
values.  Storage failures SHALL return HTTP 503 with `ok:false` and
`error: "storage_unavailable"`.  Other unexpected handler failures SHALL return
HTTP 500 with `ok:false` and `error: "internal_error"`.  Error responses MUST NOT
include request values or thrown exception text.

#### Scenario: Fresh reserve outcome remains HTTP 200

- **GIVEN** the identity key has no local row
- **WHEN** reserve runs through the REST adapter
- **THEN** the response status is 200
- **AND** the body is `{ok:true,need_register:true,state:"unregistered"}`

#### Scenario: Protocol mismatch remains a domain outcome

- **WHEN** a schema-valid request carries a protocol version other than 1
- **THEN** the response status is 200
- **AND** the body reports `protocol_version_mismatch`
- **AND** no registry mutation, endpoint probe or prompt scheduling occurs

#### Scenario: Commit outcome preserves unbound control semantics

- **WHEN** a commit succeeds through the REST adapter
- **THEN** the response status is 200 and includes `delivery_committed:true`
- **AND** it includes `connection_bound:false`
- **AND** the exact OpenCode session, not the REST caller, performs reconnect

### Requirement: Runtime control protects identity key material

The REST control endpoints MUST accept the identity key only in the JSON body.
They MUST NOT accept it in a URL path or query parameter, MUST NOT include it in
any success or error response, and MUST NOT write it to daemon logs.  Schema
errors and unexpected exceptions MUST be rendered without echoing request values
or exception text that may contain the key.

#### Scenario: Exception containing key text is redacted at the boundary

- **WHEN** a thrown internal failure message contains the submitted identity key
- **THEN** the daemon returns only the stable `{ok:false,error:"internal_error"}`
  envelope
- **AND** neither response nor daemon log contains the key

#### Scenario: Normal outcomes never echo the key

- **WHEN** reserve or commit returns any normal service outcome
- **THEN** the serialized HTTP body does not contain the submitted identity key

### Requirement: Runtime control reuses REST authentication and origin gates

Both runtime control endpoints MUST pass through the same daemon token
authentication and socket-derived loopback gate as every other `/api/*` route.
A missing or invalid configured token MUST return HTTP 401 before the service
runs.  A remote peer MUST return HTTP 403 even with the correct token, and MUST
perform no fence, delivery, probe or prompt action.  Forwarded-address headers
MUST NOT influence the origin decision.

#### Scenario: Authenticated loopback caller reaches runtime control

- **GIVEN** the daemon requires a bearer token
- **WHEN** a loopback caller supplies the correct token and a valid body
- **THEN** the request reaches the recovery service

#### Scenario: Missing token cannot reserve a generation

- **GIVEN** the daemon requires a bearer token
- **WHEN** a loopback caller omits it
- **THEN** reserve returns HTTP 401
- **AND** the recovery service is not called

#### Scenario: Remote peer cannot commit with a valid token

- **GIVEN** the daemon requires a bearer token
- **WHEN** a remote peer supplies it and posts a valid commit body
- **THEN** the daemon returns HTTP 403
- **AND** the recovery service is not called

### Requirement: MCP tools and CLI remain compatible

Adding REST runtime control SHALL NOT remove or change the existing
`reserve_opencode_runtime` and `commit_opencode_runtime` MCP tools or the
`reserve-opencode-runtime` and `commit-opencode-runtime` CLI commands.  All
three adapters SHALL use recovery protocol version 1 and the same domain
service semantics.

#### Scenario: Existing control adapters remain available

- **WHEN** the REST endpoints are mounted
- **THEN** both MCP tools remain discoverable and callable
- **AND** both CLI subcommands retain their existing argument and outcome contract
