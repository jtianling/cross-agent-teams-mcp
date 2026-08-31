## Context

`send_message` 今天返回的 `poked` 来自 `fanoutAutoPoke`, 它只反映"派发调用有没有抛错"。  各 transport 的强度差得很远, 最弱的是 `ChannelWakeFanout.send()` —— sink 抛出的异常被 `catch {}` 吞掉后照样 `return true`; tmux 分支也只到"`send-keys` 没报错"为止。  接收端是否真的把消息读进上下文, daemon 从不回答。

而这个答案其实一直在库里。  `GetInboxService.get()` 在同一个事务里推进 `agents.last_processed_event_id`, 于是 `cursor >= messages.event_id` 就是一个**已经存在**的收据。  `fanout-with-retry.ts` 的 `alreadyReadFn` 正是这条 SQL, 用来在重试时抑制幽灵通知 —— 数据在, 只是从来没有回给发送端。

约束:

- xats 是 poke 驱动、不轮询的。  发送端发完就结束回合去睡, 靠回复的 poke 叫醒。  所以"发送端一直在等"实际是"发送端睡死了", 任何只在工具调用窗口内生效的机制都救不了它。
- 现有定时调度 (`poke-retry.ts` 的 `retryMap` + `setTimeout`) 没有任何持久化, daemon 重启即蒸发。  本项目里 daemon 重启是日常。
- `messages` 表是热路径, 每条私信都写。  新增列必须是可空的追加式迁移。

## Goals / Non-Goals

**Goals:**

- 给发送端一个**不可伪造**的送达证据 —— 必须接收端的 agent loop 真的跑起来调了一次工具才成立。
- 快乐路径几秒内给出确认, 让发送端能安心结束回合。
- 真正没读时, 让发送端在**睡着之后**仍能被主动叫醒并明确知道对面废了。
- 该机制跨 daemon 重启存活。
- 存储面接近零: 除 deadline 本身外不新增状态。

**Non-Goals:**

- 不追踪回复 (L6)。  `messages` 无 `in_reply_to`, 本变更不加。
- 不保证告警必达。  瞬态失败会重试 (D7b), 但终态失败、以及认领与释放之间进程崩溃, 仍会静默放弃; "发送端刚活过又彻底死掉"不在覆盖范围。
- 不给 `broadcast` / `broadcast_to_role` 加 `need_reply`。
- 不把现有 poke 重试迁到持久化调度 —— 同一病灶 (见 Risks), 但独立 scope。
- 不试图观测"wake-up 有没有渲染进对方 UI"。  这一层 daemon 结构上不可观测, 往下挖没有出路。

## Decisions

### D1: 已读是推导式, 不落库

判据固定为 `agents.last_processed_event_id >= messages.event_id`, 查询时实时计算。

**替代方案**: 加 `read_at` 列, 在 `get_inbox` 推进 cursor 时回写。  **否决理由**: 引入第二个写入点, 它和 cursor 之间可以漂移 (任何一条推进 cursor 但漏写 `read_at` 的路径都会造成永久性假未读), 而收益只是一个本变更不需要的精确时间戳。  cursor 已经是事务内推进的单一真相, 保持它唯一。

**已知边界**: `get_inbox({since_event_id})` 显式传参时是只读的、不推进 cursor, 这类读法不会产生 ACK。  实践中未观察到有 agent 这么用, 本变更不处理。

### D2: `await_ack_s` 用单个整数参数, `0` 表示关闭

签名 `await_ack_s?: integer`, 默认 `10`, 合法区间 `[0, 30]`, 越界由 zod 在工具边界直接拒绝 (符合项目"在系统边界用 schema 验证"的约定)。

**替代方案**: `await_ack: boolean` + `await_ack_s: number` 两个参数, 或 `await_ack: number | false` 联合类型。  **否决理由**: 两个参数会产生 `await_ack:false, await_ack_s:20` 这种自相矛盾的组合还得定义优先级; 联合类型在 MCP inputSchema 里表达笨拙且客户端兼容性差。  单整数没有非法组合。

### D3: 上限硬卡 30 秒

**理由不是性能, 是重发**。  发送端 harness 有自己的工具超时; 一旦等待超过它, 发送端看到的是一个**工具错误**, 而 mailbox 行其实早已写入。  agent 面对"发送失败"极大概率重发, 对面就收到两条。  30 秒是留给主流 harness 的安全余量。

