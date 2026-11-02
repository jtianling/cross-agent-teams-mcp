# Apple Reminders 列表监控

此功能按需启用, 将 Apple Reminders 列表的任务变化转为普通 xats 消息, 激活指定的本机 teammate.  消息只包含固定唤醒提示和列表 ID, 不包含任务标题或备注.  Agent 激活后自行通过 remindctl 查阅任务.

没有监控规则时, daemon 不调用 remindctl, 不申请提醒事项权限, 不启动监控轮询, 不注册监控 sender.  此功能不增加 agent-facing MCP 工具, 不要求普通 xats 使用者安装 remindctl.

## 准备

仅启用监控的 Mac 需要安装 remindctl 并由操作者显式授权.  使用 `remindctl status --json --no-input` 查看权限, 未授权时监控添加请求会返回 `reminders_not_authorized`, 不自动弹权限窗口或安装软件.  授权应在实际运行 daemon 的用户环境中完成.

通过 `remindctl list --json --no-input` 查看列表的完整 UUID.  监控使用完整 ID, 不接受模糊名称或 ID 前缀, 列表重命名不影响监控.

## 动态管理

将下面的占位参数替换为实际值:

```sh
cross-agent-teams-mcp reminders add \
  --list-id <完整列表UUID> --team <team名> --agent <teammate名> --event added
cross-agent-teams-mcp reminders add \
  --list-id <完整列表UUID> --team <team名> --agent <teammate名> --event completed
cross-agent-teams-mcp reminders add \
  --list-id <完整列表UUID> --team <team名> --agent <teammate名> \
  --event tag --tag 已审核
cross-agent-teams-mcp reminders list
cross-agent-teams-mcp reminders remove --id <监控规则UUID>
```

命令连接现有 daemon, 默认从 daemon.pid 查端口, 也可显式传 `--port` 或 `--pid-file`.  鉴权使用继承的 `CROSS_AGENT_TEAMS_MCP_TOKEN`, 不把 token 放入命令行.  `CROSS_AGENT_TEAMS_MCP_HOST` 必须是 loopback 地址或 localhost.

添加成功立即保存基线并开始后续轮询, 删除立即生效, 最后一条规则删除后停止轮询.  规则增删不需要重启 daemon.  首次升级到支持此功能的版本仍需按通常方式重启一次, 开发代码变更不会自动替换正在运行的 daemon.

删除规则也会取消它的在途读取, 不再为该规则启动剩余逐项原生查询, 已发起的系统操作可能已开始执行.  取消范围不包含其他规则或正在添加的新规则基线, 已删除规则的结果不会产生通知或使规则复活.

三类规则独立添加, 可分别指定不同 teammate, 也可对同一列表和接收者同时添加三类规则或多个不同 tag.  必须显式选择 `--event added|completed|tag`, 仅 tag 事件接受且必须带 `--tag`.  完全相同的 list/team/name/event/tag 返回 `watch_exists`.  tag 可带一个前导 `#`, 英文 ASCII 大小写不敏感, Unicode 名称进行 NFC 规范化.  标签名称不能含空白或内部 `#`.

目标以当前设备上的 team/name 解析, agent 重建后仍可收信.  使用独立系统 sender `reminder-monitor@__xats_reminders__`, 不占用接收者的业务身份.  如果存在初版的新增和完成组合规则, 首次升级会原子拆为 added 和 completed 两条独立规则并保留原快照, added 保留原规则 ID, 再次启动不会重复拆分.

## 通知行为

- 所有规则首次添加只建立基线, 不通知现存任务, 现存 completed 状态或已经存在的目标 tag.
- `added`: 后续出现的新任务必须连续五分钟没有变化才通知.  标题, 备注, 修改时间或其他导出字段变化都会重新计时, 空白标题不通知.  此规则不因完成动作单独通知, 编辑等待期间消失的任务不通知.
- `completed`: 监控任务左侧完成勾选对应的 `isCompleted` 从 false 变为 true, 在下一次扫描发现后通知, 不等待五分钟.  新任务先被观测为未完成, 随后很快被勾选完成, 也独立触发此规则.  首次观测时已经 completed 不回放.
- `tag`: 仅监控指定名称的原生 tag, 从无到有后连续 30 秒内容和修改时间不变才通知.  新任务首次出现即带该 tag 也等待 30 秒.  标题或备注中普通 `#` 文本不作为 tag 判断依据.
- tag 等待期间任何导出内容或修改时间变化都会重新计时, 即使重复添加同一 tag 导致修改时间变化也会重置.  移除 tag 或删除任务取消待通知, tag 一直存在不重复通知, 移除后重新添加允许再次通知.
- 取消完成不通知, 取消后再次完成可再次触发 completed.  同一规则的一次扫描中多个符合条件的任务合并为一条消息, 不同规则各自生成唤醒信号.

