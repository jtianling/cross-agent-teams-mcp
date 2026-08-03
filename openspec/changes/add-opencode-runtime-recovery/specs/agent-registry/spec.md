## ADDED Requirements

### Requirement: Registry stores an independent OpenCode runtime fence

The agents table SHALL store an OpenCode runtime fence generation independently from daemon-internal `register_generation`.  The fence SHALL be a non-negative safe integer in storage.  Migration SHALL backfill null values even when the column already exists.  Legacy rows with missing or null fence SHALL read as 0, and first reserve SHALL migrate them through the same CAS path.

New OpenCode registration with `runtime_generation` SHALL atomically write both the initial fence and the OpenCode delivery generation.  Runtime reserve/commit/reconnect MUST NOT reuse or alter `register_generation` to express this protocol.

#### Scenario: Legacy row starts at baseline zero

- **GIVEN** an OpenCode row created before the fence column existed
- **WHEN** it is read and generation 1 is reserved
- **THEN** its effective fence begins at 0 and advances to 1
- **AND** `register_generation` is unchanged

#### Scenario: New registration stores both generations

- **WHEN** a first-time OpenCode `register_agent` supplies exact session id and runtime generation N
- **THEN** the row is created with fence N
- **AND** its delivery payload carries generation N in the same transaction

#### Scenario: 旧注册不能降级 runtime-aware row

- **GIVEN** 一个 fence 或已提交 delivery generation 为正数的 OpenCode row
- **WHEN** no-generation 注册以该 row 为目标, 或尝试把它的 identity key 迁移到另一个名称
- **THEN** 注册返回 `opencode_runtime_coordinates_required`
- **AND** row, delivery, register generation 和 identity key 均保持不变

#### Scenario: 非恢复 writer 不能改写 runtime-aware row

- **GIVEN** 一个 effective type 为 OpenCode, 且 fence 或 delivery generation 为正数的 row
- **WHEN** `bind_channel`、channel auto-bind、proxy reactive rebind 或低层 type/delivery writer 尝试改写该 row
- **THEN** 写入被拒绝或跳过
- **AND** agent type, delivery, fence, register generation 和 identity key 均保持不变

#### Scenario: Codex seat-follow 不能迁移 OpenCode identity key

- **GIVEN** runtime-aware OpenCode row 持有 identity key K
- **WHEN** Codex seat-follow 把该 row 判定为 dead holder 并尝试迁移 K
- **THEN** identity-key writer 在同一事务内重读 holder 并拒绝迁移
- **AND** K 仍属于原 OpenCode row, Codex row 不获得 K

### Requirement: Runtime state updates preserve identity and cursor

Reserve and commit SHALL update only fields owned by the OpenCode runtime recovery protocol.  They MUST preserve agent id, name, team, role, model, device, registered timestamp, last processed event id, identity key and auth token reference.  CAS predicates SHALL include the selected identity holder and expected fence so a key reassignment or later reserve invalidates an older writer.

#### Scenario: Reserve and commit do not reset unread cursor

- **GIVEN** an OpenCode row whose last processed event id is E
- **WHEN** its next generation is reserved and committed
- **THEN** its last processed event id remains E
- **AND** the agent id and identity metadata are unchanged

#### Scenario: Reversed completion order is fenced

- **GIVEN** two commit attempts whose endpoint probes complete in reverse order
- **WHEN** the newer generation has changed the fence first
- **THEN** the older attempt fails its storage CAS
- **AND** it cannot overwrite the newer state
