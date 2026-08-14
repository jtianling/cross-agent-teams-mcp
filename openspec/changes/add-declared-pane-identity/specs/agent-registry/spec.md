## ADDED Requirements

### Requirement: codex_pane_pre_registrations table carries the declared identity

The `codex_pane_pre_registrations` table SHALL carry two nullable columns, `team TEXT` and `agent_name TEXT`, holding the identity a launcher declares for that pane.  Migration SHALL add them to an existing table, leaving every pre-existing row NULL, and SHALL be idempotent when the columns already exist.

The two columns SHALL live on the pre-registration row rather than anywhere longer-lived, because the declaration must share the row's lifetime exactly: overwritten when the row is overwritten, gone when the row is consumed or expires.  A declaration surviving its row would no longer be "what this pane declared on THIS launch", which is the only thing it is allowed to mean.

The declared columns SHALL NOT be added to the full-snapshot currency comparison used by row consumption and recovery-schedule generation (`pane_id`, `xats_agent_id`, `identity_key`, `expires_at`).  That comparison protects binding decisions, and the declaration influences no binding decision — only which identity a notice names.  Declaration replacement is protected deterministically elsewhere: every accepted overwrite SHALL unconditionally retire the old recovery generation with `cancelCodexRecoverySchedule(reason='row_replaced')` before re-evaluating the new row, so an in-flight old send stops at its next generation checkpoint.  Currency comparison is not the safety boundary for declaration replacement.

#### Scenario: Migration adds the columns and leaves old rows null
- **GIVEN** a database whose pre-registration table predates this change
- **WHEN** the schema is applied
- **THEN** `PRAGMA table_info(codex_pane_pre_registrations)` includes `team` and `agent_name`
- **AND** every pre-existing row has both columns NULL

#### Scenario: Applying the schema twice is safe
- **WHEN** the schema is applied to a database that already has both columns
- **THEN** the migration completes without error and no data changes

### Requirement: Declared identity labels are validated at the pre-registration entry

`pre_register_codex_pane` SHALL validate a supplied `team` or `agent_name` against the same label rules the registry applies to an agent's own identity: `agent_name` SHALL NOT contain `:`, `(`, or `)`; `team` SHALL NOT contain `(` or `)`.  Both fields SHALL additionally reject `"`, Unicode control characters (including newlines, carriage returns and tabs), and the Unicode line separators U+2028 and U+2029.  A violation SHALL return `{ error: "invalid_arguments", detail: <message naming the offending field> }` and SHALL write no state.  Double quote carries addressing meaning inside the daemon's fixed recovery-notice template, so accepting it would make the quoted registration identity ambiguous rather than merely unconventional.

The daemon SHALL NOT accept-and-drop, accept-and-truncate, or otherwise tolerate an invalid label.  The reason is the shape of the calling side: a launcher's degrade-and-retry branch can only observe an exit code, so it cannot distinguish "this daemon does not know the flag" from "this daemon knows it and the value is invalid".  A tolerant daemon therefore produces the worst available outcome — the retry drops the declaration, the call succeeds, the pane looks healthy, and the declaration silently does not exist until the next seat rebuild reveals it.  That is the same class of failure this change exists to remove.  A hard refusal instead surfaces the error while a human is still looking at the configuration.

Whitespace-only values SHALL be rejected on the same grounds as an empty `identity_key`.  Supplied values SHALL be trimmed before storage and before the accepted-row recovery hook runs.  Spaces and single quotes inside an otherwise valid label SHALL be accepted; double quotes, control characters and U+2028/U+2029 SHALL be rejected.  The two line separators are named separately because Unicode does not classify them as control characters: rejecting them makes the label contain no line terminator and keeps the notice's addressing field single-line.  This is contract completeness, not mitigation of premature submission; bracketed paste does not submit on these characters.

#### Scenario: A parenthesised name is refused rather than dropped
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%25", xats_agent_id:"U1", team:"monkeys", agent_name:"mvr-coder(monkeys)"})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message naming agent_name> }`
- **AND** no row is written, so the caller cannot mistake this for a stored declaration

#### Scenario: A colon in the name is refused
- **WHEN** the launcher supplies `agent_name:"mvr-coder:jt"`
- **THEN** the call is refused with `invalid_arguments` naming `agent_name`

#### Scenario: A colon in the team is accepted but parentheses are not
- **WHEN** the launcher supplies `team:"monkeys:a"`
- **THEN** the call succeeds, because the team rule constrains only `(` and `)`
- **AND** a later call supplying `team:"monkeys(a)"` is refused with `invalid_arguments` naming `team`

#### Scenario: Spaces and single quotes inside a label are accepted
- **WHEN** the launcher supplies `team:" monkeys team "` and `agent_name:" mvr 'coder' "`
- **THEN** the call succeeds and the row stores `team="monkeys team"` and `agent_name="mvr 'coder'"`

