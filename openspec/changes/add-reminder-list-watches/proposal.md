## Why

用户希望通过 Apple Reminders 的任务变化唤醒指定 xats teammate.  未使用此功能的人不应承担权限申请, 外部命令调用或轮询的副作用.

## What Changes

- 添加可在 daemon 运行期间动态创建, 查看和删除的列表监控规则.
- 通过 remindctl 读取列表, 首次仅建立基线, 后续新增和完成任务发送普通 xats 消息并自动唤醒.
- 持久化规则与任务状态, 重启继续监控, 删除最后一条规则停止轮询.
- 独立 CLI 和 loopback REST 管理入口, 不添加常驻的 agent-facing MCP 工具.

## Capabilities

### New Capabilities

- `reminder-list-watches`: Apple Reminders 列表的动态监控, 状态比较和消息通知.

### Modified Capabilities

无.

## Impact

新增提醒事项模块, 在 daemon 生命周期与 CLI 中加入薄集成.  复用已有 SendMessageService 和唤醒链路.  不新增 npm 依赖, remindctl 仅在显式启用监控时需要, 不自动安装或请求授权.
