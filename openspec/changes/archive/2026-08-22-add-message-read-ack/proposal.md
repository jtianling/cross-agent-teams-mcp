## Why

`send_message` 返回的 `poked: true` 不证明消息被收到, 但调用方普遍把它当成"送到了"。

`poked` 的真实含义是"wake-up 派发调用没有抛错", 而这在各 transport 之间强弱悬殊: tmux 分支只证明 `send-keys` 把字符写进了 pane, 不证明那个 pane 此刻是个在听话的 TUI 输入框; claude-channel 分支更弱 —— `ChannelWakeFanout.send()` 把 sink 抛出的异常整个 `catch {}` 吞掉后仍然 `return true`; kimi / opencode 分支只证明 HTTP 被 server 接受。  真正"接收端把消息读进了上下文"这一层, daemon 从不回答。

后果是工作流静默卡死。  xats 的设计是 poke 驱动、不轮询, 所以发送端发完就结束回合去睡, 等着被回复的 poke 叫醒。  一旦接收端其实没醒 (pane 被别人顶了、agent 行是重启后残留的陈旧记录、poke 落进了正在跑 turn 的 TUI 被吞掉), **没有任何东西会再来叫醒发送端** —— 它不是在循环里等, 它是睡死了, 直到人发现为止。

而判断"真的读到了"所需的数据其实一直在库里: `get_inbox` 在同一事务里推进 `agents.last_processed_event_id`, 于是 `cursor >= messages.event_id` 就是一个 transport 无关、无法伪造 (必须接收端的 agent loop 真的跑起来调了一次工具) 的收据。  `fanout-with-retry.ts` 的 `alreadyReadFn` 已经在用这条 SQL 做重试抑制, 只是从来没有把结论回给发送端。

## What Changes

本变更把这条已存在的收据接出来, 分同步与异步两条, 语义分工严格划开: **同步那条只回答"现在读了吗", 永远不下判决; 异步那条是唯一的判决者。**

- **(A) `send_message` / `send_message_by_id` 新增 `await_ack_s` 同步等待**, 默认开启, 默认 10 秒, 上限硬卡 30 秒。  等待期间轮询 `cursor >= event_id`, 返回 `ack: { status: "read" | "not_yet", waited_ms }`。
  - 上限卡 30 秒是为了不超过发送端 harness 的工具超时。  超时会让发送端看到一个工具错误, 而 mailbox 行其实早已写入 —— agent 极可能据此重发, 对面收到两条。
  - **`not_yet` 不是 timeout, 不是 failed, 不是判决**。  正因为有 (B) 兜底, (A) 可以非常没耐心: 快乐路径 (对方空闲) 1~3 秒就绿, 不 happy 就立刻放行。  工具描述必须写死这一点, 否则 agent 会把只等了 10 秒的 `not_yet` 读成"对面挂了"而去接管工作, 制造出比现状更贵的假阴性。
- **(B) 15 分钟未读看门狗**。  到期时若 cursor 仍未越过 `event_id`, daemon 主动 poke **发送端** 一条自包含告警, 携带最后的 `skip_reason`。
  - 挂载条件是 `need_reply=true` 的 `send_message` / `send_message_by_id`。  `broadcast` / `broadcast_to_role` 一律不挂 —— 它们的行本来就是 `need_reply=0`, 广播天然是 FYI 语义, 5 个人里 3 个没读就发 3 条告警纯属噪音。
  - 告警文本**绝不能长得像新邮件**。  现有 poke 模板是 `新邮件 from X → Y, 请调 get_inbox 查看`; 告警若沿用, 发送端醒来会白跑一次空 `get_inbox`。  必须写明这不是新邮件、无需 `get_inbox`, 并带上 `skip_reason` —— 它让发送端能区分 "pane 被顶了, 需要人介入重注册" 与 "poke 全成功但对方 agent 卡死"。
- **看门狗必须持久化, 不能用 `setTimeout`**。  现有 `poke-retry.ts` 的调度是纯内存 `retryMap` + `setTimeout`, 没有落库也没有启动扫描, daemon 一重启全部静默蒸发。  现在这个洞只有 10 分钟宽 (最后一次重试); 15 分钟的窗口撞上一次重启, 本特性就会在它最该生效的场景里**自我失效**, 而且比现状更糟 —— 发送端会因为信任这个保底而更放心地去睡。  因此 `messages` 增列 `ack_deadline_at` 与一个已告警标记, daemon 启动时与周期性扫描到期未读行。
- **存储面尽量为零**: "已读"不落库、不在 `get_inbox` 插钩子, `get_delivery_status` 新增**派生**字段 `read: boolean`, 用 JOIN 实时算出。  唯一需要持久化的是 deadline 本身。
- **告警的瞬态失败会重试** (评审后追加的范围)。  告警走普通 poke 路径因而过静默守卫, 发送端只是恰好在干活就会 `guard_failed` —— 若就此放弃, 等于为最平常的理由丢掉这条兜底。  `guard_failed` / `kimi_session_busy` / `channel_sink_failed` 判为瞬态: 释放认领让下一轮扫描重试, 以 `ack_deadline_at + 10 分钟` 为界 (对齐既有重试阶梯 30s/180s/600s 的总跨度)。  终态失败、抛异常、超窗口则落定。  不需要计数器 —— 窗口由已存的 deadline 推出。
- **channel sink 抛异常不再上报成功** (评审后追加的范围)。  `ChannelWakeFanout.send()` 原本 `catch {}` 后照样 `return true`, 这是全 daemon 最弱的"已送达"信号, 也正是本提案开篇点名的病根。  改为如实返回 `false`; 有 pane 则回退 tmux, 无 pane 则报新的 `channel_sink_failed` 而不是并入 `no_transport_available`。

