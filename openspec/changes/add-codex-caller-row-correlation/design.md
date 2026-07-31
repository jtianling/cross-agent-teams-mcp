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

## 实验结果 (2026-07-31, codex 0.146.0, 私有根, `inherit = "core"` 显式写死)

**M1 / M2 / M3 三条全否.**  两个真身会话对照, 每条都带正向对照.

- **M1 否, 而且是两个独立的理由.**  E1 铺开的结论是: **模型可读的会话级值只有
  `CODEX_THREAD_ID` 一个**.  uuid 模型**能**说出来, 但不来自任何会话级通道 —— 会话 B 是靠
  全机推断 (thread → rollout → `capture-pane` 在自己 pane 的回显里认出自己刚发的 prompt →
  pane shell pid → 其 codex 子进程 → 读 argv); 会话 A 则**编了一个理由** ("this tool
  environment explicitly identifies pane 0"), 而本轮 `TMUX_PANE` 根本没设, 该说法可证伪 ——
  A 答对了但**理由是假的**, 两个 pane 的场子里那是 50/50.
  所以除了信任分析里"可伪造且伪造不自败"之外, M1 还有第二条否决理由: **即使 caller 完全
  诚实, 它自报的值也可能是错的, 而 daemon 收到的只是一个 uuid, 分不出推导与编造.**
- **M2 否.**  rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<thread_id>.jsonl`) 按
  thread 定位没问题 (正向对照通过), 但 `session_meta` 与 `turn_context` **都不含任意 `-c`
  覆盖**, 没有 `xats.*` 命名空间.
  **必须挡住的陷阱**: 两个 uuid **确实出现在 rollout 文件里**, 但只出现在
  `payload.content / message / output / last_agent_message` —— 因为**模型自己把它打印出来了**,
  而且 A 的 uuid 出现在 B 的文件里.  "grep rollout 找 uuid"会**成功**, 并且**完全是错的**.
- **M3 就 uuid 而言否**, 但有两个有用的副产品: `thread/read {threadId}` 给出每会话记录
  (A/B 不同, 正向对照通过) 且**直接给出该会话 rollout 的绝对路径 `path`** —— M2 的定位问题
  由 M3 解决; `config/read` 是**全局的** (A/B 完全相同、字段全 null), 不是会话覆盖.
  探法记一笔: 给 app-server 一个不存在的方法, 错误里会列出全部支持的方法.

**E1 里的一个陷阱值得单独记**: `CODEX_COMPANION_SESSION_ID` / `CODEX_COMPANION_TRANSCRIPT_PATH`
名字最像"每会话", 实际是**操作者自己那个 Claude Code 会话**的 id 与 transcript 路径, 被
app-server 继承下来 —— **只跑一个会话就会把它当成 codex 的特性**.

### 由此产生的两条安全观察 (超出本变更范围, 需单独处理)

模型的工具 shell 读得到 app-server 的**完整**环境 (`inherit = "core"` 一个都没滤掉), 其中包括:

1. **`CROSS_AGENT_TEAMS_MCP_TOKEN`** —— 生产上就是真 token;
2. **`CODEX_COMPANION_TRANSCRIPT_PATH`** —— 操作者 Claude Code 会话 transcript 的绝对路径.

第 1 条对 codex agent 本身不算提权 (它本来就用这个 token 连 xats), 但它意味着**该 token 是
凡能读到 app-server 环境者皆可得**的.  第 2 条是实打实的信息暴露: 模型拿到了一条通往操作者
完整对话记录的路径.  **两条都不在本变更的范围内, 但必须单独立项**, 不要夹带.

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

## 第二轮候选 (M1-M3 全否之后)

三条原候选都在问同一件事: **codex 能不能告诉我们 launcher 铸的那个 uuid.**  答案是不能 ——
uuid 只活在**进程的 argv** 里, codex 自己不记它.  所以第二轮换一个问法: **不要问 codex 要
uuid, 而是把 daemon 已有的两端接起来.**

daemon 手上已经有两样各自可靠、但从未被连起来的东西:

- 从 caller: `thread_id`  →(M3 的 `thread/read`)→ **该会话 rollout 文件的绝对路径**;
- 从 pane: pane → tty → 载体进程 pid → argv 里的 **uuid** (C4).

缺的就是 **"这个载体进程 ↔ 这个 thread"** 这一跳.

### M5 — 用载体进程打开的文件把两端接起来 (推荐先验)

`thread/read` 给出的 rollout 路径是**每会话唯一**的.  若 pane 里那个 codex 进程在会话期间
**持有该文件的打开描述符**, 那么对每个候选 pane 的载体 pid 做一次 `lsof -p <pid>`, 看它是否
打开着 caller 那个 thread 的 rollout 文件, 就得到了缺的那一跳.

- **caller 的贡献仍然只有 `thread_id`** —— 按信任分析, 不引入新假设;
- **连接关系由 daemon 自己观测**, 不经过任何自述, 也不经过 app-server 的可写字段;
- 不依赖 rollout 的**内容**格式 (只用路径), 因此躲开了 M2 的 grep 陷阱和格式漂移;
- 未验证: **codex 是否长期持有该 fd** (可能是 append-then-close).  这就是 E5.

### M4 — app-server 的每会话元数据通道 (未验证, 且有先后顺序问题)

方法列表里有 `thread/metadata/update` / `thread/settings/update` / `thread/name/set`, 且
`thread/read` 有对应的 `extra` / `agentNickname` / `agentRole` / `name` 空字段 —— 形状正好是
关联需要的**可写 + 可读的每会话通道**.

但它有一个结构性问题: **谁在注册之前写它.**  launcher 不跟 app-server 说话, 而且它 exec 时
thread **还不存在**; daemon 说话, 但此刻它正是"不知道该写谁"的那一方.  所以 M4 不能独立成立,
它更可能是 M5 成立之后**用来固化关联**的载体, 而不是建立关联的手段.

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
