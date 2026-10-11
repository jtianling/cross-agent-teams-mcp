## Why

`agents` 行永不过期, 生产库 331 个身份里 188 个超过 30 天没动, team `monkeys` 一次 `broadcast` 要给 133 个身份写行并尝试唤醒, 其中约 80 个早已没有对应会话.  更严重的是同一个 codex `thread_id` (或 claude `channel_session_id`) 可以同时挂在新旧两个身份上: 发给旧身份的唤醒打进新身份的会话, 而邮件写在旧身份名下, 新身份 `get_inbox` 为空 (2026-10-10, `codex-66df8c06` 与 `vercel-operator` 共用一个 thread).

## What Changes

- **投递坐标独占 (根因修复)**: 一个身份写入 `codex-appserver` 的 `thread_id` 或 `claude-channel` 的 `channel_session_id` 时, 同一事务内把同设备上其他非 proxy 行的同一坐标释放为 `delivery.kind='none'`, 后来者生效, 与 tmux pane 接管规则一致.  被释放的 codex thread 记入旧行的新列 `prev_codex_thread_id`, 供同 thread 座位继承与 identity key 跟随迁移继续当作证据使用.  被释放的 claude 行若与新持有者共用 `runtime_ui_pid`, 同时清掉该 pid, 防止 proxy 重注册时的 reactive rebind 把坐标写回去.
- **agent 行 30 天过期**: cleanup 删除 `last_seen_at` 早于 30 天的非 proxy `agents` 行, 所有设备的行同一规则.  **BREAKING**: 之前"非 proxy agent 行永不清理"的契约被取消.
- **过期身份的恢复提示**: 会话仍绑定着一个已不存在的 `agent_id` 时, `unknown_agent` 的 hint 明确说明注册记录已被移除, 引导先 `reconnect`, 返回 `need_register` 再用原 name/team 重新注册.
- **广播只发给 7 天内活跃的身份**: `broadcast` 与 `broadcast_to_role` 只给 `last_seen_at` 在最近 7 天内的成员写 mailbox 行并唤醒; 其余成员不写行不唤醒, 响应新增 `skipped_inactive` 计数.  **BREAKING**: 之前"广播不得按 `last_seen_at` 过滤"的契约被取消.
- **单发不受影响**: `send_message` / `send_message_by_id` 不看活跃窗口, 只要收件人行还在就写 mailbox 行.
- **REST 收发也算活跃**: `POST /api/send` 刷新发件人的 `last_seen_at`, `GET /api/inbox` 刷新收件人的 `last_seen_at`, 避免只走 REST 的活跃身份被过期清理.

现存的过期身份和重复坐标不做一次性手工清理, 上线后由 cleanup 和后续注册自然收敛.

假设 (jt 未单独确认): 其他设备注册来的身份行与本机行同一 30 天规则.  依据: 库里没有任何同步机制, 远端行只由远端会话自己的工具调用刷新 `last_seen_at`, 与本机行完全同构.

## Capabilities

### New Capabilities

无.

### Modified Capabilities

- `agent-registry`: 新增投递坐标独占要求; `unknown_agent` hint 区分"会话未绑定"与"注册记录已移除".
- `events-outbox`: cleanup 的 30 天规则扩展到非 proxy `agents` 行, 取消"永不清理"条款.
- `mailbox`: `broadcast` / `broadcast_to_role` 收件人限定为 7 天内活跃成员, 响应新增 `skipped_inactive`; 明确单发不受窗口影响.
- `rest-fallback-api`: `/api/send` 与 `/api/inbox` 刷新对应身份的 `last_seen_at`.

## Impact

- 代码: `src/storage/agents-repo.ts` (坐标释放), `src/daemon/cleanup.ts`, `src/mcp/broadcast.ts`, `src/mcp/broadcast-to-role.ts`, `src/mcp/tools.ts` (hint 与工具描述), `src/daemon/rest-api.ts`.
- 行为: 超过 7 天没调用过任何 xats 工具的身份收不到广播; 超过 30 天的身份被删除, 回来后需重新注册, 得到新的 `agent_id`, 未读邮件作废 (与现有 30 天邮件保留契约一致).
- 数据: 上线后第一次 cleanup (启动 1 小时后) 会一次性删除约 188 行过期身份.
- schema: `agents` 表新增可空列 `prev_codex_thread_id` (一条 `ALTER TABLE ADD COLUMN`, 与 `prev_tmux_pane_id` 同样的迁移方式).
- 不涉及 kimi / opencode 的投递坐标.
