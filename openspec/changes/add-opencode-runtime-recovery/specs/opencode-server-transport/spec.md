## ADDED Requirements

### Requirement: Recovery validates exact OpenCode server and session

OpenCode runtime commit and key-based OpenCode reconnect SHALL canonicalize and validate the supplied base URL, resolve the stored authentication reference through the existing OpenCode dispatcher path, verify server health, and verify the exact supplied session id.  They MUST NOT resolve latest session, select by cwd, or accept a different session returned by the server.

All generation and conflict checks that can reject without network access MUST run before probes.  Exact health and session probing SHALL have a finite wall-time bound.  A failed, timed out, missing or mismatched exact session SHALL return an explicit session/probe error and MUST NOT mutate delivery or connection binding.

#### Scenario: Exact session is required even with another live session

- **GIVEN** server B has live sessions S1 and S2, with S2 most recently updated
- **WHEN** commit or reconnect explicitly supplies S1
- **THEN** only S1 is probed and used
- **AND** S2 is never selected by recency

#### Scenario: Failed exact probe has no side effect

- **WHEN** health fails or the exact session is absent or mismatched
- **THEN** no delivery row or MCP connection binding changes

### Requirement: Recovery prompt uses exact session and existing prompt_async contract

The recovery trigger SHALL call the existing OpenCode `prompt_async` endpoint for the committed exact session and SHALL send `{parts:[...],noReply:false}`.  The prompt text SHALL contain no identity key value and SHALL not direct a different or latest session.

#### Scenario: Prompt is routed to committed session only

- **GIVEN** two OpenCode sessions share one base URL
- **WHEN** delivery for S1 is committed
- **THEN** prompt_async is invoked for S1 only with `noReply:false`
