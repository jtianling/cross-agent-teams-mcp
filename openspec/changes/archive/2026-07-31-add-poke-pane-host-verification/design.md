## Context

poke 有两类投递语义混在一起, 事故暴露的是它们的边界没画清:

1. **mailbox 行**是账目 —— 写给"注册身份", 目标离线也必须写, 这是保留期契约的一部分
2. **tmux 注入**是物理动作 —— 写给"某个终端", 而终端归属会变

`agent-registry` 现有条款 "isAgentLive MUST NOT be required for message delivery" 说的是第 1 类, 完全正确, 不能推翻.  本变更只约束第 2 类: **注入前必须确认这个 pane 现在还是它**.

现有代码里所有 tmux 注入最终都收敛到 `transport-dispatch.ts` 的 `dispatchTmux` 一个函数 (`dispatchClaude` 的 channel 回落、`dispatchCodex` / `dispatchOpencode` / `dispatchKimi` 的传统回落、`dispatchUnknown`, 以及 `poke.ts` 里无 fanout 的 legacy 分支).  因此校验只需插在这一处, 不需要在 broadcast / send_message / 重试三条路上各写一遍 —— 事故里那条**直发** `send_message` 同样中招, 正说明修复必须落在这个汇聚点而不是收件人查询上.

## Goals / Non-Goals

**Goals:**

- 一个 pane 已经不属于目标 agent 时, 绝不向它注入
- 拦截结果对发送方**可见** (skip reason), 而不是静默"投递成功"
- 存量腐坏绑定不再重新长出来 (注册期 last-writer-wins)
- 受害者侧可自查: 收到 poke 就能看出这条是发给谁的

**Non-Goals:**

- 不改 mailbox 行的写入条件 —— 目标离线照写, 保留期契约不动
- 不引入后台清扫任务
- 不试图恢复"已经投错"的历史消息
- 不解决 `unknown_agent` 失绑与审计缺口 (见 proposal 的 Out of Scope)

## Decision 1: 四级宿主校验, 首个匹配生效

按代价从低到高排, 且每级都是**可判定**的 —— 不做启发式猜测:

| 级 | 条件 | 判定 | 理由 |
|---|---|---|---|
| 1 | `device != localDevice` | **不通过** | 远端行的 pane id 是那台机器的编号, 拿到本地 tmux 上解释必然指向无关 pane.  事故现场就有 3 条这种行 (`monkeys-master@gx` 占 `%9`, 两条旧设备标签行占 `%1` / `%35`) |
| 2 | `runtime_ui_pid` 存在但进程已死 | **不通过** | 进程都没了, 这个 pane 一定不是它的.  `kill(pid, 0)` 一次系统调用, 零成本.  事故中的 tester-2 (pid 71430) 正是这一级 |
| 3 | `runtime_ui_pid` 存活 | 该 pid 的控制 tty == pane 的 `#{pane_tty}`, 或 pid == `#{pane_pid}` | 进程活着不等于还在这个 pane —— agent 可能被挪窗口.  tty 比对能判定"活进程是否真的坐在这个 pane 上" |
| 4 | `runtime_ui_pid` 为 NULL | pane 存在, **且**没有别的行在占同一 pane 且通过了 2/3 级 | codex / opencode 行合法地没有 pid, 不能一刀切拒绝.  但"另一行已被证实是这个 pane 的活宿主"时, 本行必然是陈的 |

第 4 级是唯一有残留风险的一级: 两条都没有 pid 的行占同一 pane 时无法区分谁是真的.  这一残留由 Decision 3 的 last-writer-wins 在**产生端**兜住 —— 新绑定会把旧的清掉, 所以稳态下同一 pane 不会同时存在两条无 pid 行.  事故现场的 `%7` / `%23` 就是这一类 (`opencode@default` 与 `codex@default`, last_seen 均已超一个月), 已在手工清理中一并清空.

**为什么不用 last_seen_at 窗口**: 那是 4 天粒度的可达性估计, 而 pane 接管可以发生在几分钟内.  用时间窗判物理占用是错的量纲.

## Decision 2: 校验失败是 skip, 不是 error

`pane_reassigned` 走 `poke_skip_reasons` 而不是抛错, 理由有三:

1. 与既有 `no_pane` / `guard_failed` / `tmux_unavailable` 同形, 发送方的处理代码不用改
2. broadcast 场景下单个收件人的宿主失效不该让整次广播失败
3. mailbox 行照写 —— 目标下次上线仍能读到, 这正是"漏报"的正确兜底

