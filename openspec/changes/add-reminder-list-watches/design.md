## Context

xats 已有持久化邮箱及多 runtime 自动唤醒.  此功能仅提供任务变化触发源, 不传送提醒事项正文.  remindctl 已安装但本机尚未授权, 不能在默认启动路径申请权限.

## Goals / Non-Goals

目标是动态管理监控, 持久化基线和编辑等待状态, 通过普通消息唤醒指定本机 teammate.  不自动完成或修改任务, 不安装 remindctl, 不自动授权, 不新增 agent-facing MCP 工具.

## Decisions

- daemon 挂载独立 loopback REST 管理入口, CLI 提供 add/list/remove.  第一条规则创建成功后启动串行轮询, 最后一条规则删除后停止.  无配置时不运行外部命令, 不创建轮询定时器.
- 在独立 SQLite 表持久化规则和逐任务状态, 删除规则级联删除其状态.  规则用完整列表 UUID 和目标 team/name 标识, 目标在发送时解析以支持 agent 重建.
- 添加时先执行 remindctl status --json, 拒绝未授权状态, 再读取指定列表全量任务建立基线.  使用 execFile 参数数组, no-input 和超时, 不经 shell.
- 新任务的内容指纹发生变化就重置 stable_since, 连续五分钟稳定后由 added 规则通知.  指纹包括 remindctl 提供的修改时间和内容, 数据库只保存摘要, 不存标题或备注.  根据后续用户明确的独立事件要求, completed 规则对已观测到未完成任务的 false→true 变化即时通知, 不受 added 五分钟等待影响.  三类独立规则与 tag 扩展见 add-reminder-tag-watches.
- 消息正文只包含固定唤醒文案和列表标识, 不含任务内容.  复用 SendMessageService, 使用独立系统 team 的内部 sender, 无监控时不注册 sender.
- 发送时以同一 SQLite 事务提交邮箱记录和对应状态, 避免唤醒耗时或进程重启导致重复入箱.  唤醒失败仍遵循已有消息投递语义, 不重复创建消息.
- 删除规则后在途读取结果作废.  不同规则串行处理, 单条错误记录具体原因并隔离, 不导致 daemon 退出.  退出时取消外部命令, 在数据库关闭前等待轮询结束.

## Risks / Trade-offs

- 轮询可能遗漏两次采样之间完成后又取消完成的变化.  默认 30 秒采样, 新增通知至少等待实际观测到的五分钟稳定期.
- Apple 权限授权需要操作者明确进行, 未授权时创建规则失败并解释原因, 不弹权限窗口.
- remindctl 输出格式可能变化, 使用 schema 验证, 格式错误不能当作空列表或更新基线.
- 新版本部署需要重启 daemon 一次, 此后的规则增删不需要重启.