配套地, 工具描述必须写明"mailbox 行在等待开始前已写入, 任何超时或错误都不代表消息没发出去"。  这句话比参数上限更重要 —— 上限只是让这种情况罕见, 描述才是让 agent 不做错事的东西。

### D4: `not_yet` 的语义红线

`not_yet` 只表示"这几秒内没读到", 不是 timeout, 不是 failed, 不是判决。

这条不是措辞洁癖, 而是本设计成立的前提。  **正因为有 15 分钟看门狗兜底, 同步等待才可以非常没耐心** —— 快乐路径 1~3 秒就绿, 拿到全部价值; 不 happy 就立刻放行, 把判断权交给看门狗。  反过来说, 如果 agent 把只等了 10 秒的 `not_yet` 读成"对面挂了"而去接管工作, 就制造了比现状更贵的假阴性 (现状至少只是卡住, 不会把活干两遍)。

因此: 返回值用 `not_yet` 而非 `timeout`/`failed`, 且工具描述必须显式写"不要据此改变行为, 真没读会有独立告警主动敲你"。

### D4b: 等待期间用轮询, 不用 `get_inbox` 回调

等待循环每 250ms 跑一次 `alreadyReadFn` 那条 SQL。  better-sqlite3 是同步的, 单条按主键的查询在微秒级, 10 秒最多 40 次, 代价可忽略。

**替代方案**: 在 `get_inbox` 里维护一个 waiter 表, cursor 推进时 resolve 对应 promise。  **否决理由**: 把 inbox 读路径和 send 写路径耦合起来, 为了省几十次微秒级查询引入一个需要正确处理超时、多等待者、异常清理的注册表。  与 D1 同源: 保持单一真相, 不为微优化增加状态。

### D5: 看门狗必须落库, 不能用 `setTimeout`

`messages` 新增两个可空列:

- `ack_deadline_at TEXT` —— `need_reply=1` 的私信写入 `sent_at + 15min`, 其余一律 NULL
- `ack_alerted_at TEXT` —— 看门狗检查完该行的终态标记

daemon 在 `buildServer` 中挂一个周期扫描 (沿用现有 `cleanup` / `orphanGc` 的 `setInterval` + `unref()` + `onClose` 时 `clearInterval` 模式), 并在挂载时立即跑一次作为启动扫描。

**否决 `setTimeout` 的理由**: `poke-retry.ts` 就是纯内存 `retryMap` + `setTimeout`, 没有落库也没有启动扫描, daemon 一重启全部静默蒸发。  现在这个洞只有 10 分钟宽 (最后一次重试), 影响有限; 15 分钟的窗口撞上一次重启, 本特性就会**在它最该生效的场景里自我失效**, 而且比现状更糟 —— 发送端会因为信任这个保底而更放心地去睡。  一个"用来消灭静默卡死的机制自己静默卡死"是不能接受的。

扫描查询: `WHERE ack_deadline_at IS NOT NULL AND ack_alerted_at IS NULL AND ack_deadline_at <= now`, 配一个 `messages(ack_deadline_at)` 上、以 `WHERE ack_alerted_at IS NULL` 为条件的部分索引即可, 稳态命中集合极小。

### D6: `ack_alerted_at` 在两种结局下都写

已读 → 不告警, 但仍写 `ack_alerted_at`; 未读 → 告警后写 `ack_alerted_at`。

**理由**: 它是"这行已被看门狗处理完"的终态标记, 不是"已告警"标记。  两种结局都写, 扫描集合才会单调收缩, 查询条件也才能保持上面那个简单形式。  写入用 `UPDATE ... WHERE id=? AND ack_alerted_at IS NULL` 保证并发扫描下也只告警一次。

### D7: 告警走 `pokeAsDaemon` —— 与 `poke()` 共用派发层, 只跳过三道调用者检查

`poke()` 里有三道检查对 daemon 自发的告警都不适用: `self_poke_denied` (target === caller)、`cross_team_denied`、以及 `callerAgentId` 必须是个存在的 agent。  告警没有"调用者", 它由 daemon 发起, 目标是发送端自己。

