# Design: add-codex-prereg-identity-recovery

## Context

identity_key 机制 (add-identity-key-recovery, 已 complete 未归档) 提供了 agents 表的
`identity_key` 列、`UNIQUE(device, identity_key)` 索引、register_agent 四分支绑定
(`planIdentityKeyBinding`) 与 `findByIdentityKey` 反查.  但 codex `--remote` 模式的工具在
共享 app-server 内执行, 读不到客户端 env, `$XATS_IDENTITY_KEY` 永远送不进 register_agent.
同时重启后的 codex 新会话没有 kickoff, 不会主动注册.

aoe launcher 在 exec codex 之前的 pane shell 里能读到 key, 且已经在那个时刻调用
`pre-register-codex-pane` CLI.  本变更把这条既有通道扩展为 key 的运送通道, 并让 daemon
在识别出 "pane 重启" 时主动 poke 引导 codex 重新注册.

现有关联设施:
- `codex_pane_pre_registrations(pane_id PK, xats_agent_id, expires_at)`, TTL 默认 120s 上限 600s
- `autoBindCodexPane`: 注册后扫 pre-reg, tmux list-panes + `ps -t <tty>` + argv 含
  `xats.agent_id="<uuid>"` 匹配唯一候选后绑 pane 并消费行
- poke 侧: quiet-guard, pane-host-verify; 普通 poke 的 30/180/600 重试梯子
  (`poke-retry.ts`, 内存态) 恢复路径不复用 — 瞬态拒绝走同代探测轮询续试

## Goals / Non-Goals

**Goals:**
- identity_key 经 pre-register CLI/HTTP 通道进入 daemon, 与 `xats_agent_id` 分列存储
- daemon 在 pre-register 时刻识别 "已知身份的 pane 重启", 并在 codex 进程就绪后 poke 引导注册
- auto-bind 消费 pre-reg 行时把 key 附到 caller 行, 复用四分支, 决不静默覆盖
- 全程可选、向后兼容: 不带 key 的调用路径行为零变化

**Non-Goals:**
- 不改 aoe 侧 bootstrap (对方仓库配对变更)
- 不做 daemon 重启后的 poke 调度恢复 (窗口最长 600s, v1 接受丢失)
- 不改 claude / opencode / kimi 的恢复路径
- 不把 identity_key 放进任何进程 argv: key 由 launcher 导出的环境变量交给
  `pre-register-codex-pane` CLI 进程自身读取, 再只经带 token 的 HTTP 通道传输

## Decisions

### D1: 恢复挂在 pre-register 时刻, 不挂在 codex 注册时刻

codex 调 register_agent 时不上报任何可关联 pre-reg 行的标识 (关联是注册后 daemon 扫表 +
argv 匹配), 所以 "注册时按 key 恢复身份" 在现有数据流里没有挂点.  改为: pre-register 携带
key 到达时立即 `findByIdentityKey(key, localDevice)` 查出 (team, name), 命中即调度恢复
poke; poke 话术携带身份, codex 按话术注册, `(device, team, name)` upsert 天然命中旧行.
身份恢复的最后一跳交给既有 upsert 语义, 零新增反查路径.

备选 (放弃): codex 注册时传 key — 做不到, app-server 读不到 env; 让模型从话术里抄 key
传参 — key 会进对话上下文, 且模型可能抄错, 不如 daemon 侧闭环.

### D2: 首发 poke gate 在 codex 进程探测之后

