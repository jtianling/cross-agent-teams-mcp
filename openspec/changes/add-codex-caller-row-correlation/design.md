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
- **C6 — uuid 标识的是"这一次启动", 不是"这个 pane"** (aoe 确认, 此前无处成文): aoe 每次
  bootstrap 都 `xats_agent_id="$(uuidgen)"` **新铸**, 不按 pane 存下复用.  这与预注册行的主体
  定义 (pane + uuid = 这一次启动) **是同一个语义**, 两边自洽.
  推论: 原地 respawn 路径上 pane id 不变而 **uuid 变**, 所以 `confirmOwnership` 的
  `argvContainsUuid(cmd, row.xats_agent_id)` 能通过, **只因为重启的 pane 先用新 uuid 覆盖了
  那一行**.  由此存在一个窗口 —— poke 落在"pane 已重启、新预注册尚未写入"之间时, 行里是旧
  uuid 而 pane 上是新 uuid → 判 `absent` → 不发 → 回落现状.  **失败方向安全, 不需要处理**,
  但要写下来, 否则日后会被当成缺陷去"修".

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

### M5 实测: **否**, 而且是最干净的那种否 (2026-07-31)

rollout 的 fd **存在、`lsof` 抓得到、按 thread 对得上** —— 但**两个都在 app-server 手里**
(`fd=37u` / `fd=40u`, 两个 thread 各一), 而 pane 里的载体 (shim 与 vendor 原生子进程**都查过**)
**一个都没有**.  `--remote` 形态下会话本来就活在 app-server 里, pane 里那个 codex 只是前端.

**缺的那一跳不是"没人持有", 而是"持有者恰好是唯一分不清 pane 的那个进程".**

append-then-close 已用**相反方向**排除: 在 turn **活跃期间**每 2 秒采样、共 12 次, pane 载体
恒为 0 而 app-server 恒为 2 —— 长持句柄, 不是写时短开.

顺带铺开"载体到底持有什么": vendor 子进程持有 19–21 个 `$CODEX_HOME` 下的文件, 但**全是共享的**
(`state/memories/logs/goals` 及其 wal/shm), 两个会话**逐项相同**; 唯一每进程唯一的是
`tmp/arg0/…/.lock`, 随机后缀, 与 thread 无关.

**唯一真正每会话、且两端都可见的句柄是 TCP 连接**: pane 载体的本地端口 ↔ app-server 侧看到的
对端端口, daemon 用 `lsof -i` 从 pane 那一端就能读出来.  **但它到不了 thread** —— 缺的是
app-server 内部"哪条连接承载哪个 thread"的映射, 而 `thread/read` 的字段里没有任何
连接/端口/pid (E3 已列全).  **记为观察, 不作为机制**: 它离可用差的正是 E3 已证明不存在的那个字段.

### M8 — 让已经知道答案的那一方直接告诉 daemon (第三轮首选)

三轮实验的共同形状是: **我们一直在设法推导一个东西, 而它在 daemon 之外是已知的.**

- launcher 在 `exec` 时知道 pane 与 uuid, **但那一刻 thread 还不存在**;
- codex 之后创建 thread, **但它不记 uuid**;
- 而 **aoe 已经在把 codex 会话按 thread 采纳进 slot** (实测见 `slot 0/1 adopt` 时间戳), 也就是说
  **aoe 手上有 pane↔thread 的映射**, 而且它是靠自己的证据 (rollout 监视) 建立的, 不靠任何自述.

所以最短的路可能是: **pane↔thread 由 aoe 在得知之后补报给 daemon** (扩展现有 pre-reg 通道,
或新增一次"绑定 pane→thread"的调用).  caller 侧仍然只贡献 `thread_id` (投递路径已经信任它),
而 pane↔thread 这一跳由一个**有独立证据**的本地组件提供, 不经过模型.

- 待确认 (已去问 aoe): 他们**如何**建立 pane↔thread、**多快**能知道、以及愿不愿意补报;
- 代价: 跨仓库契约, 且在 aoe 补报之前的窗口内仍然只能回落到候选唯一性;
- 优点: 不依赖 codex 的任何未文档化内部结构, 不引入新的可伪造声明.

### M8 实测: **否** —— aoe 也在猜, 而且是**同一类**猜法 (aoe 答复, 2026-07-31)

aoe 的 `find_rollout` 判据只有三条: rollout 文件名时间戳 ≥ pane 进程启动时间 − 2s; rollout 里
的 `cwd` 等于实例的 project_path; 该 thread 尚未被别的 pane 认领 —— 满足者取**最早**.
**没有任何一条把 rollout 硬绑到 pane** (无 pid / tty / fd / uuid).

