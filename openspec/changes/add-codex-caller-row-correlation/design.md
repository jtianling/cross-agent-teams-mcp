# Design: add-codex-caller-row-correlation

## Context

`autoBindCodexPane` 拿到一批未过期的 pre-reg 行, 对每行去它自己的 pane 上找载体 (argv 含**该行**
的 uuid + 前台载体证明), 通过的成为候选, 然后:

```ts
if (candidates.length !== 1) return false   // 唯一的"关联"就在这一行
```

这句话承担了本该由关联承担的职责.  它在单个 codex pane 的机器上碰巧成立, 在两个 pane 同时
启动时结构性失效.

## 已验证的约束 (2026-07-31 实测, 均带对照)

- **C1 — caller 读不到自己 pane 的环境.**  `codex --remote` 的工具在**共享 app-server 进程内**
  执行 (祖先链: tool shell → vendor codex → app-server → launchd; 两个 pane 的工具父进程相同;
  不带 `--remote` 的对照组是 pane 本地的).  所以 `$XATS_IDENTITY_KEY` 到不了模型.
- **C2 — `$TMUX_PANE` 读得到, 但是个固定的错值.**  它来自启动 app-server 的那个 shell (生产上
  是 `%39`).  **任何"让 caller 自报自己 pane"的方案在这里当场作废**, 而且失败是静默的 ——
  每个 caller 都会自信地报同一个错 pane.
- **C3 — `$CODEX_THREAD_ID` 是会话级的, 且模型读得到.**  同一 app-server 下两个 pane 的会话
  读到不同值.  准确说法: **codex 会注入它自己的会话元数据, 但不转发 pane 启动行上的任何东西.**
  会话级干净 **≠ 不可伪造**: caller 读不到**别人的**, 不代表它不能**声称**别人的.
- **C4 — daemon 侧可独立观测的只有: pane → tty → 载体 argv (含 launcher 铸的 uuid).**
  这是今天唯一不依赖 caller 自述的证据, 而它证明的是 pane 的身份, 不是 caller 的.
- **C5 — `thread_id` 在投递路径上已经是承重的.**  codex 的消息投递就是按 thread 经 app-server
  路由的.

## Goals / Non-Goals

**Goals**
- 扫描能在**多条**待消费行中选出属于本次调用者的那一条, 且选择依据 daemon 可验证
- 关联缺失 / 多义时 fail-closed, 并有独立 reason, 决不静默
- 不引入比现状更弱的信任假设
- 关联不可得时行为回落现状, 不制造新失败模式

**Non-Goals**
- 不解决"codex 完全不注册"(那是 agent_type 猜错等另一类问题)
- 不在本变更引入 tmux server 作用域 (xats 从来没有这个概念, 处理 pane id 复用走的是认领时的
  证据; 引入它要同时改两张表和全部探测路径, 与本条无关)
- 不调 TTL.  在候选唯一性这个设计下 TTL 同时是"恢复窗口"与"互斥窗口", 两个方向相反 —— 出路
  是消灭第二个职责, 不是折中那个数字

## 三个候选机制

### M1 — caller 自报自己的 `xats.agent_id`

launcher 已经把它放进 codex 的 argv (`-c xats.agent_id="<uuid>"`).  若模型能读到自己的 `-c`
覆盖值, 注册时带上, daemon 直接按 uuid 精确选行.

- 需要验证: **模型能否读到自己的 `-c` 覆盖值** (未验证).
- 若可行, 它是三者里最简单的, 且 daemon 侧零新依赖.

### M2 — daemon 从 codex 的会话记录里解析 thread_id → xats.agent_id

codex 每个会话有自己的 rollout / session 记录.  若其中同时含 thread id 与该会话的配置覆盖,
daemon 拿 caller 报的 `thread_id` 即可反查出 uuid, 再用 C4 的证据核对该 uuid 确实在那个 pane 上.

- 需要验证: 该记录**是否包含配置覆盖**、路径与格式 (未验证).
- 先例: aoe 已经在读 rollout 文件 (`src/db/codex_rollout.rs`), 格式可读这一点有依据.
- 依赖 codex 的磁盘格式 (未文档化, 随版本变).

### M3 — daemon 向 app-server 查询会话元数据

daemon 已经在跟 app-server 说话 (resume thread).  若 app-server 暴露每会话的配置/argv, 直接问.

- 需要验证: **app-server 是否暴露** (未验证; aoe 曾提出"app-server 按会话持有 `-c xats.agent_id`"
  这个前提, 至今未证).

## 信任分析 (这一节决定选型, 不只是取舍)

**caller 报什么都可伪造; 真正的问题是 daemon 能验证什么.**

