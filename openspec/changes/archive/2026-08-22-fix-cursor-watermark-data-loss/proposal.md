## Why

daemon 每次启动都会把一部分 agent 的未读邮件**静默标记为已读**, 收件人永远看不到, 发送端也不会被告知。

`migrateAgentsCursorWatermark` (`src/storage/schema.ts`) 在每次 `applySchema` (即每次 daemon 启动) 无条件执行:

```sql
UPDATE agents
   SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)
 WHERE last_processed_event_id = 0
```

它的哨兵是 `last_processed_event_id = 0`, 而这个值同时表示两件完全不同的事:

1. **历史行** —— 游标特性落地之前注册的行。  该列自建表起就带 `DEFAULT 0`, 但当时的注册 INSERT 不列它, 于是取到默认值 0。  这类行需要推进, 否则会重放整个历史信箱。
2. **新行, 合法地停在 0** —— `register_agent` 把游标初始化为 `COALESCE(MAX(event_id), 0)`, 而**注册本身不追加 event**。  于是在 `events` 表还空着时注册的 agent, 游标就是 0, 且这个 0 是正确的。

第二类行被误伤。  用真实 `register_agent` 复现的完整链路:

```
全新 daemon (events 为空) → A 和 B 注册, 游标均为 0
  → A 发消息给 B (event_id=1)
  → daemon 重启 → 迁移把 B 的游标推到 1
  → B 的 inbox 为空, 消息静默消失
```

实测输出: `B cursor after restart = 1`, `B inbox after restart = []`。

影响是三层同时失效, 因为它们都用同一条已读判据: 消息本身对收件人不可见; `alreadyReadFn` 判定已读, **auto-poke 重试不再发**; `add-message-read-ack` 的 15 分钟未读告警也判定已读, **发送端不会被告警**。  也就是说这条 bug 恰好会关掉所有为它准备的兜底。

现有 spec 把这个行为**当成期望行为规定了下来**, 并给出一条不成立的理由 —— 它声称游标"经全新注册"就会离开 0, 而全新注册在空 events 上恰恰产出 0。  既有测试 `agents-cursor-watermark-migration.test.ts` 的第一条用例 (`advances zero cursor to MAX(event_id)`) 断言的正是这条丢消息路径。

## What Changes

- **删除 `migrateAgentsCursorWatermark`**, 不再在任何启动路径上推进游标。  `applySchema` 从此不写 `last_processed_event_id`。
- **修订 `agent-registry` 中 "Sentinel migration advances stale zero cursors on schema apply" 需求**: 由"必须运行"改为"必须不存在", 并写清哨兵值 `0` 的二义性是根因。
- **删除 `tests/agents-cursor-watermark-migration.test.ts`** 的三条断言迁移会推进游标的用例, 代之以断言 `applySchema` **不会**改动任何游标的用例, 外加一条按真实注册链路复现原缺陷的回归用例。
- **BREAKING (仅对从未跑过含该迁移之构建的陈旧库)**: 口径是构建而非启动 —— 迁移不留执行痕迹, 旧构建启动多少次都不会推进。  这类库的历史行游标停在 0, 该 agent 首次 `get_inbox` 会一次性读到积压邮件。

**为什么是删除而不是修好哨兵**:

迁移与 `register_agent` 的游标初始化是**同一个 commit** (`8f1c068`, 2026-05-08) 引入的。  它要救的那类历史行只可能在那次之前注册, 而任何**跑过含该迁移之构建**的数据库, 第一次启动就已经把它们全部推进完毕 (口径是构建不是启动: 迁移不留执行痕迹, 旧构建启动多少次都不推进)。  换言之**它的有益工作在所有跑过新构建的数据库上早已完成**, 今天剩下的唯一效果就是丢消息。

两种失败的代价也不对等: 不运行它, 最坏是某个陈旧库的 agent 一次性多读一批积压邮件 —— 有 `get_inbox` 单次页上限兜着 (注意**不是**靠 30 天保留期, 清理不在启动时跑), 是**噪音**; 运行它, 代价是**静默丢消息**。  噪音可恢复, 丢消息不可恢复。

## Capabilities

### Modified Capabilities

- `agent-registry`: 移除"哨兵迁移在每次 schema apply 时推进零游标"这一需求, 改为禁止任何启动期游标改写; 记录哨兵值 `0` 二义性这一根因, 以及 `register_agent` 在空 events 表上合法产出 0 这一事实。

## Impact

`src/storage/schema.ts` (删除 `migrateAgentsCursorWatermark` 及其在 `applySchema` 中的调用), `tests/agents-cursor-watermark-migration.test.ts` (改写)。  不动 `register_agent` 的初始化逻辑 —— 它本身是正确的。  不新增列、不新增迁移表、不引入版本标志。

本变更解除 `add-message-read-ack` 中记录的 Known limitation ("游标除 `get_inbox` 外还有第二个写入方"), 该处 spec 文字需在本变更归档时一并更新。
