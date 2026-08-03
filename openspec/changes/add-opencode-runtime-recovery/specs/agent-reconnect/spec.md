## ADDED Requirements

### Requirement: Identity-key OpenCode reconnect binds the owning MCP connection

`reconnect` SHALL accept the OpenCode recovery shape only as the complete set `{identity_key, agent_type:'opencode', base_url, session_id, runtime_generation}`.  `runtime_generation` MUST be a positive safe integer.  Missing fields, extra runtime identity fields, mixed reconnect arms, invalid base URLs and invalid OpenCode session ids MUST fail schema validation.

Identity key SHALL be the sole source of agent identity.  `base_url` and `session_id` SHALL identify only the exact runtime delivery.  Unknown key SHALL return `need_register` without an endpoint request or write.  A key resolving to a non-OpenCode effective type SHALL return an explicit conflict.  Stored authentication reference SHALL be used for probes and preserved without caller override.

For the same generation and identical committed delivery, reconnect SHALL be idempotent and SHALL reuse the existing registration success/binding path to bind the caller's MCP connection to the original agent id and fanout.  Success MUST return `connection_bound:true`.  Lower or superseded generations SHALL return `stale_runtime_generation` without binding.

#### Scenario: Full OpenCode shape binds and can read inbox

- **GIVEN** identity key K owns committed OpenCode delivery `(B, S, N)`
- **WHEN** the OpenCode agent's MCP connection calls `reconnect({identity_key:K,agent_type:'opencode',base_url:B,session_id:S,runtime_generation:N})`
- **THEN** the original agent id and unread cursor are preserved
- **AND** the response contains `connection_bound:true`
- **AND** `get_inbox` on the same connection succeeds

#### Scenario: Runtime coordinates never select identity

- **GIVEN** another agent owns the same cwd or a more recently updated session
- **WHEN** key K reconnects with its exact committed delivery
- **THEN** only the row selected by K can be bound
- **AND** latest-session and cwd heuristics are not used

#### Scenario: Missing or mixed OpenCode shape is rejected

- **WHEN** a key-based OpenCode reconnect omits `session_id` or `runtime_generation`, or also supplies `ui_pid` or `thread_id`
- **THEN** schema validation rejects the call before storage or endpoint access

#### Scenario: Stale prompt cannot bind

- **GIVEN** identity K has reserved generation N+1
- **WHEN** a delayed generation N recovery prompt causes reconnect
- **THEN** reconnect returns `stale_runtime_generation`
- **AND** the caller connection is not bound

### Requirement: Existing reconnect arms remain compatible

新的 OpenCode key shape 必须 (MUST) 不改变 no-key OpenCode reconnect 或 Claude, Codex 和 Kimi reconnect 的 schema 与行为。  既有 identity-key Claude/Codex shape 必须继续有效, 且不得意外接受 OpenCode-only 字段。  no-key OpenCode reconnect 选择到 fence 或已提交 delivery generation 为正数的 row 时, 必须直接绑定已验证的既有 row, 不得调用 destructive registration writer。  probe 前后必须比较 agent id, identity key, delivery pair, fence, delivery payload 和 `register_generation`, 保持 row 不变。  snapshot 变化或 row 仍在 recovering 时必须 fail closed。

#### Scenario: Legacy reconnect regression surface is unchanged

- **WHEN** existing no-key OpenCode, Claude, Codex and Kimi reconnect cases are executed
- **THEN** their prior accepted shapes, lookup rules and responses remain unchanged

#### Scenario: Legacy OpenCode reconnect 保留已提交 generation

- **GIVEN** no-key OpenCode reconnect 选择到 committed delivery generation N 等于 fence N 的 row
- **WHEN** endpoint probe 成功, 且 registration snapshot 没有变化
- **THEN** caller connection 绑定既有 agent id
- **AND** delivery generation, fence, register generation 和 identity metadata 均保持不变

#### Scenario: Effective-type legacy OpenCode row 仍可重连

- **GIVEN** 一个 `agent_type=NULL`, delivery 为 `opencode-server`, 且已提交 generation N 等于 fence N 的兼容 row
- **WHEN** no-key OpenCode reconnect 的 endpoint probe 成功, 且原始 snapshot 没有变化
- **THEN** caller connection 绑定既有 agent id
- **AND** 原始 `agent_type=NULL`, delivery, fence 和 register generation 均保持不变

#### Scenario: 单个 MCP connection 在 identity ledger 之间迁移

- **GIVEN** 一个 MCP connection 当前记录在 identity A 下
- **WHEN** 已验证的 OpenCode reconnect 把该 connection 绑定到 identity B
- **THEN** 该 connection 从 B 之外的所有 identity ledger 中移除
- **AND** 后续 takeover A 不会关闭当前属于 B 的 connection
