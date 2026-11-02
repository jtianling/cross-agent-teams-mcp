## ADDED Requirements

### Requirement: 未启用时无外部副作用

系统 MUST 在无监控规则时不调用 remindctl, 不请求 Reminders 权限, 不创建监控轮询定时器.  系统 SHALL 保持既有 MCP 工具集合不变.

#### Scenario: 默认启动
- **WHEN** daemon 在没有规则的数据库上启动
- **THEN** 不调用 remindctl, 不创建监控轮询定时器, 既有邮箱继续正常工作

### Requirement: 动态管理与基线

系统 SHALL 提供本机 CLI 和经现有鉴权的 loopback REST 入口以添加, 查看和删除列表监控, 无需重启 daemon.  添加 MUST 使用完整列表标识与目标 team/name, 验证输入和 remindctl 输出, 仅建立基线.  规则和任务状态 MUST 持久化.  删除最后一条规则 MUST 停止监控轮询.

#### Scenario: 添加已有任务的列表
- **WHEN** 添加监控并成功读取列表
- **THEN** 所有现存任务仅作为基线, 不发送通知, 后续新增纳入监控

#### Scenario: 删除与在途读取
- **WHEN** 删除规则时该规则仍在等待 remindctl 返回
- **THEN** 返回结果不发送通知, 不恢复已删除规则

#### Scenario: 重启
- **WHEN** daemon 重启且已有持久化规则
- **THEN** 恢复监控和已知任务状态, 不重新通知已处理事件

### Requirement: 新增编辑稳定期

系统 MUST 对基线后首次出现的任务等待连续五分钟未修改才发送新增通知.  任意内容或修改时间变化 MUST 重置稳定期, 使用通知时的最终状态.  编辑等待状态 MUST 跨重启持久化.  等待期间消失的任务 MUST 不发送新增通知.

#### Scenario: 持续编辑
- **WHEN** 新任务在等待四分钟后再次修改
- **THEN** 从本次变化起重新等待五分钟, 此前不通知

#### Scenario: 稳定后通知一次
- **WHEN** 新任务连续五分钟未变化
- **THEN** 创建一条唤醒消息, 后续轮询不为相同新增重复入箱

### Requirement: 完成事件

系统 SHALL 通过独立的 completed 规则, 对已经观测到未完成的任务变为 completed 的变化立即通知.  首次基线中的 completed, 首次观测已 completed 的新任务, 标题编辑, 删除和取消完成 MUST 不触发完成通知.  新增任务的五分钟等待 MUST 仅约束 added 规则, 不延迟独立 completed 规则.  三类独立事件及 tag 的完整语义见 reminder-watch-events.

#### Scenario: 已知任务完成
- **WHEN** 已知任务由未完成变为 completed
- **THEN** 发送一条唤醒消息, 保持 completed 的后续采样不再发送

### Requirement: 内容最小化与可靠发送

系统 MUST 复用既有邮箱和自动唤醒机制, 按目标本机 team/name 解析接收者.  通知 SHALL 仅包含唤醒文案和列表标识, 不包含任务标题或备注.  邮箱写入和已通知状态 MUST 原子提交.  单条规则的权限, 输出格式, 命令超时或目标不存在错误 MUST 记录具体原因并与正常 daemon 使用隔离.

#### Scenario: 唤醒失败
- **WHEN** 邮箱已入箱但自动唤醒失败
- **THEN** 保留消息并沿用既有投递状态, 不在下一次采样重复创建消息

#### Scenario: 命令不可用或未授权
- **WHEN** 用户显式添加规则但 remindctl 不可用或未授权
- **THEN** 返回具体错误, 不自动安装或触发授权, 不创建规则, 正常消息接口仍工作
