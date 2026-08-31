## 1. 移除启动期游标改写

- [x] 1.1 `src/storage/schema.ts`: 删除 `migrateAgentsCursorWatermark` 函数本体
- [x] 1.2 `src/storage/schema.ts`: 从 `applySchema` 的调用序列中移除该迁移
- [x] 1.3 确认 `applySchema` 及其调用的所有迁移函数中, 再无任何语句写 `last_processed_event_id` (grep 校验)

## 2. 改写测试

- [x] 2.1 `tests/agents-cursor-watermark-migration.test.ts`: 删除三条断言迁移会推进游标的用例 (`advances zero cursor to MAX(event_id)` / `is a no-op on the second run` / `leaves cursor at 0 when events table is empty` 中依赖迁移语义的部分)
- [x] 2.2 换成断言 `applySchema` **不改动**游标: 零游标、非零游标、多次 apply 三种情形
- [x] 2.3 补一条端到端回归用例, 用**真实 `AgentsRepo.register`** (不用 `insertAgent` 助手) 复现原缺陷链路: 空 events 表注册 → 发消息 → 重跑 `applySchema` → 断言收件人游标仍为 0 且 `get_inbox` 能读到该消息
- [x] 2.4 补一条断言"空 events 表上真实注册产出游标 0"的用例, 钉住这个合法零值

## 3. 清理受影响的既有文字

- [x] 3.1 `openspec/changes/add-message-read-ack/specs/message-read-ack/spec.md`: 该处 Known limitation 描述的缺陷在本变更后不再存在, 改为指向本变更 (避免留下一处与事实不符的陈述)
- [x] 3.2 检查 `add-message-read-ack` 的 design/proposal 中是否有同一缺陷的其它表述需要同步

## 4. 收口

- [x] 4.1 `pnpm typecheck` 通过
- [x] 4.2 逐文件跑相关测试 (schema / agents-repo / get-inbox / cursor / message-read-ack 一组), 不跑全量套件, 不碰 `tests/tmux-cli.test.ts`
