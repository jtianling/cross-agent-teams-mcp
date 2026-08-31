## 1. Schema 与已读判据

- [x] 1.1 `src/storage/schema.ts`: 为 `messages` 追加 `ack_deadline_at TEXT` 与 `ack_alerted_at TEXT` 两个可空列 (新建路径写进 CREATE TABLE, 存量库走 `ALTER TABLE ... ADD COLUMN` 迁移辅助), 不设 default, 不回填
- [x] 1.2 `src/storage/schema.ts`: 加部分索引 `(ack_deadline_at)` 覆盖 `ack_alerted_at IS NULL` 的待扫描集合
- [x] 1.3 新建已读判据模块 (如 `src/mcp/message-read.ts`), 导出对单条 `(messageId, agentId)` 求 `agents.last_processed_event_id >= messages.event_id` 的函数; 接收端行不存在时返回 `false`
- [x] 1.4 `src/mcp/fanout-with-retry.ts` 的 `alreadyReadFn` 改为复用 1.3 的函数, 消除同一判据的两份 SQL

## 2. 同步等待 await_ack

- [x] 2.1 `src/mcp/send-message.ts`: `SendInput` 增加 `await_ack_s?: number`; 在 mailbox 行写入且 fan-out 完成之后, 以 250ms 间隔轮询 1.3 的判据直到命中或到期
- [x] 2.2 `src/mcp/send-message.ts`: 成功返回值增加 `ack: { status: 'read' | 'not_yet', waited_ms: number }`; `await_ack_s: 0` 返回 `not_yet` / `waited_ms: 0` 且不做任何轮询; 现有字段全部保持不变
- [x] 2.3 `src/mcp/tools.ts`: `send_message` 与 `send_message_by_id` 的 inputSchema 增加 `await_ack_s: z.number().int().min(0).max(30).optional()`, 越界在边界拒绝
- [x] 2.4 `src/mcp/tools.ts`: `SEND_MESSAGE_DESC` 与 `SEND_MESSAGE_BY_ID_DESC` 补三句红线 —— `not_yet` 不是失败且不得据此改变行为; 真未读会有独立告警主动 poke 发送端; mailbox 行在等待前已写入, 超时/报错都不代表没发出去, 不要重发

## 3. 看门狗武装

- [x] 3.1 `src/mcp/send-message.ts`: 插入 `messages` 时, `need_reply=1` 写 `ack_deadline_at = sent_at + 15min`, 否则写 NULL; 与 `auto_poke`、`await_ack_s` 完全无关
- [x] 3.2 确认 `src/mcp/broadcast.ts` 与 `src/mcp/broadcast-to-role.ts` 的插入语句保持 `ack_deadline_at` 为 NULL (它们的行已是 `need_reply=0`), 不加分支

## 4. 看门狗扫描与告警

- [x] 4.1 新建 `src/mcp/unread-watchdog.ts`: 查询 `ack_deadline_at IS NOT NULL AND ack_alerted_at IS NULL AND ack_deadline_at <= now` 的行, 对每行求已读判据
- [x] 4.2 已读 → 不告警; 未读 → 通过 `transport-dispatch.ts` 的 `dispatchPoke` 向**发送端**投递告警 (绕开 `poke()` 的 `self_poke_denied` / `cross_team_denied` / caller 存在性检查); 发送端行不存在 → 不告警
- [x] 4.3 两种结局都用 `UPDATE messages SET ack_alerted_at=? WHERE id=? AND ack_alerted_at IS NULL` 收尾, 保证并发下最多告警一次 (告警失败的处理见 8.2, 已被瞬态重试取代)
- [x] 4.4 告警文本构造: 声明"这是投递告警不是新邮件、无需 get_inbox"、`<name>@<team>`、未读时长、最后的 `skip_reason` (为空时显式写"无"), 以及"对方可能失联, 请自行决定是否接管"; 绝不含原文 body
- [x] 4.5 `src/daemon/server.ts`: 沿用现有 `cleanup` / `orphanGc` 模式挂周期扫描 (`setInterval` + `unref()`, `onClose` 时 `clearInterval`), 并在挂载时立即跑一次作为启动扫描; 扫描间隔可由 opts / 环境变量覆盖以便测试

## 5. get_delivery_status 暴露 read

- [x] 5.1 `src/mcp/delivery-status.ts`: `DeliveryStatusRow` 增加派生字段 `read: boolean`, 由 JOIN 实时算出, 不读存储列; 接收端行不存在时为 `false`
- [x] 5.2 `src/mcp/tools.ts`: `get_delivery_status` 描述补一句 —— `wake_status` 只描述 auto-poke 派发, `read` 才是收据, 两者不可互换

## 6. 测试

