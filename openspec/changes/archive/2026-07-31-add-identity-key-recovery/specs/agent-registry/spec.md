## ADDED Requirements

### Requirement: Agents table includes identity_key column

The `agents` table SHALL carry a nullable `identity_key TEXT` column holding an opaque, launcher-minted value that survives a pane restart, plus a `UNIQUE(device, identity_key)` index.  The key is scoped per device because every reconnect lookup is already device-scoped and a key carried to another host is meaningless there; SQLite treats `NULL` as distinct under a unique index, so the unregistered majority of rows are unaffected.

The daemon SHALL add both the column and the index on startup through the existing idempotent schema-healing path, so a database created before this change gains them without operator action, and a database that already has them is left untouched.

The daemon SHALL NOT interpret, parse, or validate the contents of `identity_key` beyond requiring a non-blank string.

#### Scenario: Fresh database carries the column and index

- **WHEN** the daemon initialises a new database
- **THEN** `PRAGMA table_info(agents)` includes `identity_key`
- **AND** a unique index over `(device, identity_key)` exists

#### Scenario: Legacy database is healed on startup

- **GIVEN** a database whose `agents` table predates this change and has no `identity_key` column
- **WHEN** the daemon starts against it
- **THEN** the column and the unique index are added
- **AND** every pre-existing row has `identity_key = NULL`
- **AND** starting the daemon a second time against the same database makes no further schema change and raises no error

#### Scenario: Many rows may hold a null key

- **GIVEN** several agents rows on one device that were registered without an identity key
- **WHEN** another such row is inserted
- **THEN** the unique index does not reject it

### Requirement: register_agent accepts optional identity_key and binds it by a four-branch rule

`register_agent` SHALL accept an optional `identity_key` string.  When supplied, the daemon SHALL resolve it against the caller's device and apply exactly one of four branches:

1. **Unbound** — no row on this device holds the key: the key is written onto the row this call registers.
2. **Idempotent** — the key is already held by the very row this call registers (same `(device, team, name)`): nothing changes.
3. **Migration** — the key is held by a *different* row whose binding is not held by a live process, meaning that row's `runtime_ui_pid` is `NULL`, equals the `ui_pid` of the current call, or names a process that no longer exists: the key moves to the row this call registers and is cleared on the old row.  This is the ordinary rename path — because identity is keyed on `(device, team, name)`, registering under a new name inserts a *new* row rather than updating the old one, so without migration the key would keep pointing at the abandoned identity.
4. **Conflict** — the key is held by a different row whose `runtime_ui_pid` names a live process other than the caller's: the call SHALL fail with `identity_key_conflict` and the error SHALL carry the holding row's `team` and `name` so the operator can diagnose which pane is holding it.  No row is created or mutated.

A `register_agent` call that omits `identity_key` SHALL leave any existing key on the matched row untouched, mirroring how an omitted `delivery` is preserved.  Omitting the key SHALL NOT change behaviour for any pre-existing caller.

The conflict branch is a secondary net only.  It catches two panes registering while both are alive; it cannot catch a key that was copied and later used to recover an identity, because at reconnect time a legitimate restart and a stolen key are indistinguishable.  Preventing duplication remains the minting side's responsibility.

#### Scenario: First registration binds the key

- **GIVEN** no row on device `D` holds key `K`
- **WHEN** an agent calls `register_agent({name: 'tester', team: 'aoe', identity_key: 'K', ...})`
- **THEN** the resulting row has `identity_key = 'K'`

#### Scenario: Re-registering the same identity is idempotent

- **GIVEN** row `(D, aoe, tester)` holds key `K`
- **WHEN** the same identity registers again with `identity_key: 'K'`
- **THEN** the call succeeds
- **AND** the row still holds `K` and keeps its `agent_id`

#### Scenario: Rename migrates the key to the new row

- **GIVEN** row `(D, aoe, tester)` holds key `K` and its `runtime_ui_pid` names a process that no longer exists
- **WHEN** an agent calls `register_agent({name: 'reviewer', team: 'aoe', identity_key: 'K', ...})`
- **THEN** the call succeeds and the new row `(D, aoe, reviewer)` holds `K`
- **AND** row `(D, aoe, tester)` has `identity_key = NULL`
- **AND** a later `reconnect` by `K` resolves to `(aoe, reviewer)`, not `(aoe, tester)`

#### Scenario: Rename from the same live process migrates the key

- **GIVEN** row `(D, aoe, tester)` holds key `K` with `runtime_ui_pid = P`
- **WHEN** a call carrying `ui_pid: P` registers `(aoe, reviewer)` with `identity_key: 'K'`
- **THEN** the key migrates to the new row rather than being rejected

#### Scenario: Two live panes sharing a key is rejected

- **GIVEN** row `(D, aoe, tester)` holds key `K` with `runtime_ui_pid = P`, and process `P` is alive
- **WHEN** a different call whose `ui_pid` is not `P` registers `(aoe, second)` with `identity_key: 'K'`
- **THEN** the response is `identity_key_conflict`
- **AND** the error names `team = 'aoe'` and `name = 'tester'`
- **AND** neither row is created or mutated

#### Scenario: Omitting the key preserves an existing one

- **GIVEN** row `(D, aoe, tester)` holds key `K`
- **WHEN** that identity registers again without an `identity_key` argument
- **THEN** the row still holds `K`

#### Scenario: Blank key is rejected at the schema layer

- **WHEN** a caller passes `identity_key: ''`
- **THEN** the call is rejected by schema validation
- **AND** no row is created or mutated

### Requirement: register_agent tool description instructs callers to present XATS_IDENTITY_KEY

The `register_agent` MCP tool description SHALL instruct callers to read `XATS_IDENTITY_KEY` from their environment and pass it as `identity_key` on **every** registration, including the very first one.  The description MUST state that the key is what makes the identity recoverable after a restart, and that omitting it on the first registration silently disables recovery for that pane with no observable symptom.

This instruction is orthogonal to the existing `agent_type` DETECTION block: `XATS_IDENTITY_KEY` SHALL NOT be added as a first-match-wins `agent_type` probe, because it says nothing about which runtime the caller is.  It applies to every `agent_type`.

The description exists specifically to cover runtimes that have no channel proxy to inline the value for them — codex above all.

#### Scenario: Description names the environment variable

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description contains the literal substring `XATS_IDENTITY_KEY`
- **AND** it instructs passing that value as `identity_key`

#### Scenario: Description covers the first registration

- **WHEN** the `register_agent` description is inspected
- **THEN** it states that the key must be presented on the first registration, not only when recovering

#### Scenario: The key is not an agent_type probe

- **WHEN** the `register_agent` description is inspected
- **THEN** `XATS_IDENTITY_KEY` does not appear as a numbered branch of the first-match-wins `agent_type` DETECTION sequence
- **AND** the four existing `agent_type` probes are unchanged