默认每轮扫描结束后等待 30 秒再开始下一轮, 所有规则串行处理, 扫描不会重叠.  新增的最短稳定期为五分钟, tag 为 30 秒, 均从观测到变化开始计算, 加上轮询与命令耗时可能进一步延迟.  两次扫描之间完成后又取消完成, 或移除后马上重新添加 tag 的瞬时变化可能无法捕获.

普通 added/completed 规则只使用 remindctl 的普通列表读取.  tag 规则额外逐项调用 `remindctl info <完整任务ID> --native --json --no-input`, 要求原生输出具备正确 id/listID 和 `tags:string[]`.  缺少 tags 或原生命令失败会明确报错, 不当作没有 tag.  大列表的原生读取会延长实际扫描周期, 不自动安装或修改 remindctl 来补能力.

规则和任务状态存储在 daemon 数据库的 `reminder_watches` 表, 包括事件类型, 目标 tag 配置, 任务 ID, 内容摘要, completed/tag 存在和去重状态及等待时间, 不存任务正文.  重启后恢复状态, 不重放已通知事件.  邮箱消息与已通知状态原子提交, 自动唤醒失败也不重复入箱, 投递状态遵循 xats 既有机制.  消息设置 `need_reply:false`, 不要求回复, 正文也不包含具体 tag 名称.

## 本机 REST 接口

