## Context

当前 OpenCode 注册和重连可以根据 `base_url` 自动选择最近 session, 但 AoE pane 重启需要一个可证明的精确运行时交接。  launcher 在 OpenCode server ready 前只能持有稳定 `identity_key` 和新 `runtime_generation`, ready 后才得到精确 `session_id`。  同时, launcher CLI 自己建立的 MCP 连接不是 OpenCode agent 的 MCP 连接, 因此控制面不能借 commit 把临时连接绑定为 agent。

该变更横跨 CLI、MCP schema、agent registry、delivery 派发、OpenCode HTTP 探测和异步恢复提示。  设计必须保证旧启动即使更晚完成探测, 也不能覆盖新启动已经保留的代次。

## Goals / Non-Goals

**Goals:**

- 以单调正整数 `runtime_generation` 为同一 OpenCode 身份建立启动 fence。
- reserve 在 server 启动前完成, commit 只接受相同已保留代次和精确 session。
- 控制面 commit 只更新 delivery, 不绑定调用它的临时 MCP 连接。
- commit 后由精确 OpenCode session 自己调用 key-based reconnect, 复用统一注册绑定路径。
- 在 recovering 窗口保留 mailbox 写入, 同时禁止向旧 endpoint 发 poke。
- 保留原 agent id、名称、团队、角色、模型、未读 cursor、identity key 和认证引用。
- 保证 CLI 不经 argv、日志和输出泄露 identity key, 并与 daemon 做协议握手。

**Non-Goals:**

- 不修改 AoE 仓库或其 launcher 实现。
- 不改变无 identity key 的旧 OpenCode reconnect 行为。
- 不改变 Claude、Codex 或 Kimi 的注册、重连和投递协议。
- 不在本变更中执行真实 AoE/OpenCode E2E 或发布流程。

## Decisions

### 1. 分离 fence generation 与 delivery generation

`agents.opencode_runtime_generation` 表示该身份已保留的最高启动代次。  `opencode-server` delivery payload 内的 `runtime_generation` 表示当前 endpoint 已提交的代次。  两者不能复用 daemon 内部的 `register_generation`, 因为后者负责注册并发控制, 语义和生命周期都不同。

当 fence 大于 delivery generation 时, 身份处于 `recovering`。  该状态允许消息落 mailbox, 但派发器返回 `runtime_recovering`, 且不读取或探测旧 endpoint。

备选方案是只存一个 generation, 但 reserve 会被迫提前覆盖 delivery 或无法表示恢复窗口, 因此拒绝。

### 2. reserve 与 commit 都是 launcher 控制面

`reserve_opencode_runtime` 和 `commit_opencode_runtime` 可以在未注册 MCP session 调用。  reserve 只按本机 device 和 identity key 查找身份并 CAS 推进 fence。  commit 验证 key、agent type、fence、精确 server/session 后, 以 CAS 原子提交 delivery。

commit 不调用会绑定当前 connection 的 `RegisterAgentService`。  它只修改目标 row, 所以 CLI 的瞬时 MCP session 在 commit 后调用 `get_inbox` 仍得到 `unknown_agent`。

### 3. 探测在预检查之后, 写入使用 CAS

commit 先判断代次和已提交 delivery。  incoming generation 较低、较高或同代不同 delivery 时, 在任何 HTTP 探测前返回错误。  只有候选状态有效时才探测 `GET /global/health` 和精确 `GET /session/<session_id>`。  探测完成后再次以 identity holder、fence 和旧 delivery 为条件 CAS, 防止较旧探测后完成时覆盖新状态。

同代同 delivery 是幂等成功, 允许重新触发恢复提示。  同代不同 delivery 是冲突, 不进行写入。

### 4. 恢复提示只触发 OpenCode 自绑定

delivery commit 成功后, daemon 使用既有 `prompt_async` 向精确 session 发送固定提示, 请求 OpenCode agent 从自己的环境读取 `XATS_IDENTITY_KEY`, 并调用完整形状的 `reconnect`。  提示只携带非敏感 `base_url`、`session_id` 和 `runtime_generation`, 明确设置 `noReply:false`, 永不包含 key 值。

