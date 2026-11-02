## Why

agent 需要像闹钟一样在指定时刻或周期自动唤醒, 无需另一个业务 agent 代发消息.  计划应成为可动态管理的持久标准能力.  

## What Changes

- 增加一次性, 固定间隔, 每日, 每周及每月计划, 支持明确时区和有限或无限触发次数.  
- 增加本机 CLI 和 HTTP 管理, 支持幂等创建, 查询, 修改, 暂停, 恢复及删除.  
- 使用系统身份发送提示, 保留最近执行结果, 区分唤醒投递和 inbox 读取.  
- 同计划未读事件合并, 重启保留计划且不集中补发循环 tick.  无计划不启动调度定时器.  

## Capabilities

### New Capabilities

- `scheduled-agent-wakes`: 持久计划, 日历计算, 动态管理及系统唤醒.  

### Modified Capabilities

无.  

## Impact

增加 `src/schedules/`, 复用 SQLite 和 SendMessageService, 薄集成 daemon 与 CLI.  不新增依赖或 MCP 工具, 不修改原有消息契约, 不重启共享服务.  
