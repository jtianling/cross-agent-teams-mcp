## ADDED Requirements

### Requirement: OpenCode delivery persists committed runtime generation

`opencode-server` delivery SHALL accept, serialize and parse a non-negative safe integer `runtime_generation`.  Newly generated recovery deliveries MUST use a positive value.  Legacy payloads without the field SHALL read with effective generation 0 without materializing an own property or adding the field during serialization, and SHALL preserve existing session, base URL and auth token reference validation.

#### Scenario: Recovery delivery round-trips generation

- **GIVEN** an OpenCode delivery with session S, base URL B, auth reference A and generation N
- **WHEN** it is serialized and read back
- **THEN** all four values are preserved exactly

#### Scenario: Legacy delivery has baseline generation

- **GIVEN** a valid legacy OpenCode payload without `runtime_generation`
- **WHEN** it is read
- **THEN** its effective generation is 0
- **AND** the parsed object and serialized payload still omit the field

### Requirement: Recovering OpenCode delivery never pokes stale endpoint

An OpenCode identity SHALL be `recovering` when its runtime fence exceeds its committed delivery generation.  Normal message sending SHALL continue writing its mailbox and event rows, but delivery dispatch SHALL return `runtime_recovering` and MUST NOT fetch health, session or prompt endpoints on the old delivery.

#### Scenario: Mailbox survives recovery window

- **GIVEN** an OpenCode identity whose fence is N+1 and delivery generation is N
- **WHEN** another agent sends it a message with auto-poke enabled
- **THEN** the mailbox row is written normally
- **AND** poke reports `runtime_recovering`
- **AND** no request reaches the generation N endpoint

#### Scenario: Matching generation restores normal dispatch

- **GIVEN** the identity fence and committed delivery generation both equal N+1
- **WHEN** a later message is delivered
- **THEN** normal OpenCode dispatch eligibility is restored