pre-register 发生在 exec codex 之前, 此刻 pane 内是 shell; tmux poke 是 paste+Enter,
立即发送会把话术当 shell 命令执行 — 安全红线.  首发条件: 该 pane 的 tty 上出现 argv 含
`xats.agent_id="<该行 uuid>"` 的 codex `--remote` 进程 (复用 `autoBindCodexPane` 的
`listPanes` / `ttyProcesses` / `isCodexRemoteProcess` / `argvContainsUuid` 原语).
探测采用轮询 (间隔 5s, 首次立即), 每轮先做行过期检查, 行过期即终止调度.
探测命中后的发送走既有设施: quiet-guard (挡 TUI 启动抖动) + 写入前 pane-host-verify 与
ownership 复查; 瞬态拒绝 (guard_failed、载体后台化且未写入) 不入任何长退避梯子, 同代
回到探测轮询按探测间隔续试, 以行生命周期 (过期/覆盖/消费) 为界.  写入侧的最终校验是复合同步谓词
(行快照未变 + holder 元组未变且仍死 + 目标侧前台载体证明 + 调度未取消), 由共享
tmux poke 原语在三个写检查点 (pre-capture、paste 前、Enter 前) 各同步执行一次.
前台载体证明用同步有界超时的 `ps -t <tty> -o pid=,pgid=,tpgid=,stat=,command=` 要求:
codex pid 的 STAT 不含 T/t/Z、命令仍是含存储 uuid 的 codex `--remote`、且
pgid === tpgid (即 tty 的前台进程组); 单纯 kill(pid, 0) 存活不算数 — SIGSTOP/后台化的
codex pid 仍存活但 shell 已回到前台, paste 会执行进 shell; 任何探测错误按不安全处理.
Enter 前失败以 `ownership_lost` 中止, 已 paste 未执行的文本可接受, 执行进 shell 不可接受.
同一前台载体证明还覆盖两条共享原语的路径: auto-bind 候选过滤 (后台 codex 不绑定、
不消费 pre-reg 行) 与普通 codex poke 的 tmux fallback (目标绑定了 runtime_ui_pid 时,
三个写检查点同样要求该 pid 是 pane tty 的前台 codex `--remote`; 此路径无存储 uuid,
命令级匹配即可, 探测失败 fail-closed).  claude/其他 TUI 目标存在同类隐患, 本变更刻意
不扩大范围, 留作后续跟进.

备选 (放弃): 固定延迟首发 (如 +30s) — codex 冷启动时长方差大, 慢启动仍会 paste 进 shell,
快启动白等; aoe 侧 codex ready 后自己 send-keys — 话术/身份是 xats 领域知识, 且绕过
guard/verify 设施.

### D3: identity_key 与 xats_agent_id 分列, key 决不进 argv

`xats_agent_id` 是 argv 匹配键, 天然全机 `ps` 可见; identity_key 是身份钥匙, 只走
CLI→HTTP(带 token)→daemon 通道.  合并两者等于把身份钥匙贴在 argv 上, 任何本机进程都能
冒用.  pre-reg 表加可空 `identity_key` 列, 迁移沿用 schema.ts 的幂等 ALTER 模式.

### D4: auto-bind 消费时按四分支附 key, 不一致不覆盖

`autoBindCodexPane` 成功绑 pane 并消费行时, 若行内有 identity_key:
- caller 行无 key 或持同一把 key → 走 `planIdentityKeyBinding` (bind / 幂等 / migrate,
  migrate 含旧行进程死亡判定), 附到 caller 行
