## Context

- `agents` 表没有任何外键引用 (`messages` / `message_delivery_status` / `events` 里的 agent id 都是纯文本), 删行不会破坏约束.
- 投递写入只有三个入口, 都在 `src/storage/agents-repo.ts`: `register` (经 `writeAgentRow`), `setDelivery`, 以及 proxy 注册时的 `reactiveRebindHosts`.  已有的 pane 独占由 `clearPaneBinding` 在同一事务里完成, 是本次坐标独占的直接范本.
- `releaseIdentityClaim` 已经实现过"身份 key 迁走时释放旧行的 delivery 与 ui_pid", 但只在带 `identity_key` 且判定为 migrate 时触发, 没带 key 的重命名注册不会释放.
- `last_seen_at` 只有两个写入点: 每次 MCP 工具调用后的 `touchIfRegistered` (已覆盖 `get_inbox`), 以及注册时的 upsert.  REST 路由从不刷新.
- cleanup 每小时跑一次, 启动时不跑.

## Goals / Non-Goals

**Goals:**

- 同设备上一个 codex thread / claude channel session 只挂在一个非 proxy 身份上.
- 30 天没活动的身份自动删除, 回来时得到明确的恢复指引.
- 广播只触达 7 天内活跃的身份, 单发不受影响.

**Non-Goals:**

- 不处理 kimi / opencode 的投递坐标 (它们已有各自的 generation / CAS 机制, 也没有出现本次的问题).
- 不做存量数据的一次性清理或迁移脚本.
- 不改 `reconnect` 对存量重复坐标返回 `ambiguous` 的行为, 也不改 codex launch reconnect 的 `codex_thread_conflict` 预检.
- 窗口天数不做成可配置项.

## Decisions

### D1: 坐标释放放在 repo 层, 与写入同事务

在 `AgentsRepo` 新增私有方法 `releaseDeliveryCoordinate(keepAgentId)`: 读出 keeper 行的 `device / role / delivery / runtime_ui_pid`, keeper 是 proxy 或 delivery 不属于 `codex-appserver` / `claude-channel` 时直接返回; 否则一条 `UPDATE` 把同设备, 非 proxy, 同 kind, 同坐标, `agent_id != keeper` 的行置为 `delivery_kind='none', delivery_payload=NULL`.  在 `register` 的事务末尾 (写了 delivery 时) 和 `setDelivery` 的事务内调用.

备选: 在各个 service (`register-agent`, `bind-channel`, `auto-bind-channel`) 里分别调用.  放弃, 因为入口有 8 条以上, 漏一条就复现原 bug; repo 层只有两个写入点.

### D1a: 被释放的 codex thread 记入 prev_codex_thread_id

codex 行上的 `thread_id` 原本身兼两职: 唤醒投递的地址, 以及"这一行曾在这个会话里"的证据.  同 thread 座位继承 (`findRuntimeByThread`) 和 identity key 跟随迁移 (`findKeyHoldersBySeat` 返回的 `codex_thread_id`) 都在注册 upsert 之后读旧行的 thread.  直接清掉会让改名重注册的 codex 丢座位, key 留在旧名字上.

所以释放 codex 坐标时, 同一条 `UPDATE` 把 thread 写进旧行的 `prev_codex_thread_id`; 该行之后自己再写入任何 delivery 时清空.  两条证据查询改为"当前 thread 或 `prev_codex_thread_id` 等于目标".  按 thread 找当前持有者的 `findByCodexThreadId` 不看这一列, 所以地址仍然唯一.  这与 pane 被接管时清 `tmux_pane_id`, 记 `prev_tmux_pane_id` 是同一个模式.

备选 1: 不动旧行, 在唤醒投递时按 `last_seen_at` 判断谁是当前持有者并跳过旧身份.  放弃: 重复状态仍在, 持有者靠推断, `reconnect` 的歧义也不解决.
备选 2: 在 register 事务内先取证据再释放, 以内存值传给两条流程.  放弃: 改名链 A→B→C 中更早被释放的行不再是证据, 且要改两条安全相关流程的调用方式.

### D2: claude 行同时释放相同的 runtime_ui_pid

`reactiveRebindHosts` 按 `(device, runtime_ui_pid, team)` 给所有匹配的 host 写 csid.  同一个 Claude 进程改名注册后, 旧行仍带着同一个 `runtime_ui_pid`, 只清 delivery 的话下一次 proxy 重注册会把 csid 写回旧行.  所以释放 claude 坐标时, 旧行的 `runtime_ui_pid` 若等于 keeper 的非空 `runtime_ui_pid`, 一并置 NULL.  这与 `planIdentityClaimRelease` 的 `releaseUiPid` 规则同构.