因此告警走新增的 `pokeAsDaemon` (poke.ts): 它载入发送端的 target row 后交给与 `poke()` 共用的 `dispatchToTarget` → `dispatchPoke` —— 该层已经按 agent_type / delivery 路由到 claude-channel / codex-appserver / kimi-server / opencode-server / tmux, 且带 pane 归属校验。  这与 `codex-recovery-poke.ts` 直接用 `tmuxPokeImpl` 是同类做法 (daemon 自发的 poke 绕开调用者语义), 只是告警的目标是已注册 agent, 所以停在 dispatch 层而不是 pane 层。

**tmux 分支的 quiet-guard 保持生效**: 发送端正忙时 guard 会失败, 告警不会被注入。  最初的判断是"这可接受, 因为告警的读者本就是睡着的发送端", 评审推翻了它: 距离发送已过十五分钟, 发送端完全可能已经接了别的活, 而这是个几秒后就自愈的状态。  见 D7b。

### D7b: 告警的瞬态失败释放认领并重试

失败分两类。  **瞬态** (`guard_failed` / `kimi_session_busy` / `channel_sink_failed`): 把 `ack_alerted_at` 写回 NULL 释放认领, 行重新变 due, 下一轮扫描重试, 直到 `ack_deadline_at + 10 分钟`。  **终态、抛异常、或超窗口**: 认领保持, 不再尝试。

窗口取 10 分钟是对齐既有重试阶梯 (30s/180s/600s) 的总跨度 —— 告警理应和它所报告的那个 wake-up 有差不多的耐心。

**不需要计数器**: 窗口由已经存在的 `ack_deadline_at` 推出, 重试次数由"窗口 ÷ 扫描间隔"自然限住。  加一列计数器只会为同一个界引入第二份状态。

**认领仍然跨越整个 poke**, 释放发生在 poke 返回之后。  这是关键: 认领跨越 poke 保证并发扫描不可能重复告警, 而事后释放保证一次瞬态失败不被记成判决。  代价是认领与释放之间进程崩溃则该告警永久放弃 —— 与"崩在 claim 与 poke 之间"是同一笔账, 已在 spec 里写明。

`kimi_pending_interaction` 刻意不算瞬态: 它等的是人工审批, 不会随时间自愈, 重试只是空转。

### D7c: channel sink 抛异常如实上报

`ChannelWakeFanout.send()` 原本把 sink 异常 `catch {}` 掉后仍 `return true`。  这是全 daemon 最弱的"已送达"信号, 也正是本变更 Context 里点名的病根 —— 一个 channel 已经断掉的 Claude host, 每次收到消息都会让发送端拿到 `poked: true`, 且重试阶梯永不启动, 因为没有任何东西报告过失败。

改为如实返回 `false`。  **sink 保持 attached**: 一次写失败不是订阅者消失的证据, 而且在 `send()` 里 detach 会与 channel proxy 自己的订阅生命周期竞争。

无 pane 可回退时报**新错误** `channel_sink_failed` 而不是并入 `no_transport_available`。  两者描述的是不同状态 —— "订阅者还在但这次写失败"与"根本没有传输通道" —— 并进去就等于在上一层重造刚刚消灭的那个假信号。

**注意这里不主张什么**: 普通发送**不会**重试 `channel_sink_failed`。  `auto-poke-fanout.ts` 的重试只调度带 pane 的 `guard_failed` 与 `kimi_session_busy`, 无 pane 的 channel 目标两者都不沾。  兜底是 mailbox 行照写 + 15 分钟未读告警。  只有看门狗自己的告警 poke 把它当瞬态处理。

### D8: 告警文本必须自包含

现有 wake-up 模板是 `新邮件 from <sender> → <recipient>@<team>, 请调 get_inbox 查看`。  告警若沿用这个形状, 发送端醒来会去调 `get_inbox`, 然后发现空的 —— 白白浪费一个回合还制造困惑。

告警文本必须说明: 这是投递告警不是新邮件、无需 `get_inbox`、对方是谁、未读多久、以及**最后的 `skip_reason`**。  最后一项是全文最有价值的部分: 它让发送端能区分

- `pane_reassigned` / `no_pane` → 对方的 pane 被顶了或没了, 需要人介入重注册
- `skip_reason` 为空 (poke 全成功) → 对面 agent 自己卡死或被 compact 掉了

