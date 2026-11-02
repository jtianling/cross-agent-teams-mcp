## Why

任务新增, 勾选完成和添加审核 tag 需要触发不同 teammate.  用户要求三类监控可独立添加, tag 编辑稳定期只需 30 秒, 不沿用新增任务的五分钟.

## What Changes

- 规则显式选择 added, completed 或 tag, 分别指定接收者, 可同时监控同一列表.
- tag 规则监控指定名称的原生 Reminders tag, 首次仅建立基线, 后续添加且连续 30 秒未修改才发固定唤醒信号.
- completed 使用任务左侧勾选对应的 isCompleted false→true 变化, 不受新增任务五分钟等待影响.
- 使用 remindctl 的原生 tag 读取能力, 普通 added/completed 规则不调用原生 tag 接口.

## Capabilities

### New Capabilities

- `reminder-watch-events`: 三类独立规则, tag 稳定期, 持久化与迁移.

### Modified Capabilities

无主规格修改.  本 change 在尚未归档的 add-reminder-list-watches 实现上演进, 三类独立规则替代其原来新增和完成合并的创建接口.

## Impact

限于 src/reminders, 对应测试和文档.  CLI/API 创建规则需显式 event, tag 事件需 tag 名称.  不改普通 xats MCP 工具或既有消息内容.  原有组合规则如存在则原子拆成两个独立规则并保留快照.