接口沿用 daemon 的 token 鉴权, 并且仅允许 loopback 请求:

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/reminder-watches` | 返回 `{watches: [...]}` |
| POST | `/api/reminder-watches` | 接收 `{list_id, to_team, to_agent_name, event, tag?}`, 返回 `{watch: ...}` |
| DELETE | `/api/reminder-watches/:id` | 删除监控规则, 返回 `{ok: true}` |

查看规则可看到 `checked_at` 和 `last_error`.  读取失败保留旧基线, 下一次扫描重试; 一条规则的失败不会终止其他规则或 daemon.  目标不存在时保留未通知状态, 后续按相同 team/name 重新解析.

## 验证记录

三类独立事件与 tag 扩展的 39 个定向测试和 10 个既有邮件回归已通过, TypeScript 类型检查, 临时目录 ESM/声明构建, 编译后 CLI tag 参数验证及 OpenSpec 严格验证通过, 独立 reviewer 结论 PASS.  tester 已完成 26 项独立验收, 24 PASS, 0 FAIL, 0 BLOCKED, 2 SKIPPED, 新功能尚未部署到现有 daemon.  下方初版记录仅适用于当时的新增和完成组合规则, 不作为本轮 tag 验收的替代证据.

本轮真实验证包括三种规则的独立配置和接收者路由, 中文原生 tag, 前导 #, ASCII 大小写和 NFC 规范化, 首次基线不回放, 30 秒 tag 编辑重置及重启恢复, 新任务五分钟内完成时 completed 独立触发.  added 自然通知实际等待 348.586 秒, tag 首次通知等待 35.045 秒, 仅 lastModifiedDate 净变化重置后等待 31.620 秒.

同一 Codex thread 只能绑定一个有效投递身份, 初次模拟三个身份时 completed 有一次 skipped/no_pane, 此事实保留, 不倒算为原生激活成功.  tester 后续按阶段正常注册隔离身份, 分别实际收到 added/completed/tag 的原生唤醒并亲自调用隔离 MCP get_inbox 查收.  共八条监控消息均已查收, 后续七条 delivery 均为 delivered, 所有正文精确匹配固定文案和 list ID, 无任务或具体 tag 内容.

删除规则的取消边界也已真实补验: 修复前继续七条剩余 info 的观察保留, 修复后删除对应规则为零后续 info, 并行新增基线仍返回 201, 健康 completed 规则仍真实唤醒并查收.  最后规则删除后无通知或复活, 继续观察 65 秒无调用或新增监控定时器.  旧表迁移在 disposable 数据库上验证保留原 ID 和快照, 重复构造及真实 daemon 重启仍为两条规则, 无历史回放.

缺 tags, 错任务 ID, 错列表 ID 和坏 JSON 的四种错误另在原生 reader 边界故障注入验证, 不冒充完整真实 E2E.  跳过两类为未授权或十五秒超时分支, 以及事务中杀进程或底层 SQLite 提交故障, 不以其他测试替代.  用户已授权的 full-access 未撤销, 临时列表及九个任务, 全部规则, 隔离数据库和进程均已清理, 生产 daemon/dist/注册/claims/cursor 未改动.

[三事件验收报告](http://127.0.0.1:64709/report.html) 本机服务到期为 2026-10-31T05:32:25Z.  [离线报告及同目录原始证据](../.e2e-test/runs/reminder-watch-events-20261029-050156-f64sj45s/report.html) 包含 manifest.json, reviewed-evidence.json 和 cleanup.json.  验收清单汇总及所有引用证据文件已核对.

隔离数据库, 模拟唤醒和本地 remindctl 子进程 fixture 已覆盖状态变化, 编辑等待, 原子回滚, 动态接口, 权限失败和命令取消.  首次开发时真实 remindctl 0.3.9 的权限状态为 `not-determined`.  后续 tester 获得用户直接授权并成功申请访问权限, 使用自建临时列表和独立 daemon 完成真实验收.  19 项中 17 PASS, 0 FAIL, 0 BLOCKED, 2 SKIPPED.  现有生产 daemon 未重启, 新功能尚未部署.

初版验证结果:

| 检查 | 结果 |
| --- | --- |
| 监控, REST/CLI, 子进程边界定向测试 | 23/23 通过 |
| 既有普通直发及跨 team 邮件回归 | 10/10 通过 |
| TypeScript 类型检查 | 通过 |
| 临时目录 ESM 和声明构建 | 通过 |
| OpenSpec 严格格式校验 | 通过 |
| 独立上下文代码评审 | PASS, 删除旧扫描队列竞态已修复并复验 |
| 真实 Apple Reminders 到 agent 验收 | 已执行范围 PASS, 17 通过, 2 跳过, 无未解决失败 |

OpenSpec 实现及追加验收任务为 11/11 完成, 5/5 需求有对应实现.  默认无副作用对应 monitor.start/schedule, 动态管理与基线对应 routes/repo/add, 编辑稳定期和完成事件对应 state.advance, 内容最小化与原子发送对应 monitor.check 和 SendMessageService 的事务提交回调.  跳过项不计为通过.

真实验收发现 CLI remove 对无正文的 DELETE 携带 JSON Content-Type, 被 Fastify 以 `FST_ERR_CTP_EMPTY_JSON_BODY` 拒绝.  已修复为仅有正文时设置该 header, 并补充 CLI 请求经过实际 Fastify 解析器的回归.  修复前 RED, 修复后 GREEN.  独立 tester 于 2026-10-29T04:35:19Z 至 04:35:20Z 真实复验 add/list/remove/list 全部退出码为 0, daemon 无需重启.

真实时间线确认首次新增通知等待 314.36 秒; 首次观测约四分钟后修改备注会重置等待; 后续仅修改时间变化的任务在新计时第 289 秒仍无通知, 第 301.514 秒才通知.  五条监控消息均先由原生提示激活 tester 的真实 Codex 会话, 再由 tester 调用隔离 MCP get_inbox 查收到对应消息 ID, 投递状态均为 delivered.  重启保持基线及 pending 状态不重放, 最后规则在读取途中删除后不通知或复活, 后续观察 65 秒没有新增 remindctl 调用或监控定时器.

跳过两项为未授权状态下添加规则, 以及损坏 JSON/命令超时故障注入.  获得用户授权后没有撤销全局权限来制造未授权场景, 本轮真实导出也未注入伪造输出.  原子崩溃窗口未另行制造故障, 不将开发者回归结果算作这些真实场景的通过证据.

自建列表和全部任务已通过 remindctl 删除并核实不存在, 监控规则为 0, 隔离数据库, agent 身份, daemon 和观察进程已清理.  仅保留证据和 48 小时本机报告服务.  用户明确授权的 Reminders full-access 未撤销, 生产 daemon 和业务注册未修改.

[本机 HTML 报告](http://127.0.0.1:64426/report.html) 到期时间为 2026-10-31T04:42:35Z.  [离线报告及同目录证据](../.e2e-test/runs/20261010-expire-stale-agents/.e2e-test/runs/reminder-list-watches-20261029-042226-ofon8w2l/report.html) 长期保留, manifest.json 列出逐项结果, reviewed-evidence.json 汇总查收证据, cleanup.json 记录清理结果.