它今天已被实测证明会**给出错误映射**: 一次 Shift+C 后 `%13` 的 slot 认领到了 `%12` 重启后新开
的会话 (aoe 侧一个陈旧 `pane_live` 行导致的洞, 窗口 15 分钟).  该洞归 aoe 修, 但**修好之后
判据本身仍是 cwd + 时间序**.  限定 (aoe 后续更正): 陈旧 `pane_live` 行**只在原地 respawn
那条重启路径上出现**; 冷启动恢复走的是新建 pane, 拿到新 pane id, 没有陈旧行.

采纳延迟实测 **44s / 77s** (轮询节拍, 可改成目录监视压到秒级, 但那只改延迟不改强度).

**aoe 给出的否决理由我完全接受, 并认为它省掉了后面几轮**:

> 候选唯一性与 rollout 认领是**同一类证据** —— 都是"时间 + 范围 + 去重"的排除法, 都在"同时
> 有两个"时失效, 也都在多一个并发者时**给出错误答案而不是拒绝**.

把关联从 daemon 挪到 aoe **不增加证据, 只是换个地方猜**; 更糟的是结果会"看起来有权威来源".
**M8 否决.**

### 串行化 (aoe 提出): 消掉**触发条件**, 不是关联机制

aoe 可以把自己启动的 codex pane **串行化** (起第一个 → 等它的 rollout 落地并被认领 → 再起
第二个).  那样在 aoe 制造的窗口里任何时刻只有一个未认领候选, 他们的判据在该窗口内变成确定的;
**并且它顺带消掉本变更的候选唯一性问题** —— 两个 pane 不再落进同一个 pre-reg 窗口.

**必须写清它是什么**: 这是**消除触发条件**, 不是建立关联.  daemon 仍然在猜, 只是不再被 aoe
自己制造的并发压到.  它**不覆盖**: 用户在同目录手工起的 codex、任何第三方并发者, 以及
**S9 那条写入路径完全没有仲裁的问题 (串行化对它零影响)**.

代价 (aoe 自述): 会话启动变慢; 只覆盖 aoe 托管的并发.  **需要 jt 拍板**, 因为它改的是启动体验.

### M9 — 恢复 poke 携带 nonce, 注册时回带 (xats 侧独立可做, 首选)

daemon **本来就**在往一个**具体的 pane** 发恢复 poke.  让那条话术带一个一次性 nonce, 并要求
codex 在 `register_agent` 时回带 —— 于是 **daemon 对 nonce↔pane 的对应是确定的** (是它自己
发的), caller 回带哪个 nonce 就落在哪个 pane 的行上.

- **不是排除法**: 它不依赖"全机恰好一个", 两个 pane 同时重启各自拿到各自的 nonce;
- **不需要 aoe 任何配合**, 也不依赖 codex 任何未文档化结构;
- 覆盖的正是最要紧的那一类: **重启恢复** (poke 存在的场景), 也就是一次 Shift+C 两个 pane 同时
  回来的情形.

**aoe 指出的前置, 核代码后确认已经存在**: Shift+C 有两条路 —— 会话还活着走
`respawn-pane -k` (**pane id 不变**), 会话的 tmux 没了走 `recover_from_slots` (**重建会话,
新 pane id**).  第二条路上 pane id 计数器已随 server 清空重置, 所以记录里的 `%5` 可能已经是
**另一个会话的活 pane**, 那时 poke 不是打空而是**把 nonce paste 进别人的 agent**.

该风险由**已有**的 ownership 确认挡住, 不需要新增: `codex-recovery-poke.ts` 的
`confirmOwnership` 要求 `classifyCodexCarrier({ …, uuid: row.xats_agent_id })` 返回
`foreground` —— 也就是**该 pane 上的载体 argv 必须仍带这一行存的 uuid**; 探测阶段
(`argvContainsUuid(entry.command, row.xats_agent_id)`) 同样要求.  换了主人的 pane 上是**别的
uuid**, 判定为 `absent`, 不发.  nonce 因此只会进入仍属于该行的那个 pane.

**两条如实的弱点**:

1. **不覆盖首次启动** (没有 poke 就没有 nonce).  那时仍回落候选唯一性 —— 但首次启动没有历史
   身份要恢复, 代价小得多;
2. **依赖模型照做**.  今天已实测模型会跳过文档规定的探测顺序 (自己猜 `agent_type=custom`),
   所以 nonce 被漏带是**会发生**的.  处置: 漏带即回落到现状行为 —— **照做则严格更好, 不照做
   不比现在差**, 不引入新的失败模式.
3. nonce 可被能读该 pane 内容的进程窃取 (`capture-pane`).  但这不比现状更弱: 今天连 nonce 都
   不需要.

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