**不排重试**: 与 `no_pane` 同类.  重试解决的是"pane 正忙" (`guard_failed`) 这种会自愈的瞬时态; 宿主换人不会因为等 30 秒就变回来, 重试只会把误投重复三遍.

## Decision 3: 注册期 last-writer-wins

`writeAgentRow` 现在是 `tmux_pane_id = COALESCE(excluded.tmux_pane_id, tmux_pane_id)` —— **只会给自己写, 从不作废别人的**.  这就是绑定只增不减、十几个 pane 堆积 2-5 条的直接原因.

新增: 写入 pane P 时, 同事务内 `UPDATE agents SET tmux_pane_id=NULL WHERE device=? AND tmux_pane_id=? AND agent_id != ?`.

**为什么是 last-writer-wins 而不是拒绝新绑定**: 物理事实是"新进程确实占着这个 pane", 数据库应当顺从事实.  拒绝新绑定会让真正的活 agent 收不到 poke —— 把误报换成漏报, 是更差的失效模式.

必须与 `repo.register` 同事务, 否则中间态会出现"两条行都指向 P"或"两条行都没绑定".

## Decision 4: 唤醒提示带上目标身份

格式从

```
新邮件 from {sender_identifier}, 请调 get_inbox 查看
```

改为

```
新邮件 from {sender_identifier} → {target_name}@{target_team}, 请调 get_inbox 查看
```

事故里受害者的实际代价: 4 次空查 `get_inbox` (含一次 `since_event_id=0` 全量回看)、七八次无效唤醒、最终动用三个 team 联合排查 —— 全部只因为提示里没写"这条是发给谁的".  加十几个字符就能把定位成本降到一眼.

**与 Decision 1 的关系**: 校验生效后误投本就不该发生, 这条是第 4 级残留风险与未来未知路径的兜底.  两者不重复, 一个是防止发生, 一个是发生后可诊断.

**隐私**: 目标是自己时, 收到的是自己的 name/team, 无泄露.  误投时对方会看到目标的 name+team —— 这正是诊断价值所在, 且泄露面 (两个标签) 远小于误投本身已经泄露的发送方 name + agent_id.

200 字符上限不变.  但 `name` / `team` 的 schema 只有 `min(1)`, 没有长度上限, 所以上限要靠渲染端兜: 加上目标段会超过 200 字符时, 整段连同 ` → ` 分隔符一起丢掉 (不截断, 不留半截标签), 退回只带发送方的旧格式.  这与"目标行解析不到时省略整段"是同一个降级出口.

## Risks / Trade-offs

- **多一次 tmux 查询**: 第 3/4 级需要 `#{pane_tty}` / `#{pane_pid}`.  fan-out 时每个收件人一次.  缓解: 一次 `tmux list-panes -a` 拿全表, 整轮 fan-out 复用同一份快照 (`listTmuxPaneRows` 已存在); 第 1/2 级根本不查 tmux, 而腐坏行绝大多数 (事故现场 99 条中 99 条) 都在这两级被拦下
- **check-then-act 的残留窗口**: 校验与写入之间天然存在 TOCTOU.  处理方式是把最终归属复核**下沉到 quiet-guard 之后、第一次 tmux 写之前**, 且该复核是同步的、与写之间无 `await` —— 单线程事件循环下没有可插入的调度点.  剩下的窗口只有写系统调用本身, 不持锁就无法关闭, 接受.  关键是不能只在 dispatch 入口查一次: 那之后还有 pid/tty 异步查询和 `POKE_QUIET_MS` (默认 2 秒) 的 guard, 足够一次抢占落地
- **快照期内 pane 变更**: 一轮 fan-out 复用同一份 pane 快照, 快照本身可能变陈.  但注入前的归属复核读的是 DB 而非快照, 所以陈旧快照最多导致多余的 `pane_reassigned` (漏一次唤醒, mailbox 仍在), 不会导致误投
- **tmux 不可用时**: 第 3/4 级无法判定.  此时 tmux 注入本来就走不通, 归入既有的 `tmux_unavailable`, 不新增分支
- **第 4 级的残留**: 已在 Decision 1 说明, 由 Decision 3 在产生端兜住

## Migration

无 schema 变更.  存量腐坏绑定已于 2026-07-28 手工清空 104 条 (备份 `data.db.bak-panecleanup-20260728`), 清理判据与本变更的四级校验一致.  因此上线时不需要迁移脚本 —— 若在其它环境部署, 同一判据可复用为一次性清理.