提示任务以 `(agent_id, runtime_generation)` 为键, 每次发送前重新检查 holder、fence 和 delivery。  reconnect 成功或 N+1 reserve 会取消 N 的任务。  调度有界, commit 后提示失败返回显式部分成功, 不回滚已经正确提交的 delivery；相同代次和 delivery 的重试会安全地再次触发。

### 5. OpenCode reconnect 使用 key 定身份, runtime 字段定 delivery

key-based OpenCode reconnect 只接受完整组合 `{identity_key, agent_type:'opencode', base_url, session_id, runtime_generation}`。  identity key 是唯一身份来源, base/session 不参与身份选择。  schema 拒绝缺字段、混合其他 runtime arm、非法 URL/session 和非正安全整数。

服务验证 generation 和精确 delivery 后, 复用统一注册成功回调, 将调用 reconnect 的 OpenCode MCP connection 绑定到原 `agent_id` 和 fanout。  成功响应必须包含 `connection_bound:true`, 随后同一 connection 可调用 `get_inbox`。

兼容的 no-key OpenCode reconnect 选择到正 generation row 时, 只能在 endpoint probe 前后 snapshot 一致的情况下直接绑定现有 row, 不再调用普通注册 writer。  普通 no-generation 注册也不能覆盖或迁移正 generation OpenCode identity。  connection ledger 以 connection id 全局唯一, 改绑新 identity 时同步移除旧 identity 记录。

effective agent type 统一从显式 `agent_type` 和 delivery kind 推导。  因此, `agent_type=NULL` 且 delivery 为 `opencode-server` 的兼容 row 仍是 OpenCode, legacy reconnect 不得因原始 type 为空而误拒绝。

runtime-aware 保护覆盖所有非恢复协议 writer。  `bind_channel`、channel auto-bind、proxy reactive rebind、低层 type/delivery writer 和 Codex identity-key attach 都必须在事务内重读 row, 并拒绝改写 fence 或 delivery generation 为正数的 effective OpenCode row。  只有带完整 runtime coordinates 的恢复协议可以改变该状态。

### 6. 首次启动走普通注册

unknown key 的 reserve 返回 `need_register:true`、`state:'unregistered'` 和成功退出码, 且不写 tombstone。  AoE 可以继续启动未注册 OpenCode。  用户完成普通 `register_agent` 时, OpenCode 形状接受精确 `session_id` 和 `runtime_generation`, 在新 row 上同时设置 fence 与 delivery generation。

### 7. CLI 与 daemon 使用版本握手

两个 CLI 命令沿用 `pre-register-codex-pane` 的 pid file、port、token 和 MCP client 模式。  key 只通过 `--identity-key-env` 指定的环境变量读取, 默认 `XATS_IDENTITY_KEY`。  CLI 与 daemon 在调用中交换固定协议版本, 不匹配时 fail closed。  所有远端结果都输出实际 `host:port` endpoint, unknown flag 直接失败。

## Risks / Trade-offs

- [数据库迁移后旧 delivery 没有 generation] → 旧 row 读取为 0, 首次 reserve 以 CAS 推进到正整数并进入 recovering。
- [commit 已写库但提示发送失败] → 返回 `connection_bind_trigger_failed` 和 `delivery_committed:true`, 保留可重试的良好 delivery。
- [并发探测乱序] → 写入阶段再次校验 holder、fence 和 delivery, 旧探测 CAS 必须失败。
- [恢复提示重复] → reconnect 和 commit 都幂等, 调度按 agent/generation 去重并在状态变化时取消。
- [CLI/daemon 来自不同安装版本] → 协议握手不匹配时拒绝 reserve/commit, 禁止静默降级。

## Migration Plan

1. SQLite migration 增加 nullable/default-0 的 OpenCode fence generation。
2. delivery 解析兼容缺失 `runtime_generation` 的旧 OpenCode payload, 将其视为 0。
3. 部署同时包含 CLI 和 daemon 的同一包版本, launcher 通过握手确认兼容后再启用协议。
4. 回滚时旧 daemon 忽略新增列, 旧 delivery 仍可读取基础 session/base 字段；已进入 recovering 的 row 需要重新注册或由新版 daemon 完成提交。

## Open Questions

无。  AoE 侧环境变量注入和调用时序由对应仓库按本协议实现。