`reactiveRebindHosts` 的 SQL 不改, 但它写完后在同一事务里做一次收敛: 取该设备上持有这个 csid 的非 proxy 行里 `last_seen_at` 最新的一行作为持有者, 对它调用 `releaseDeliveryCoordinate`.  原因: 旧行 delivery 为 `none` 时不会被前面的释放命中, `runtime_ui_pid` 还在, proxy 注册会把 csid 同时写给新旧两行.  同一个 Claude 进程同一时刻只用一个身份, 它的工具调用只刷新当前身份的 `last_seen_at`, 所以最新者即当前身份.

### D3: 过期删除只删 agents 行

cleanup 事务里新增一条 `DELETE FROM agents WHERE role != '__channel_proxy__' AND last_seen_at < ?`, 放在 proxy GC 之前 (host 行先删, 它的 proxy 在同一轮就满足"无人引用"而被回收).  不删引用该 agent 的邮件: 没有外键, 这些行 30 天内自行过期, `get_inbox` / `get_delivery_status` / 未读看门狗都已经用 LEFT JOIN 容忍缺失的 agent.

不释放内存态 (连接绑定, SSE fanout, poke 重试计时器): 一个 30 天没调用过任何工具的会话即使还连着, 下一次调用会在 `requireAgent` 得到 `unknown_agent`; poke 重试对缺失行已返回 `unknown_agent`.

### D4: hint 在 requireAgent 一处区分两种情况

`requireAgent` 是所有业务工具的统一入口.  注意 `caller()` 在注册绑定之前返回的是 MCP session id, 所以"未绑定"的判定是 caller 为空或等于 `getSessionId()`; caller 是真实 agent id 而行查不到才是"已过期".  新增一个 `EXPIRED_AGENT_RECOVERY_HINT` 常量用于后者, 前者文案不变.  其余零散的无 hint `unknown_agent` 产出点不动.

### D5: 广播过滤用 SQL 条件 + 计数

两个 service 的收件人查询加上 `last_seen_at >= ?` (cutoff = now - 7d 的 ISO 字符串; 库里的时间戳都由 `toISOString()` 写入, 字典序即时间序), 再用一条 `COUNT(*)` 得到被窗口排除的人数.  窗口常量 `FANOUT_ACTIVE_WINDOW_MS` 放在一个共享小模块里, 两个 service 共用.

没有活跃收件人时返回 `{ error: 'unknown_recipient' }`, 仅当有人被窗口排除时附带 `skipped_inactive`.

备选: 复用 `isAgentLive` / `online`.  放弃: 它依赖 tmux pane 列表 (异步调 tmux) 和进程存活, 会把暂时没连上的正常 agent 漏掉, 而且 spec 明确要求 fan-out 不按 `online` 过滤.

### D6: REST 收发刷新 last_seen_at

`handleSend` 在 service 成功后 `agents.touch(fromRow.agent_id)`, `handleInbox` 同理 touch owner.  不这样做的话, 只走 REST 的活跃身份会在 30 天后被删.  kimi commit 等 `/api/runtime/*` 路由按现有契约继续不刷新.

## Risks / Trade-offs

- [上线后首轮 cleanup 一次性删除约 188 行] → 这正是预期的自然清理; 单条 DELETE 在同一事务里, 可回滚.  被删身份回来时由新 hint 引导重新注册.
- [会话一直连着但 30 天没调用任何工具的身份会被删, 即使它还能收到 channel 唤醒] → 已由 jt 接受; 这类身份 7 天后已经收不到广播, 单发的唤醒到达后它调用 `get_inbox` 就会刷新 `last_seen_at`, 所以真正在用的身份不会走到 30 天.
- [离开超过 7 天再回来的身份看不到期间的广播] → 已由 jt 接受; 广播是 `need_reply=false` 的通知.
- [存量的重复坐标在旧行过期或新身份下次注册前仍然存在] → 已由 jt 决定不手工清理; 旧行满 30 天无活动后由 cleanup 删除.
- [把坐标让给后来者, 理论上一个错误自报 thread_id 的会话能夺走别人的投递] → 与现有 pane 接管, 同名重注册的信任模型一致 (本机 loopback 信任); codex 的 launch reconnect 仍保留冲突预检.

## Migration Plan

schema 只新增可空列 `prev_codex_thread_id`, daemon 启动时自动迁移.  回滚到旧版本不需要数据修复: 旧版本忽略多出的列, 被删的身份重新注册即可.

## Open Questions

无.