- [x] 6.1 schema 测试: 两列存在且可空; 存量库迁移后既有行 `ack_deadline_at` 为 NULL 且不触发告警
- [x] 6.2 已读判据测试: cursor 越过 / 未越过 / 接收端行消失三种情形; `wake_status='delivered'` 但未读时判据仍为 false
- [x] 6.3 `await_ack` 测试: 窗口内读到返回 `read`; 未读到返回 `not_yet` 且 `waited_ms` 达到窗口; `await_ack_s:0` 零轮询; `await_ack_s:31` 被边界拒绝且不产生 `messages` 行; 既有返回字段未被破坏
- [x] 6.4 武装条件测试: `need_reply` 真/假、`broadcast`、`broadcast_to_role`、`auto_poke:false` 五种情形下 `ack_deadline_at` 的期望值
- [x] 6.5 看门狗测试: 到期未读 → poke 发送端并写 `ack_alerted_at`; 到期已读 → 不 poke 但写 `ack_alerted_at`; 已写 `ack_alerted_at` 的行不再告警; 发送端消失 → 不 poke 仍写标记; 告警 poke 终态失败 → 不重试 (瞬态失败的重试见 8.5); deadline 在 daemon 停机期间过期 → 启动扫描仍告警
- [x] 6.6 告警文本测试: 含"不是新邮件"与"无需 get_inbox"语义、含 `<name>@<team>`、含 `skip_reason` (含为空时的显式标记)、不含原文 body
- [x] 6.7 工具描述测试 (照现有 `tools/list` 断言风格): `send_message` / `send_message_by_id` 含三句红线; `get_delivery_status` 含 `wake_status` 与 `read` 的区分
- [x] 6.8 `get_delivery_status` 测试: cursor 越过后 `read: true`; `wake_status='delivered'` 且未读时 `read: false`; 接收端消失时 `read: false`

## 7. 收口

- [x] 7.1 `pnpm typecheck` 通过
- [x] 7.2 跑本变更相关的测试文件 (逐文件指定, 不跑全量套件 —— 本仓库测试会触碰 tmux, 有实时 session 时全量套件有风险)

## 8. 告警瞬态失败重试 (jt 批准的范围扩展)

- [x] 8.1 `src/mcp/unread-watchdog.ts`: 定义 `ALERT_RETRY_WINDOW_MS = 10min` 与瞬态失败集合 (`guard_failed` / `kimi_session_busy` / `channel_sink_failed`); `kimi_pending_interaction` 不在其中 (等人工审批, 不会随时间自愈)
- [x] 8.2 瞬态失败且 `now < ack_deadline_at + 窗口` 时回写 `ack_alerted_at=NULL` 释放认领, 让下一轮扫描重试; 终态失败、抛异常、或超窗口则保持认领
- [x] 8.3 扫描返回值增加 `retrying` 计数; 认领仍跨越 poke 全程, 保证并发扫描不会重复告警
- [x] 8.4 工具描述与 spec 同步: 从"只尝试一次、永不重试"改为"瞬态失败重试约 10 分钟, 硬失败静默放弃"
- [x] 8.5 测试: 三种瞬态失败各自重试并在后续扫描成功; 超窗口后放弃; 抛异常按终态处理; poke 在飞期间行处于已认领状态

## 9. channel sink 失败不再伪装成成功 (jt 批准的范围扩展)

- [x] 9.1 `src/daemon/channel-wake-fanout.ts`: `send()` 在 sink 抛异常时返回 `false` 而不是吞掉后返回 `true`; sink 保持 attached (写失败不等于订阅者消失)
- [x] 9.2 `src/daemon/channel-wake-send.ts`: `SendChannelWakeResult` 增加 `sink_failed` 并透传
- [x] 9.3 `src/mcp/transport-dispatch.ts`: sink 失败时有 pane 则回退 tmux; 无 pane 则报新错误 `channel_sink_failed`, 不并入 `no_transport_available`
- [x] 9.4 `src/mcp/auto-poke-fanout.ts` + `src/mcp/tools.ts`: 新增 `channel_sink_failed` 到 `AutoPokeSkipReason` 与错误映射, 并补进两个 send 工具描述的 skip reason 清单
- [x] 9.5 新增 `specs/claude-channel-transport/` delta spec (MODIFIED fanout 契约 + ADDED 回退与 skip reason 需求), 并明写本需求**不**主张普通发送会重试 `channel_sink_failed`
- [x] 9.6 测试: fanout 三种返回值; sendChannelWake 的 `sink_failed`; 有 pane 回退 tmux; 无 pane 报 `channel_sink_failed`; 端到端 `send_message` 报 `poked:false` 且 mailbox 行照写