#### Scenario: Double quotes, control characters and line separators are refused
- **WHEN** the launcher supplies `agent_name:"mvr\"coder"` or a label containing `\n`, `\r`, `\t`, U+2028 or U+2029
- **THEN** the call is refused with `invalid_arguments` naming the offending field
- **AND** no state is written

#### Scenario: Whitespace-only values are refused
- **WHEN** the launcher supplies `agent_name:"   "`
- **THEN** the call is refused with `invalid_arguments` naming `agent_name`
- **AND** no state is written

### Requirement: CLI pre-register-codex-pane forwards the declared identity

The `pre-register-codex-pane` CLI SHALL accept optional `--team <value>` and `--agent-name <value>` and forward each as the corresponding tool argument.  The two flags SHALL be independently optional: either may appear without the other.  Both SHALL be added to the known-flag set so that supplying them is not rejected as an unknown flag.

The flag SHALL be named `--agent-name`, not `--name`.  This CLI already carries `--agent-id` for the codex launch uuid, which is an unrelated dimension; a bare `--name` beside it reads as that identifier's name.  `--agent-name` also makes every flag correspond one-to-one with its environment-variable twin (`--team` ↔ `XATS_TEAM`, `--agent-name` ↔ `XATS_AGENT_NAME`).

A value SHALL be forwarded verbatim, including spaces and quotes that survived shell escaping; the daemon owns label validation and the CLI SHALL NOT duplicate it.

The CLI SHALL nevertheless require each new flag to own a following value token.  A following token beginning with `--` SHALL be treated as the next flag, not as the current flag's value, and the CLI SHALL fail locally with `invalid_arguments` before contacting the daemon.  This is argument-boundary parsing, not duplicated label validation.

#### Scenario: Both flags are forwarded
- **WHEN** the launcher runs `pre-register-codex-pane --pane %25 --agent-id U1 --identity-key-env XATS_IDENTITY_KEY --team monkeys --agent-name mvr-coder`
- **THEN** the tool call carries `team="monkeys"` and `agent_name="mvr-coder"` alongside the pane, uuid and key

#### Scenario: One flag without the other is accepted
- **WHEN** only `--team monkeys` is supplied
- **THEN** the tool call carries `team="monkeys"` and no `agent_name`

#### Scenario: Neither flag leaves the call unchanged
- **WHEN** neither flag is supplied
- **THEN** the tool call is byte-for-byte what it was before this change

#### Scenario: The daemon's label refusal reaches the caller
- **WHEN** `--agent-name 'mvr-coder(monkeys)'` is supplied
- **THEN** the CLI exits non-zero and prints the daemon's `invalid_arguments` envelope naming `agent_name`

#### Scenario: A missing value cannot consume the next flag
- **WHEN** the launcher runs `--team --agent-name mvr-coder`
- **THEN** the CLI exits non-zero with `invalid_arguments` naming `--team`
- **AND** it does not store `--agent-name` as a team

### Requirement: register_agent tool description names the declared-identity environment variables

The `register_agent` MCP tool description SHALL instruct callers to read `XATS_TEAM` and `XATS_AGENT_NAME` from their environment and, when present, register under those values instead of asking a human which identity they are.  The instruction SHALL be written for every `agent_type`, not for codex alone.

The description SHALL state that these variables are the launcher's declaration of who this pane is, and that they are what allows an identity to survive a seat rebuild, which no runtime lookup can do once the pane's identity key has been re-minted.

The description SHALL state that codex is the exception that cannot use them: a codex tool call executes inside the shared app-server, so the values it reads belong to the shell that launched that server rather than to its own pane.  Codex SHALL be told that its launcher delivers the declaration through `pre_register_codex_pane` instead, exactly as with `XATS_IDENTITY_KEY`.

These variables SHALL NOT be added as a branch of the numbered first-match-wins `agent_type` DETECTION sequence: they say nothing about which runtime the caller is.

#### Scenario: Description names both variables
- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description contains the literal substrings `XATS_TEAM` and `XATS_AGENT_NAME`
- **AND** it instructs registering under those values when they are present

#### Scenario: The instruction is not codex-scoped
- **WHEN** the description is inspected
- **THEN** the declared-identity instruction is stated for every `agent_type`
- **AND** it separately records that codex cannot read them and relies on its launcher instead

#### Scenario: The variables are not an agent_type probe
- **WHEN** the description is inspected
- **THEN** neither variable appears as a numbered branch of the `agent_type` DETECTION sequence
- **AND** the existing `agent_type` probes are unchanged

## MODIFIED Requirements

### Requirement: pre_register_codex_pane tool records pending tmux pane claim