**明确不做**:

- 不做回复追踪。  `messages` 没有 `in_reply_to`, 本变更也不加。  "读到了"是"对方是不是死了"的判据, "回了没"是"对方是不是靠谱"的判据 —— 卡死主要来自前者, 后者会把范围撑大一倍。
- 不保证告警必达。  瞬态失败会在 10 分钟窗口内重试, 但终态失败、以及认领与释放之间进程崩溃, 都会静默放弃该告警; 告警的结局只进 daemon 日志, 不可查询。  发送端刚活过又彻底死掉 (含对方 coding plan 打满) 这类场景本变更不覆盖。
- 不给 `broadcast` / `broadcast_to_role` 增加 `need_reply` 参数。
- 不顺带把现有 poke 重试迁到持久化调度。  同一病灶, 但独立 scope, design 里点名即可。
- 不让普通发送重试 `channel_sink_failed`。  重试阶梯只调度带 pane 的 `guard_failed` 与 `kimi_session_busy`, 无 pane 的 channel 目标两者都不沾; 兜底是 mailbox 行照写 + 15 分钟未读告警。
- 不修 `migrateAgentsCursorWatermark` 那个既有缺陷 (daemon 启动会把合法停在 0 的游标推到 `MAX(event_id)`, 令未读邮件被判已读)。  它会削弱本变更的判据, 由 `fix-cursor-watermark-data-loss` 单独处理。

## Capabilities

### New Capabilities

- `message-read-ack`: 已读的推导式定义与不可伪造性; `await_ack` 的同步等待契约与 `not_yet` 的语义红线; 15 分钟看门狗的挂载条件、跨 daemon 重启存活的持久化调度、以及告警 poke 的文本要求。

### Modified Capabilities

- `mailbox`: `messages` 表增列 `ack_deadline_at` 与已告警标记; 放宽 "Fire-and-forget delivery contract" 的同步返回口径以容纳 `await_ack` 等待窗口; 修订 "send_message carries reply expectation" 中 `need_reply` 不得影响投递行为的中立性约束, 为看门狗挂载开一个明确的例外; `get_delivery_status` 返回值增加派生字段 `read`。
- `claude-channel-transport`: `ChannelWakeFanout.send()` 由"吞掉 sink 异常仍报成功"改为如实返回 `false` 且保持 sink attached; `sendChannelWake` 的失败结果增加 `sink_failed`; 新增 sink 失败时的 tmux 回退与 `channel_sink_failed` skip reason 契约。

## Impact

`src/mcp/send-message.ts` (等待窗口与 deadline 写入), `src/mcp/delivery-status.ts` (`read` 派生字段), `src/storage/schema.ts` (`messages` 增列 + 迁移), `src/mcp/tools.ts` (`send_message` / `send_message_by_id` 的 `await_ack` 入参与描述文本、`get_delivery_status` 描述), 以及一个新增的持久化看门狗扫描模块及其在 daemon 启动路径 (`src/daemon/server.ts`) 的挂载。  `src/daemon/channel-wake-fanout.ts` 与 `src/daemon/channel-wake-send.ts` (sink 失败如实上报), `src/mcp/transport-dispatch.ts` (sink 失败的 tmux 回退与 `channel_sink_failed`), `src/mcp/auto-poke-fanout.ts` (新 skip reason), `src/mcp/poke.ts` (抽出共用派发段并新增 daemon 自发的 `pokeAsDaemon`)。  `poke-retry.ts` 不改。  对应单元测试。

**一处用户可见的行为变化**: 同时绑定 channel 与 tmux pane 的 claude 目标 (即绝大多数 claude-code agent), 在 channel sink 抛异常时现在会**落到 tmux 回退**, 于是唤醒从"channel 通知"变成"pane 里粘出提示", 并多花一次静默守卫的等待。  以前这种情况被静默当作成功, 什么都不做。  这正是本变更想要的效果 (真投递取代假成功), 但它是唯一一处普通用户能直接看出来的差异, 在此点明以免被误认为 bug。