- 行内 key 判定为"别人的" → **整行不作候选** (round-19 现场事故改正):
  既不绑 pane 也不消费行, 行留给真正的主人; 没有候选时按既有 fail-closed 落到 detect
  fallback.  两种判定各记各的 debug reason: caller 行已持不同 key →
  `identity_key_contradiction`; 四分支返回 `identity_key_conflict` (key 的 holder 是
  另一个 (team, name) 且进程存活) → `identity_key_live_holder_conflict` — 后者把
  **caller 自己无 key** 的情形也覆盖进来 (存量未播种的 codex 重启时抢别人的行).
  判定提前到候选资格, 而不是等绑完再只挡 key (候选判定本身不复用
  `planIdentityKeyBinding`, 原因见 round-19c).  身份钥匙冲突的强信号路径仍由
  register_agent 显式传 key 时的 `identity_key_conflict` 承担.

  原语义是"跳过附 key 但 pane 绑定与行消费照常", 它假定"行本来就是 caller 自己的",
  只是钥匙对不上.  联测现场证伪了这个假设: 一个自身 pre-reg 行已过期、无 same-thread
  证据的 codex 合法进入 pre-reg 扫描, 而扫描的关联手段只有"全机唯一候选 + 该 pane 的
  tty 上跑着 argv 带此 uuid 的 codex" —— uuid 证明的是**那个 pane 里的 codex 身份**,
  不是**调用者身份**, 于是 %70 上的 aoe-codex 绑走并消费了 %71 (jt 的 shell codex) 的
  行: 它拿不到 key (mismatch 分支生效), 但 shell 既丢了行也丢了 pane, 最终无绑定无 key,
  而 aoe-codex 的座位指向别人的 pane (poke 会打进别人窗口).  key 正矛盾是 daemon 在这
  条路径上**唯一能算出的"这行不是我的"证据**, 只用它挡附 key 而不挡绑定与消费, 等于
  看见了证据却只挡住了伤害的一半.  caller 无 key 且行的 key 无 holder (首次播种正路)、key 相同 (幂等)、
  holder 已死 (重启恢复正路) 三种情形不受影响; 行内无 key 时无任何矛盾证据, 照旧可消费.

  **实验室 S1/S1b 补出的两条 (round-19b)**: ① holder 是另一身份但**没有正数 pid** 时,
  存活性是 UNKNOWN 而非 dead (tty/pane 绑定本就不记 pid), 候选资格同样剔除
  (`identity_key_holder_liveness_unknown`) —— 与 seat-follow 的 liveness 教训同源;
  消费后的附 key 四分支保持原样 (那时 pane 归属已被证明).  ② **detect fallback 不得
  绑定仍挂着未过期 pre-reg 行的 pane** (`pane_has_pending_prereg`): 行还在说明某个
  launcher announce 了那个 pane 而它的 codex 尚未注册; caller 若真是那个 codex, 上面
  的扫描早就凭 uuid + 前台载体证明消费了它.  fallback 是全机打分、零调用者关联, 让它
  绑这种 pane 等于用启发式重建扫描刚用证据拒绝的认领 —— 实验室 S1 第一次跑就是这么
  漏过去的 (扫描拒绝了, fallback 又绑上了同一个 pane).

  **R19 评审打回后补的两条 (round-19c)**: ③ 候选资格**不再复用 planIdentityKeyBinding**:
  那条规则是在"caller 已证明拥有 pane"之后仲裁 key 的, 因此会排除针对 caller **自己**
  ui_pid 的冲突; 而扫描阶段手上根本没有 caller 的 pid, 只有**候选 pane 的载体 pid** —
  把它传进去, 恰好在"存活的外来 holder 就是那个 pane 的前台 codex"(holder pid ===
  候选 pid) 这一最真实形态下自我豁免, 等于在最该拦的地方开门.  候选资格改为只认正面
  证据: 另一身份的 key 一律 foreign, 除非该身份**可证已消失**(有正数 pid 且探测为不在
  运行).  ④ 仲裁与最终提交必须共享提交前提: 候选判定发生在 bind 的异步验证**之前**,
  真正的 owner 可以在这个窗口里拿到 key; 因此在 bind 之后于**同一同步事务**内重新仲裁
  并条件消费, 判定为 foreign 时**回滚已写入的绑定**(按本次注册的 generation 条件清空,
  决不碰更新一代的座位), 不消费、不附 key.  只在消费后拒绝附 key 不满足契约 —— 那时行
  已删除、座位还指着别人的 pane.

  **R20 评审再打回后的结构性修正 (round-20b)**: 上一轮的 "先绑, 事后按 generation
  条件回滚" 仍然不成立 —— runtime 写会按 LWW 把**在位 agent** 的 pane 绑定清空
  (`setRuntimeBinding` 内的 `clearPaneBinding`), 事后只清 caller 行根本无法把在位者
  的 pane 还回去, 真正主人的投递路由已被破坏.  正确形状是把 bind 拆成**异步验证**
  (只探测, 不落库) 与**同步提交**, 让"重新仲裁 + runtime 写 (含在位驱逐) + 条件消费
  + 附 key"整体进同一个事务: 任何拒绝 (仲裁 foreign / generation 陈旧) 或任何抛错都
  整体回滚 —— 绑定不是事后撤销, 而是**根本没有落地**.  附 key 失败必须把消费一起回滚
  (消费掉却没附上 key 等于永久毁掉恢复句柄); `runAtomic` 因此是必填依赖, 不留
  "没传就不带事务跑" 的降级模式.  同理, detect fallback 的 "目标 pane 无有效 pre-reg
  行" 检查也压进它自己最终写的事务 —— 两种 fallback 形态在检查之后都还有 await, 窗口
  内 launcher 新 announce 的 pane 否则会被一个零调用者关联的 bind 覆盖.

  **已知残余 (诚实记录)**: caller 无 key **且** 行内 key 也没有任何 holder (两个 pane
  都是首次播种, 一前一后启动) 时, daemon 手上不存在任何可用证据, 该行仍可能被另一个
  codex 认领.  根因是 codex `--remote` 调用方无法自证 pane (D1), 而 pre-reg 行里的
  uuid 证明的是 pane 里的进程、不是调用者 —— aoe 侧提的 "行内 uuid 与 caller 前台载体
  argv 比对" 无法实施, 因为 daemon 恰恰不知道 caller 是哪个载体 (知道的话就不需要
  auto-bind 了).  缓解: 各 launcher 保证自己 pane 的 pre-reg 行在注册前有效 (多于一个
  合法候选时既有 "唯一候选" 规则会因歧义 fail-closed, 反而安全); 根治需要 codex 侧能
  把自己的 `xats.agent_id` 随注册带上来 (跨仓库契约, 另立 change).

  **该残留已被真身实验证实 (2026-07-31, aoe 侧 S6)**: 一个 pre-reg 行已过期的真实
  codex, 注册后拿走了另一个 pane 的 key/pane/pid/tty 四项, 决策日志无任何 identity_key
  拒绝 —— 与上面的推演完全一致.  同一次跑还查明: 真实 codex **注册时不传 identity_key**,
  尽管 MCP instructions 明确要求且环境变量确实在进程里.  因此归属判定里的
  `identity_key_contradiction` 只对 "agents 行上已存过 key" 的身份有效 (行上的 key 靠
  `identity_key = COALESCE(excluded.identity_key, identity_key)` 在无 key 重注册时保留),
  首次注册的身份落不到这条最强证据上.  推论: **任何依赖调用方自报身份的规则都不可靠**,
  而 "受害者 pane 上有活载体" 一类规则零区分度 (正路上 caller 就是那个活载体), 所以跨
  仓库契约不是锦上添花, 而是整条证据链缺的那条边 —— 优先级应提到最前.

  **R21 评审补的最后一个洞 (round-21b)**: 上面写的"附 key 失败必须把消费一起回滚"
  在代码里只对**抛出的异常**成立.  附 key 内部还有三条**返回式拒绝** (caller 行不存在 /
  caller 持另一把 key / planner 判定 holder 在线), 它们 `log + return`, 提交照常发生 ——
  于是提交下去的正是本设计要防的最坏状态: 在位 pane 已被 LWW 驱逐、恢复行已消费、key
  却没附上, 而那行是这把 key 的唯一载体.  拒绝与抛错必须走同一条路: 拒绝一律转成抛错,
  由同一个事务整体回滚.  教训与 D4 那次同源 —— **"拒绝"和"回滚"不是一回事**, 只要拒绝
  是 return 出来的, 事务就不知道它发生过.

