## 1. 投递坐标独占

- [x] 1.1 在 `src/storage/agents-repo.ts` 新增私有方法 `releaseDeliveryCoordinate(keepAgentId)`: 仅处理 `codex-appserver` (按 `thread_id`) 与 `claude-channel` (按 `channel_session_id`), 同设备, 跳过 proxy 行, 把其他行置为 `delivery_kind='none'` / payload NULL; claude 行的 `runtime_ui_pid` 与 keeper 相同且非空时一并置 NULL
- [x] 1.2 在 `register` 的事务内 (本次写入了 delivery 时) 调用它
- [x] 1.3 在 `setDelivery` 的事务内调用它
- [x] 1.4 新增 `tests/agents-repo-delivery-coordinate-exclusivity.test.ts`, 覆盖 agent-registry delta 的全部 scenario (codex 接管, claude 接管并释放 ui_pid, proxy 双向豁免, 跨设备不动, 幂等, 经 `register` 与经 `setDelivery` 两条路径)
- [x] 1.5 跑现有相关测试确认无回归: `agents-repo-pane-exclusivity`, `agents-repo-reactive-rebind`, `bind-channel`, `auto-bind-channel`, `register-agent-rename-releases-claim`, `reconnect-codex-launch`, `agents-repo-find-by-codex-thread-id`
- [x] 1.6 `src/storage/schema.ts`: `agents` 新增可空列 `prev_codex_thread_id` 及幂等迁移
- [x] 1.7 释放 codex 坐标时把 thread 记入 `prev_codex_thread_id`; 该行再次写入 delivery (`register` upsert, `setDelivery`) 时清空
- [x] 1.8 `findRuntimeByThread` 与 `findKeyHoldersBySeat` 把 `prev_codex_thread_id` 视同当前 thread; `findByCodexThreadId` 不变
- [x] 1.9 测试: 被释放行仍是同 thread 证据, 重新持有 delivery 后清空, claude 行不记录, 旧库迁移; 现有 `register-agent-same-thread-precedence`, `register-agent-seat-follow`, `codex-seat-follow-recovery`, `agents-repo-find-runtime-by-thread` 全部通过
- [x] 1.10 proxy 注册的 reactive rebind 之后收敛: 同一 csid 只留给 `last_seen_at` 最新的非 proxy 行, 其余释放; reactive rebind 与 opencode CAS 写 delivery 时清 `prev_codex_thread_id`; 补测试 (proxy 注册后只有一个持有者, 被释放身份的唤醒不再打进 thread)

## 2. agent 行 30 天过期

- [x] 2.1 在 `src/daemon/cleanup.ts` 的事务内, proxy GC 之前, 删除 `role != '__channel_proxy__' AND last_seen_at < cutoff` 的 `agents` 行, 并计入 `deleted`; 更新文件顶部注释
- [x] 2.2 更新 `tests/events-cleanup.test.ts` 中"非 proxy 行永不删除"的断言, 新增: 31 天删除, 29 天保留, `registered_at` 不参与判定, 非本机 device 同样删除, 引用过期 agent 的近期邮件保留
- [x] 2.3 跑 `tests/cleanup-channel-proxy-gc.test.ts` 与 `tests/cleanup-interval.test.ts`, 按新语义修正受影响的断言

## 3. 过期身份的恢复提示

- [x] 3.1 在 `src/mcp/tools.ts` 新增 `EXPIRED_AGENT_RECOVERY_HINT`, `requireAgent` 在"会话有 caller 但行不存在"时返回它, "会话无 caller"时保持原文案; 未绑定的判定为 caller 为空或等于 session id (注册前 `caller()` 返回 session id)
- [x] 3.2 新增或扩展测试: 绑定后删除该 agent 行再调用 `get_inbox`, 断言 hint 提到注册已移除, 30 天, `reconnect`, `register_agent`, 且不含 "registration persists"

## 4. 广播活跃窗口

- [x] 4.1 新增共享常量 `FANOUT_ACTIVE_WINDOW_MS` (7 天) 及 cutoff 计算, 供两个 fan-out service 使用
- [x] 4.2 `src/mcp/broadcast.ts`: 收件人查询加 `last_seen_at >= cutoff`, 统计被排除人数, 成功响应加 `skipped_inactive`, 无活跃收件人时返回 `unknown_recipient` (有人被排除时带 `skipped_inactive`)
- [x] 4.3 `src/mcp/broadcast-to-role.ts`: 同上
- [x] 4.4 更新 `src/mcp/tools.ts` 中 `broadcast` / `broadcast_to_role` 的工具描述: 只发给 7 天内活跃成员, 说明 `skipped_inactive`, 说明 `send_message` 不受窗口影响
- [x] 4.5 更新 `tests/broadcast-auto-poke.test.ts`, `tests/broadcast-to-role.test.ts` 及其他断言"空闲成员也收到广播"的测试; 新增窗口内外, 边界, 全员不活跃, `get_inbox` 后重新进入窗口的用例
- [x] 4.6 新增测试: 对 `last_seen_at` 为 20 天前的收件人做 `send_message` 与 `send_message_by_id`, 断言 mailbox 行写入且 `get_inbox` 可读到

## 5. REST 收发计为活跃

- [x] 5.1 `src/daemon/rest-api.ts`: `handleSend` 成功后 touch 发件人, `handleInbox` 成功后 touch owner
- [x] 5.2 在现有 REST 测试中新增三个 scenario 的断言 (send 刷新, inbox 刷新, `/api/agents` 不刷新)

## 6. 收尾

- [x] 6.1 `pnpm typecheck` 通过
- [x] 6.2 跑本次涉及的测试文件全部通过 (逐文件 `pnpm vitest run tests/<file>`; 有实时 tmux session, 不跑会操作真实 tmux 的用例, 不对生产库做写操作)
- [x] 6.3 `CHANGELOG.md` 增加条目, 标注两处 BREAKING (agent 行 30 天过期, 广播 7 天活跃窗口)
- [x] 6.4 `openspec validate expire-stale-agents-and-scope-broadcast --strict` 通过