- **M2 / M3 把 caller 的贡献收缩到 `thread_id` 一个值**, 而按 C5, 投递路径**已经**信任它.
  一个伪造 thread_id 的 caller 会把**自己的消息**导到受害者的会话里 —— 这个伪造今天就已经
  可能, 而且对伪造者**自败**.  所以以 thread_id 为关联输入**不引入任何新的信任假设**.
- **M1 引入的是一个新的可伪造声明 (uuid), 而它的伪造不自败**: 伪造者报出受害者的 uuid, 而
  受害者**自己的 pane 恰好满足载体证明** (argv 里就是那个 uuid), 于是 C4 这道证据**反而替
  伪造者背书**, 结果是拿走受害者的 pane 与 key.  uuid 又是全机 `ps` 可见的.

> **结论: M1 不得单独使用.**  它可以作为 M2/M3 的**加速路径**, 但必须与 daemon 侧证据交叉
> 校验 (报的 uuid 必须同时被 thread_id 反查确认), 否则它把 C4 从防线变成帮凶.

优先级: **M2 ≈ M3 > M1(仅作交叉校验)**.  M2/M3 之间按实验结果与稳定性选 —— M3 若可行更干净
(不依赖磁盘格式), M2 有 aoe 的先例.

## 判定实验 (第一阶段, 先于任何实现)

每个实验都必须带**正向对照**, 否则"读不到"与"根本没注入"分不开 —— 这是今天反复踩到的形状.

- **E1 (决定 M1 可用性)**: 真身 `codex --remote` 在自己的工具里尝试读出本会话的 `-c
  xats.agent_id`.  正向对照: 同一会话读 `$CODEX_THREAD_ID` 必须有值 (已知成立), 证明会话级
  元数据这条路是通的.
- **E2 (决定 M2)**: 找到该会话的 rollout / session 记录, 确认它是否含 thread id **与**配置覆盖;
  记录路径、格式、codex 版本.  正向对照: 用**两个**会话跑, 两条记录必须给出**不同**的 uuid ——
  只跑一个会分不清"记录里有"和"我读到的是全局默认".
- **E3 (决定 M3)**: 探查 app-server 的 JSON-RPC 是否暴露每会话配置.  正向对照同 E2: 两个会话
  必须返回不同值.

**实验一律在隔离实验室的私有根里做** (私有 `XATS_LAB_HOME` / 端口 / app-server / tmux socket),
理由见 `lab/README.md` 的共享事故那节.

## Release ordering

身份恢复要真正工作, 三件必须都到位:

1. **0.7.8 发版** — 让 launcher 的 `--identity-key-env` 被认识, key 才进得了行 (已发布的 0.7.7
   静默丢弃该 flag 并返回成功);
2. **aoe 的 `extra-agent-pane-parity`** — 两个 pane 都预注册 (aoe 侧已完成);
3. **本变更** — 行能被正确的那个 caller 消费.

**1+2 到位而 3 不到位, 净效果为负**: 每次 Shift+C 稳定产出两行且都消费不掉.  所以本变更不是
可以延后的优化, 它决定前两件的收益符号.

## Risks / Trade-offs

- **[R1] 三个机制可能全不可用** (模型读不到配置、记录不含覆盖、app-server 不暴露).  那时唯一
  出路是回到 launcher 侧: 让 launcher 在 exec 之前把一个**codex 一定读得到**的东西写进会话
  (形态未知), 或接受"同时只能有一个 pane 处于 pre-reg 窗口"的串行化约束.  **E1-E3 全否时本
  变更必须重新提案, 不得硬做.**
- **[R2] M2 依赖未文档化的磁盘格式**, codex 升级可能悄悄改变.  缓解: 解析失败一律 fail-closed
  回落到现状 (唯一候选), 并记独立 reason —— 决不猜.
- **[R3] 关联正确但 pane 证据不符** (caller 说自己是 U1, 而 U1 的载体不在任何可见 pane 上):
  必须 fail-closed, 不得退回计数.  否则关联反而成了绕过 C4 的通道.
- **[R4] 本变更会让 `candidate_count` 这个 reason 变罕见**, 从而掩盖"关联本身失效"的情形.
  缓解: 关联路径要有自己的成功/失败日志, 不能只在失败时才出现.

## 已经落地、与本变更无关但由同一批调查产出的可观测性

以下已在 `add-codex-prereg-identity-recovery` 里合并, 本变更依赖它们做实验判读:

- `reason=candidate_count`(候选数不为一时说明数量与涉及 pane) 与 `reason=pane_not_visible`
  (行对应的 pane 不在 daemon 那台 tmux server 上) —— 此前这两条路径**完全静默**;
- daemon 默认日志汇聚点给每行打 ISO 时间戳 —— 此前只有 `codex-recovery` 模块给自己的行加,
  于是一条身份决策只能定位到"某次恢复事件之后", 精度不足以与另一个系统的记录对齐.
