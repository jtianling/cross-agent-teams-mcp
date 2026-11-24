## ADDED Requirements

### Requirement: 持久且无副作用的交接准备
系统 MUST 仅允许本机鉴权控制请求按原 key/name/team/source type 准备交接, 捕获持久源 fence, 不改变旧 runtime.  请求重试 SHALL 幂等, 冲突必须拒绝.

#### Scenario: 准备后继续查收和重启
- **WHEN** 已准备交接且旧连接心跳或查收, daemon 重启
- **THEN** 源身份和 inbox 保留, 相同请求返回相同 fence.

### Requirement: 验证与原位原子提交
系统 MUST 验证目标 exact runtime, 并在提交事务复核源 snapshot 与代次.  SHALL 保留 agent_id/inbox/cursor, 清除旧 runtime 状态, 不把 native runtime 验证当作 pane proof.

#### Scenario: probe 期间源状态变化
- **WHEN** 新 runtime probe 等待期间其他控制请求改变源地址或代次
- **THEN** 旧 commit 返回 stale, 不覆盖新的状态.

#### Scenario: 跨类型双向交接
- **WHEN** Codex, Claude 和 OpenCode 任意两种类型交接
- **THEN** 目标验证成功后更新类型和 delivery, 相同提交幂等.

### Requirement: 旧连接与回调隔离
系统 MUST 拒绝已被交接替代的类型/地址注册及旧连接业务请求, 并维持已有 runtime fence, 防止迟到回调恢复旧 runtime.

#### Scenario: 旧 agent 在交接后重连
- **WHEN** 旧 runtime 注册或旧 MCP 连接访问新身份
- **THEN** 请求被拒绝, inbox 与新 delivery 不变.

### Requirement: 失败恢复与 managed 类型切换
系统 SHALL 提供状态及取消 pending, 不将 abort 当作回滚已提交状态.  Managed 跨类型准备 MUST 带当前 fence/新instance/准确previous_agent_type, 保留原身份并使旧token和注册代次失效.

#### Scenario: managed 探测迟到
- **WHEN** 旧 bind probe 返回前已发起新类型 prepare
- **THEN** 旧 fence 拒绝, 新目标可重试 bind, agent_id 和 inbox 不变.
