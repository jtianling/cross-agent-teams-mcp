## ADDED Requirements

### Requirement: challenge 与启动授权同范围

daemon MUST 将每个 challenge 限定到签发时的 pane, launch UUID 和预登记期限, 不保存或公开 identity_key.  到期 challenge MUST 不再提供 pane 关联授权, 不得被标记为已送达有效 token.  新启动或重新预登记 MUST 使旧 challenge 无效.

#### Scenario: delivered 后到期
- **WHEN** challenge 已送达, 预登记截止时间到达后模型才回传
- **THEN** 明确报告 challenge_expired 或当前已无有效 challenge, 不写入该启动的 pane/thread 完成快照

#### Scenario: 原 pane 换启动
- **WHEN** 同一 pane 已由另一 launch 或更新后的预登记接管
- **THEN** 旧 challenge 不得绑定新启动, 不能消费新预登记

### Requirement: 身份注册和启动绑定分别报告

Codex 注册成功响应 SHALL 保留已有字段, 并增加 launch_binding 状态.  系统 MUST 仅在当前注册验证且匹配持久化启动证据时报告 bound.  未完成时 SHALL 返回 unbound 和明确 reason, 即使原生投递注册成功也不得隐藏.  过期或无效 challenge SHALL 提示由启动器重新预登记取得新 challenge, 不建议用 cwd, 历史 seat 或 loaded threads 推断绑定.

#### Scenario: 原生投递成功但 pane 绑定过期
- **WHEN** 身份及原生投递注册成功, 启动绑定因预登记过期失败
- **THEN** 返回 agent_id 等已有字段及 unbound 原因和重试提示, 不误报 launch bound

### Requirement: 安全重新预登记和提交

重试 MUST 保留现有前台 carrier, 完整 launch UUID, identity 所有权和注册 generation 校验.  异步验证跨过 TTL 后 MUST 不提交过期预登记.  正常重新预登记后只有新 challenge 能完成当前启动绑定, 过期 nonce 不得回填数据库或延长旧授权.

#### Scenario: 过期后安全重试
- **WHEN** 启动器重新预登记当前仍可验证的启动, 并由模型回传新 challenge
- **THEN** 正常验证和原子消费成功后持久化精确 pane/launch/thread 绑定, 旧 challenge 不能消耗新记录

#### Scenario: 验证期间到期
- **WHEN** carrier 异步验证返回前预登记到期
- **THEN** 不绑定或消费该记录, 反馈未完成状态

### Requirement: 可审计且不触碰生产

错误日志 MUST 记录具体绑定阶段和机器原因, 不记录 token/key 或聊天内容.  本次回归与验收 MUST 使用隔离数据库和模拟或独立环境, 不重启共享 daemon 或操作现有业务线程.

#### Scenario: 无效 challenge
- **WHEN** 调用者提供未知或已消费 challenge
- **THEN** 明确未绑定, 日志不回显 challenge 内容, 现有其他启动不受影响