附 key 拒绝一律回滚整个提交事务; 回滚后的 auto-bind 失败仍遵守既有 "auto-bind 失败不
腐蚀 register 结果" 约束 (注册本身照常成功, 只是没有绑定与消费).

### D5: 取消与幂等语义跟随 pre-reg 行生命周期

调度句柄以 pane_id 为键, 内存 Map; 每代调度另携带唯一 generation token
(`codex-recovery:<pane_id>:<generation>`, 决不复用):
- 行被 auto-bind 消费 (codex 自行注册成功, 无论是否被 poke 过) → 取消 pending 调度
- 同 pane 新 pre-register 覆盖 → 取消旧调度, 按新行 (新 key 或无 key) 重新决策
- 行过期 → 探测轮询自然终止
- 瞬态拒绝 (guard_failed / 载体后台化) → 同代回到探测轮询按探测间隔续试, 不新建代,
  不入任何重试梯子; 发送终局 (送达或终态失败) 则退休本代
- 组合取消 (消费/覆盖/关停) 只退休当前代的 token; 过期闭包 (被覆盖的调度、悬挂中的
  send) 只允许取消自己那一代, 决不触碰新代调度
- 主动取消与过期各记一条终局取消日志 (消费→row_consumed / 覆盖→row_replaced /
  关停→daemon_shutdown / 过期→row_expired; 带 ISO 时间戳, 决不含 key 值)