这两种的后续处理完全不同。  `skip_reason` 为空时必须显式写"无 skip reason", 而不是省略该字段 —— 省略会被读成"没查到"。

告警**携带 subject 但不携带 body**。  wake-up hint 两者都不带, 但那是发给接收端的, 对方调一次 `get_inbox` 就全有了; 告警发给的是这条消息的作者本人, 而一个发送端可能对同一接收端有多条悬而未决的消息 —— 没有 subject 就无法定位是哪一条, 等于半个告警。  安全性不靠"作者看自己的东西"这个语义论证兜底: 告警经 `pokeAsDaemon` 发出, 完整继承 `stillOwnsPane` / `verifyPaneHost` / codex foreground-carrier 三重 pane 归属校验, pane 被顶了会被机制拒绝。  body 仍然排除: 它是体量所在, 而告警是指针不是重投。

### D9: `need_reply` 中立性约束的例外

`mailbox` spec 现有一条 "It MUST NOT change delivery, auto-poke, retry, or routing behavior"。  按 `need_reply` 挂载看门狗与这条字面冲突, 因此 delta spec 显式修订它, 开一个受限的例外并写清边界: 该后果只影响**发送端是否会被告警**, 不改变消息如何送达接收端; 两条只差 `need_reply` 的消息必须收到完全相同的投递、auto-poke、重试与路由待遇。

`broadcast` / `broadcast_to_role` 的行本来就是 `need_reply=0` (spec 已有 "Fan-out messages are no-reply by default"), 所以排除广播不需要额外分支, 是这条规则的自然推论 —— 但仍在 spec 里断言, 防止将来给广播加 `need_reply` 时无声地把告警风暴带进来。

### D10: 迁移是纯追加, 且绝不回填

两列都是 nullable、无 default, 沿用 `schema.ts` 里既有的 `ALTER TABLE ... ADD COLUMN` 迁移辅助模式。  存量行 `ack_deadline_at` 为 NULL, 因此**一条历史消息都不会产生追溯告警** —— 升级瞬间给几百条陈年未读消息集体告警会是一场灾难。

## Risks / Trade-offs

- **`not_yet` 被 agent 误读成失败** → 这是本变更最大的风险, 且不是技术风险。  缓解: 返回值命名避开 `timeout`/`failed`; 工具描述把红线写死并被 spec 场景断言 (`tools/list` 可测)。
- **默认开启的 10 秒等待改变了所有现有调用方的延迟画像** → 对方空闲时实际只等 1~3 秒; 对方忙时多花 10 秒墙钟。  可用 `await_ack_s:0` 完全关闭。  接受这个代价的理由: 会卡死的工作流大多由 skill / orchestrator 发起, 它们不会记得传新参数, 默认关等于对最需要的场景不生效。
- **告警仍可能永久丢失** → 瞬态失败已由 D7b 覆盖, 但终态失败、以及认领与释放之间进程崩溃, 都会静默放弃。  告警的**失败**结局只进 daemon 日志; 成功则不留任何记录 (既不写日志也不写库)。  `get_delivery_status` 一概查不到 —— 那张表键是 `(message_id, 收件人)`, 描述的是发给收件人的唤醒, 不是发给发送端的告警。
- **`poke-retry.ts` 的内存调度仍然会在重启时蒸发** → 本变更不修, 但看门狗独立于它: 一条 poke 重试丢失的消息, 15 分钟后照样会被看门狗抓出来告警。  也就是说本变更顺带削弱了那个旧洞的后果, 但没有修它。
- **扫描周期与 15 分钟的关系** → 告警实际发出时间是 `deadline` 之后的下一个扫描 tick, 最坏晚一个周期。  对一个 15 分钟量级的判据无影响。
- **并发扫描重复告警** → `UPDATE ... WHERE ack_alerted_at IS NULL` 的条件写保证幂等。
- **`messages` 表增列影响热路径** → 两个 nullable 列, 无索引写放大 (部分索引只覆盖 `ack_alerted_at IS NULL` 的极小集合)。

## Migration Plan

1. schema 迁移追加两列 (nullable, 无 default, 不回填)。
2. 新代码写入 `ack_deadline_at`; 老数据全 NULL, 自然不参与扫描。
3. 回滚: 停用扫描器即可 —— 两列变成惰性数据, 不影响任何既有读写路径。  列本身无需删除。