The daemon SHALL expose an MCP tool `pre_register_codex_pane` that accepts `pane_id` (string, tmux pane identifier such as `%1972`), `xats_agent_id` (non-empty string, matches the UUID the launcher will place on the `codex --remote` command line via `-c xats.agent_id="<uuid>"`), optional `identity_key` (non-empty, non-whitespace string, the launcher-minted restart-stable identity handle, delivered only over this CLI/HTTP channel), optional `team` and `agent_name` (non-empty, non-whitespace strings, the identity the launcher declares for this pane, subject to the label rules in `Declared identity labels are validated at the pre-registration entry`), and optional `ttl_seconds` (positive integer, default `120`, capped at `600`).  On success it SHALL trim supplied `team` and `agent_name`, persist a pending pre-registration row keyed by `pane_id` (including `identity_key`, normalized `team` and normalized `agent_name` when supplied), and return `{ ok: true, expires_at: <ISO8601> }`.  If `pane_id` or `xats_agent_id` is missing or empty, or `identity_key`, `team` or `agent_name` is supplied but empty or whitespace-only, the tool SHALL return `{ error: "invalid_arguments", detail: <message> }` without writing any state.

`team` and `agent_name` SHALL be independently optional, and neither SHALL imply the other: a launcher that knows only one of them SHALL be able to send it.  Whether a partial declaration is usable is decided where notices are scheduled, not here.

#### Scenario: Launcher pre-registers a pane successfully
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"4EF01740-DBAC-4F39-BD94-64A058815856"})`
- **THEN** the daemon writes a pending pre-reg row for `%1972` with the given UUID and a `ttl_seconds=120` default expiry
- **AND** returns `{ ok: true, expires_at: <now + 120s> }`

#### Scenario: Launcher pre-registers with an identity key
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1", ttl_seconds:300})`
- **THEN** the stored row carries `identity_key="K1"` alongside `xats_agent_id="U1"`
- **AND** returns `{ ok: true, expires_at: <now + 300s> }`

#### Scenario: Launcher pre-registers with a declared identity
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%25", xats_agent_id:"U1", identity_key:"K1", team:"monkeys", agent_name:"mvr-coder"})`
- **THEN** the stored row carries `team="monkeys"` and `agent_name="mvr-coder"` alongside the uuid and key
- **AND** returns `{ ok: true, expires_at: <ISO8601> }`

#### Scenario: A declaration missing one half is still stored
- **WHEN** the launcher supplies `team` without `agent_name`
- **THEN** the row stores the supplied half and leaves the other NULL

#### Scenario: Empty identity_key is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", identity_key:""})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning identity_key> }`
- **AND** no state is written

#### Scenario: Whitespace-only identity_key is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", identity_key:"   "})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning identity_key> }`
- **AND** no state is written

#### Scenario: Missing pane_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({xats_agent_id:"abc"})` without `pane_id`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning pane_id> }`
- **AND** no state is written

#### Scenario: Empty xats_agent_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:""})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning xats_agent_id> }`
- **AND** no state is written

#### Scenario: ttl_seconds is capped at 600
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", ttl_seconds:9999})`
- **THEN** the daemon stores the row with `expires_at = now + 600s`
- **AND** the returned `expires_at` reflects the capped value

### Requirement: pre_register_codex_pane overwrites existing entry for same pane

When a pre-reg for the same `pane_id` already exists, the new call SHALL replace the stored `xats_agent_id`, `identity_key` (including replacing a present key with NULL when the new call omits it), `team` and `agent_name` (each likewise replaced with NULL when the new call omits it), and `expires_at` atomically.  The previous row SHALL NOT leak to subsequent register calls or to recovery-poke scheduling.

A declaration SHALL be cleared by an omitting overwrite for the same reason a key is: the row states what THIS launch announced, and a stale declaration surviving into a launch that did not make it would name an identity nobody currently claims.

#### Scenario: Re-launching in the same pane overwrites
- **WHEN** pane `%1972` has a pending pre-reg with `xats_agent_id=A`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"B"})`
- **THEN** the row for `%1972` now stores `xats_agent_id=B` and a fresh `expires_at`
- **AND** any subsequent `register_agent` match uses `B`, never `A`

#### Scenario: Overwrite without identity_key clears the stored key
- **WHEN** pane `%1972` has a pending pre-reg with `identity_key="K1"`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"B"})` without `identity_key`
- **THEN** the row for `%1972` now has `identity_key = NULL`
- **AND** no recovery poke fires on behalf of `K1` for this pane

#### Scenario: Overwrite without a declaration clears the stored declaration
- **WHEN** pane `%25` has a pending pre-reg declaring `team="monkeys"`, `agent_name="mvr-coder"`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%25", xats_agent_id:"B"})` without either field
- **THEN** the row for `%25` now has `team = NULL` and `agent_name = NULL`
- **AND** no notice names `mvr-coder` on behalf of this pane
