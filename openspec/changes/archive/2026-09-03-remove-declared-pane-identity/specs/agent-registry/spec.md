## REMOVED Requirements

### Requirement: codex_pane_pre_registrations table carries the declared identity
**Reason**: launcher 侧 (aoe `68621c6e`) 已整条删除声明身份, 两列不再有写入方; 半拆状态 (列在、不读写) 比删列更易误读.
**Migration**: 迁移对已有表执行 `ALTER TABLE codex_pane_pre_registrations DROP COLUMN team` / `... DROP COLUMN agent_name` (列不存在时跳过, 幂等). 回滚到旧版本时其 `ADD COLUMN` 迁移会把列加回.

#### Scenario: Migration drops the columns and is idempotent
- **GIVEN** a database whose pre-registration table carries `team` and `agent_name`
- **WHEN** the schema is applied
- **THEN** `PRAGMA table_info(codex_pane_pre_registrations)` no longer lists `team` or `agent_name`
- **AND** applying the schema again completes without error

### Requirement: Declared identity labels are validated at the pre-registration entry
**Reason**: `pre_register_codex_pane` 不再接受 `team` / `agent_name`, 校验对象不存在.
**Migration**: 传入这两个字段的调用被 zod strict schema 以 `invalid_arguments` 拒绝, 不写状态.

#### Scenario: Supplying a declaration is a schema error
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%25", xats_agent_id:"U1", team:"monkeys", agent_name:"mvr-coder"})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message> }`
- **AND** no state is written

### Requirement: CLI pre-register-codex-pane forwards the declared identity
**Reason**: 唯一调用方 aoe 已不传 `--team` / `--agent-name`.
**Migration**: 两个 flag 从 `PRE_REGISTER_FLAGS` 移除; 传入按既有未知 flag 规则在联系 daemon 之前 `exit(2)`.

#### Scenario: The removed flags are unknown flags
- **WHEN** the launcher runs `pre-register-codex-pane --pane %25 --agent-id U1 --team monkeys`
- **THEN** the CLI exits with code 2 naming `--team` as an unknown flag
- **AND** the daemon is never contacted

### Requirement: register_agent tool description names the declared-identity environment variables
**Reason**: launcher 不再导出 `XATS_TEAM` / `XATS_AGENT_NAME`; 描述里保留指引会让 agent 去读一个永远为空、或残留自旧 pane 的变量.
**Migration**: 描述删除该段与 codex 例外说明; 首次注册回到 channel proxy 开场白问人的既有路径.

#### Scenario: Description no longer names the variables
- **WHEN** an MCP client enumerates `register_agent` and `pre_register_codex_pane` via `tools/list`
- **THEN** neither description contains the literal substrings `XATS_TEAM` or `XATS_AGENT_NAME`
- **AND** the `agent_type` DETECTION sequence is unchanged

## MODIFIED Requirements

### Requirement: pre_register_codex_pane tool records pending tmux pane claim

The daemon SHALL expose an MCP tool `pre_register_codex_pane` that accepts `pane_id` (string, tmux pane identifier such as `%1972`), `xats_agent_id` (non-empty string, matches the UUID the launcher will place on the `codex --remote` command line via `-c xats.agent_id="<uuid>"`), optional `identity_key` (non-empty, non-whitespace string, the launcher-minted restart-stable identity handle, delivered only over this CLI/HTTP channel), and optional `ttl_seconds` (positive integer, default `120`, capped at `600`).  On success it SHALL persist a pending pre-registration row keyed by `pane_id` (including `identity_key` when supplied) and return `{ ok: true, expires_at: <ISO8601> }`.  If `pane_id` or `xats_agent_id` is missing or empty, or `identity_key` is supplied but empty or whitespace-only, the tool SHALL return `{ error: "invalid_arguments", detail: <message> }` without writing any state.

#### Scenario: Launcher pre-registers a pane successfully
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"4EF01740-DBAC-4F39-BD94-64A058815856"})`
- **THEN** the daemon writes a pending pre-reg row for `%1972` with the given UUID and a `ttl_seconds=120` default expiry
- **AND** returns `{ ok: true, expires_at: <now + 120s> }`

#### Scenario: Launcher pre-registers with an identity key
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1", identity_key:"K1", ttl_seconds:300})`
- **THEN** the stored row carries `identity_key="K1"` alongside `xats_agent_id="U1"`
- **AND** returns `{ ok: true, expires_at: <now + 300s> }`

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

When a pre-reg for the same `pane_id` already exists, the new call SHALL replace the stored `xats_agent_id`, `identity_key` (including replacing a present key with NULL when the new call omits it), and `expires_at` atomically.  The previous row SHALL NOT leak to subsequent register calls or to recovery-poke scheduling.

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