- daemon 关停 (onClose) 在 db.close 之前清空全部调度与各代 token; 进行中的发送在
  下一个 await 检查点观察到取消并中止

### D6: holder 存活时不调度恢复 poke

`findByIdentityKey` 命中但 holder 行的 `runtime_ui_pid` 进程仍存活, 说明 key 持有者
还在运行 (aoe 异常或双实例) — 此时 poke 新 pane "你是 <name>" 只会引导它注册进
`identity_key_conflict`.  跳过调度并 debug 记录, 留给显式注册路径报冲突.

### D7: poke 话术为 daemon 端固定模板

模板要素: 自报来源 (xats daemon 恢复通知)、恢复出的 (team, name)、指示调
`register_agent({agent_type:"codex", name, team, thread_id: $CODEX_THREAD_ID})`、
project_dir 取当前工作目录.  话术不含 identity_key (见 D3, 上下文可见面最小化).

### D8: seat-follow — 同 pane 重注册的 key 跟随, 存活 holder 只认 thread 等同

codex 同会话 rename (pre-reg 行已在首次注册被消费) 走 `detect_tmux_pane` fallback;
绑定落定后 daemon 按 rebind 后仍存活的字段 (`runtime_ui_pid` / `runtime_tty` — 旧行
`tmux_pane_id` 已被 last-writer-wins 清空) 查同 device 上仍持 key 的其他行, 恰好一个
候选时决定是否把 key 迁到 caller 行.  授权判定: **存活 holder 只在 caller 行与 holder
行的 codex-appserver `thread_id` 相等时迁移**.  thread_id 由注册方随 register_agent
上报并存进两行的 delivery payload, 同会话 rename 天然带着 holder 行已有的同一 thread
— 这是可验证的 caller↔process 关联.  fallback 记录的 carrier pid 来自全局 pane 启发式
(detectTmuxPane 给所有 pane 打分 + tty 前台载体探测只证明 "该 tty 上有唯一前台
codex"), 与本次 register_agent 调用者无关联: 无关 codex Y 注册时启发式可能选中存活
holder X 的 pane 并把 X 的 pid 绑到 Y 行, 若以 pid 相等授权就会把 X 的 key 迁给 Y
(身份数据损坏).  因此 pid/tty 相等对存活 holder 永不足够; thread 任一侧缺失或不等
一律 fail-closed, 只记 debug (决不含 key 值).  holder 行**没有记录 pid** (或 pid 非正数)
时存活性为 UNKNOWN, 决不当作死亡 — pid-less 是合法的存活状态 (verified_tty_pane 绑定
本就不带 pid), 与存活 holder 同等对待: 仍只认 thread 等同, 缺失/不等 fail-closed
(debug 记 liveness_unknown 与 thread 原因, 决不含 key 值).  死 holder 分支只对
**正数记录 pid 且仲裁时刻 fresh 存活复查确认已不在运行**的 holder 开放, 保持既有四分支
migrate 语义 (同座重启无 pre-reg 行, 旧行清 key 与新行绑 key 同一事务).  另: carrier
pid 绑定失败 (pid_not_found / pid_pane_tty_mismatch) 不降级 tty-only 绑定 — 只此一次
尝试, 不跑 seat-follow, key 不动.

备选 (放弃): caller pid == holder pid 作为同进程证明 — pid 是启发式绑定的, 见上;
注册时直接带 identity_key — app-server 读不到 env (见 D1).

### D9: same-thread 证据统一语义 — 有证据即决不扫 pre-reg、决不全局探测

线上事故 (生产 DB 证据): 会话 A (`aoe-codex` 行, codex-appserver thread T, 已绑
pane/pid, 持 K1) 同 thread rename 成 `aoe-codex-r2` 时, 一个**无关** shell codex 的
pre-reg 行 (不同 pane, uuid U_shell, key EECF3E35) 恰好 pending.  autoBindCodexPane
唯一的关联手段是 "全机唯一候选" (0.7.7 假设一次只有一个 codex 在注册), 与调用者零关联,
于是 rename 注册消费了外来行: r2 绑走 shell 的 pane/pid 并附上 shell 的座位 key,
shell 自己的注册扫不到行 (tty fallback, 无 key), 且 r2 的座位指向错误 tty 导致
seat-follow 找不到 K1 holder, K1 永不迁移.

修复 (统一语义): codex 注册在扫 pre-reg **之前**先解析 same-thread 会话证据 — 同
device 上 codex-appserver thread 与本次注册 thread 相等且仍有 runtime 绑定
(`runtime_ui_pid` / `runtime_tty`) 的行 (`findRuntimeByThread`).  caller 自己被
`(device, team, name)` upsert 复用的行也算证据, 条件是它 **upsert 前** 存储的 thread
等于本次注册的 thread (upsert 保留行的 runtime 绑定但覆盖存储的 thread, 所以 register
流程必须在写入前捕获 pre-upsert thread; 同名但带新 thread 的注册 — 重启恢复 — 不构成
证据).  **只要存在任何 same-thread 证据, 本次注册就决不扫外来 pre-reg 行、也决不跑
无约束的全局 `detect_tmux_pane`** — 两者唯一的关联手段都是 "全机唯一候选", 与调用者
零关联, 走到它们就可能拿走无关 launcher 的 pane/pid/座位 key, 或绑上外来 pane
(runtime 身份损坏).  证据行按**物理座位**折叠: 共享正数 pid 和/或 tty 的行是同一个
座位 (rename 链 A→B→C 的自然状态 — 旧行 pid/tty 原样保留, 只有 pane 被
last-writer-wins 清空, 多行是常态不是异常), 每个座位归并到 last-writer-wins 持有者
(最新 `runtime_bound_at`, pane 仍在的行破平).  唯一物理座位即**精确继承**: 持有者有
正数 pid 走 `bind_runtime_identity` pid 路径 (fresh 校验 pid→tty→pane 存活); 无正数
pid 但记录了 tty 和 pane 则用既有 tty/pane bind 形状**精确绑定那个座位**, 决不用探测
替换.  多个不同物理座位、继承 bind 失败、或座位无可绑定 runtime 信息一律 fail-closed:
不扫 pre-reg、不做全局探测、不绑 runtime — register_agent 照常成功, 走标准 no-pane
hint 路径.  继承成功后既有 seat-follow 钩子照常运行 — 继承来的座位能找到 K1 holder,
thread 等同授权迁移 (见 D8).  只有**没有任何 same-thread 证据**的注册 (真正的新
thread, 如重启恢复) 才走 pre-reg 扫描, 再落 detect fallback.

**pre-upsert 捕获的 CAS 原子化**: codex 注册路径在捕获与持久化之间 await 异步
app-server 探测, 并发同名 `(device, team, name)` 注册可在该窗口内改写行, 使早期捕获
双向失真 — 或把真实的 caller-row 证据过滤掉 (漏到外来 pre-reg 扫描, 事故路径重开),
或把另一会话刚写入的座位当成 caller 自己的继承证据 (跨会话 runtime 绑定).  修复:
持久化 upsert 的**同一事务**内 SELECT prior → upsert → 原子返回行的实际 prior 状态
(prior codex-appserver thread + 完整物理座位字段 pid/tty/pane/runtime_bound_at;
better-sqlite3 事务同步执行, 无交错点), prior 经 register service 结果线程化到 tool
层 (对外 envelope 全路径剥离, 决不外泄).  tool 层做 CAS 比较: 探测前快照与事务返回
prior **不等** → 本次注册的 runtime auto-bind fail-closed (无 caller-row 证据、不扫
pre-reg、不全局探测、不绑 runtime, register 照常成功走标准路径); **相等** → 以事务
返回的 prior thread (而非早期捕获) 作为 caller-row 证据输入.  其他 same-thread 证据
行在写后读取即可 — 它们不是被竞争的行, CAS 只关心 caller 自己的行.  best-effort
捕获方案已被 review 否决, 原子性为硬要求.  全部决策 (none / 继承成功与失败 /
ambiguous / cas_drift) 经**单一决策点**记 debug 日志, 各带行数、座位数与涉及
agent id (决不含 key 值); cas_drift 带独立 reason.

**bind 阶段的 late-write 窗口与 generation 条件写**: CAS 只封住探测窗口, 封不住
bind 窗口 — CAS 通过后, register-time runtime bind 仍要 await 异步验证
(pid/tty/pane 探测), 而最终写此前只按 `agent_id` 无条件 UPDATE; 同
`(device, team, name)` 重注册复用同一 agent_id, 于是注册 A 挂起在 bind 验证中、
并发注册 B 完成同名注册 (thread U + 座位 S2) 后, A 的迟到写会把行踩成
`thread U + 座位 S1` 的跨会话杂交 (takeover 的 transport close 不会取消 A 已在
运行的 handler promise, 只能在持久化处拦截).  修复: agents 表加
`register_generation` (INTEGER NOT NULL DEFAULT 0, 幂等迁移), register upsert
同一事务内自增并把铸出的 generation 随注册结果内部线程化到 tool 层 (对外
envelope 与 prior_snapshot 一并剥离); 全部四条 register-time bind 路径 (显式
ui_pid、same-thread 继承、pre-reg auto-bind 消费、detect fallback) 把本次注册的
generation 传到 setRuntimeBinding, 最终写变为条件写
`WHERE agent_id = ? AND register_generation = ?` — 0 行即该次 bind fail-closed:
不写任何 runtime 字段、跳过在位 pane 驱逐、不跑 seat-follow, 记
`stale_registration_bind` 独立 reason (只记数量与 agent id, 决不含 key 值),
register_agent 照常成功.  用户显式调用的 `bind_runtime_identity` tool 不属于
register-time 路径、没有自己铸出的 generation, 但同类 late-write 竞态照样存在
(A 的手动 bind 挂在验证 await, B 同身份重注册并绑 S2, A 恢复后无条件写会把 S1
盖回去) — 修复: service 在**调用开始**捕获 caller 行当前 generation 作为条件写
的期望值 (capture-at-call-start), 调用前已完成的历史注册不挡显式修复, 调用期间
落地的新注册使条件写 0 行、同样以 `stale_registration_bind` fail-closed; 经
BindRuntimeIdentityService 的每一次最终写都是条件写, 未来忘传 generation 的
调用方也被结构性覆盖.  同时注册成功结果的 `register_generation` 在类型上为必填,
tool 层拿到无 generation 的畸形内部结果 (注入的测试替身) 时记 invariant error
日志并让 runtime auto-bind fail-closed, 条件写决不静默退化为无条件写.

**CAS drift 的残留座位清空**: drift fail-closed 只"不再新绑"还不够 — register
upsert 用 COALESCE 保留了被竞争行的座位字段 (pane/pid, tty 等字段 upsert 根本
不触碰), 行会终结为 "本次注册的 thread + 被竞争会话的座位" 杂交, 而
dispatchCodex 在 appserver 普通失败时会 fallback 到该 pane (误投递).  修复:
drift 检出后用本次注册铸出的 generation 条件清空全部 runtime 座位字段
(`tmux_pane_id` / `runtime_ui_pid` / `runtime_tty` / `runtime_verification_mode`
/ `runtime_bound_at`); 更新一代注册已推进 generation 时清空 0 行、其新绑座位
不被触碰; 清空结果随 cas_drift 决策一起记 debug 日志.  行的终态是真正的
unbound, appserver 投递 (按 thread) 不受影响, tmux fallback 无 pane 可误投.

**内部契约收口 (round-16 warnings)**: ① `prior_snapshot` 在注册成功结果类型上
必填 (null 仅作为新行的合法无-prior 值) — codex 结果整个缺字段会伪装成对 null
pre-upsert 捕获的 CAS match, 现按 CAS drift 处理并记 invariant error;
② generation 运行时校验收紧为正 safe integer (`Number.isSafeInteger && >= 1`) —
NaN/Infinity/负数会让每次条件写静默 0 行; drift 清空在无有效 generation 时跳过
并记 skipped 日志, 决不静默声称已达 unbound 终态; ③ register-time 入口
(tools.ts 四条路径 helper 与 AutoBindCodexPaneInput) 的 generation 参数类型必填,
未来 register-time 调用方无法漏传而退化到 call-start capture 语义 (那会拿到
并发注册 B 的 generation 写 A 的座位); ④ (round-17) service 边界本身也不留静默
开关: BindRuntimeIdentityService 输入的 generation mode 为 discriminated 二选一 —
`{ expectedRegisterGeneration: number }` 或 `{ captureCurrentGeneration: true }`,
手动 rebind tool 显式选后者, 直接调 `.bind()` 的未来调用方也必须显式表态;
⑤ (round-17) invalid generation + CAS drift 的注册响应带专用 invariant hint
(残留 pane 绑定可能仍在, 建议显式 bind_runtime_identity 修复), 决不复用标准
no-pane hint — 那会在残留座位可能仍挂着时谎称行上无 pane.

备选 (放弃): pre-reg 行绑定 caller 关联标识 — codex 注册时上不来任何可关联 pre-reg
行的标识 (见 D1), 关联只能来自 daemon 侧已有事实; 收紧 "全机唯一候选" 为按 pane 精确
匹配 — caller 同样报不出自己的 pane, 无从匹配; "恰好一个命中才继承, 多命中回退扫
pre-reg" — rename 链天然留下多行, 多命中回退等于把最常见形态送回事故路径, 已被
review 否决; bind 前重查 CAS — 重查与最终写之间仍有间隙, 只有把条件压进 UPDATE
本身才是原子的.

## Risks / Trade-offs

- [探测命中→进程崩/退后台→paste 进 shell 的窗口] → 写入前 pane-host-verify + 复合
  同步 confirm (含前台载体证明: STAT 无 T/t/Z + 命令仍匹配含 uuid 的 codex --remote
  + pgid === tpgid) 在 pre-capture、paste 前与 Enter 前三个写检查点各执行一次 (见
  D2), 探测命中不免除发送时校验; paste 与 Enter 之间进程退出或退后台以
  `ownership_lost` 中止不执行
- [daemon 重启丢调度] → v1 接受: 窗口 ≤ pre-reg TTL (最长 600s), aoe 侧降级路径
  (用户手动开口) 仍可用; 后续可加启动时重扫未过期带-key 行
- [codex 冷启动超过 TTL] → aoe 侧传 `ttl_seconds` 放宽 (对方分工已确认); daemon 不改
  默认值, 避免影响无 key 的现有调用方
- [同设备知道 key 的进程抢身份] → 与现有威胁模型一致: 本地同信任域 (全部过 daemon
  token), holder 存活时四分支拒绝, device-scoped 索引杜绝跨设备冒用
- [poke 话术即 prompt, key 串实例会引导错误身份] → D4 mismatch 不覆盖 + D6 存活跳过
  双重兜底; aoe 侧 write-once key 是第一道防线

## Migration Plan

1. schema.ts 幂等迁移: pre-reg 表 ADD COLUMN identity_key (可空), 无回填
2. xats 先发版 (0.7.8 或 0.8.x); aoe 侧 `--identity-key-env` (key 走环境变量, 不落
   argv) 带标志失败降级不带标志, 老版本 daemon 对未知参数返回 invalid_arguments
   即触发降级, 顺序不敏感
3. 回滚: 该列可空且无读取方依赖, 回滚代码即可, 无数据迁移

## Open Questions

- 无.  探测轮询间隔 (5s) 与话术模板措辞属实现细节, 实现阶段定稿.
