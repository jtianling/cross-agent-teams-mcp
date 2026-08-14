## Context

恢复通知 (recovery notice) 是 xats 唯一能告诉一个失忆 agent "你是谁" 的通道.  它的身份来源只有一条: 用 pre-reg 行携带的 `identity_key` 反查 `agents` 表的持有者, 拿它的 `(team, name)`.

这条链路在**座位换代**时断掉.  launcher 的 key 按座位铸造, tmux 会话删除重建即随座位换代.  新 key 从未被任何 agent 行持有, `evaluateCodexRecoveryOnPreRegister` 命中 `holder === undefined` 直接 return, 恢复通知永不排程, 只剩下不带身份的 seeding 通知.  agent 于是反问人要 name 和 team.

问题的形状值得讲清楚: 会话重建后, xats 手里没有任何**残存的**线索能把新 pane 连回旧身份 —— key 重铸了, pane id 是新的, agent 行上记的 pane id 是上上代的, tty 号会复用 (这正是既有 requirement `Seat identity for key migration is the pane, never the tty` 存在的原因).  而角色名从来只存在于人打给 agent 的那句话里, 没有任何系统持久化过.  换句话说, **缺的不是推断能力, 是一份从未存在过的声明**.

launcher 侧已实现该声明 (change `declare-xats-pane-identity`): 每个 pane 可配置 `(team, name)`, 由 launcher 持久化, 会话重建后依旧存在, 并通过两条通道送达 —— codex 走 `pre_register_codex_pane` 的新参数, 其余 runtime 走 `XATS_TEAM` / `XATS_AGENT_NAME` 环境变量自读.  本设计只覆盖 xats 侧消费.

## Goals / Non-Goals

**Goals:**

- key 查不到持有者时, 恢复通知能改用声明身份排程, 使座位换代后的 pane 收到**带身份**的通知.
- 声明是可选的: 未声明时行为与本变更前逐字节一致.
- 声明永不夺取一个正在工作的身份.
- 非法标签在入口被拒绝且可被调用方识别, 不允许静默降级成"声明被丢掉但调用成功".
- 字段设计对所有 runtime 通用, 不做成 codex 专用.

**Non-Goals:**

- 不实现 launcher 侧的录入、持久化与传递.
- 不支持 pane 生命周期内修改声明 —— launcher 侧今天没有"重新配置已创建 pane"的流程, 声明只在 pre-reg 时读取一次, 不做变更监听.
- 不改变 `identity_key` 本身的语义、生成方式或 four-branch 仲裁规则.
- 不引入任何按座位标签/历史绑定推断身份的机制 (理由见 Decisions).

## Decisions

### D1: 声明是回落, 不是覆盖 —— key 命中时永远以 key 为准

排程时的判定顺序: 先按 `identity_key` 查持有者; 命中则完全走现有逻辑; **仅在未命中时**才考虑声明.

理由: key 是**运行时事实** (某一行确实持有它), 声明是**配置意图** (人希望这个座位坐谁).  配置漂移 —— 例如 jt 改了 launcher 里的名字但旧绑定还活着 —— 不该覆盖一个正在正常工作的绑定.  反过来, key 未命中恰恰意味着运行时事实缺失, 此时配置意图是唯一可用的信息.

两者不一致时以 key 为准, 并记冲突日志: 静默地择一会让"我的配置改了为什么没生效"变成不可诊断的问题.

**Alternative considered**: 声明优先于 key.  否决 —— 那等于让一次配置笔误就能把活着的 agent 从它的身份上顶下来, 而这个变更的全部意义只是"没有 key 时也能认人".

### D2: 拒绝按座位标签推断身份

一个不需要人配置的替代方案曾被认真考虑: launcher 虽然原先没有角色名, 但有稳定的座位标签 (会话名 + slot 序号).  xats 可以记住"上次这个座位绑的是谁", key 未命中时按座位标签发通知 —— 缓存放在 xats 侧, 不随 launcher 删除 slot 而消失, 且**人一个字都不用填**.

否决.  座位标签是**推断**, 不是**声明**.  座位被复用去干别的活时, 没有任何人说错任何话, xats 却会把上一代的身份安到新 agent 头上, 且悄无声息.

这与本仓库刚刚确立的原则同源: 身份判定只能建立在 daemon 自己拥有的事实上 (recovery nonce 之所以可用, 是因为 token 是 daemon 亲手写进某个 pane 的), 而不是"唯一候选者"一类的推断.  在通知这一侧重新引入推断是自相矛盾.  声明填错了是笔误 —— 有出处、可追责、可修; 推断错了没有出处, 只能等人发现"这个 agent 怎么用了别人的名字".

### D3: 活持有者 → 不发通知, 绝不静默 takeover

判定四分支:

1. 声明的 `(team, name)` 在本机无对应行 → 照发, 这是首次分配;
2. 有对应行、记录了正数 `runtime_ui_pid` 且进程已死 → 照发, 这是有死亡证据的恢复场景;
3. 有对应行且载体活着 → **不发**, 记 `holder_alive` (哪个 pane 声明了哪个身份、当前持有者是谁);
4. 有对应行但没有正数 `runtime_ui_pid` → **不发**, 记 `holder_liveness_unknown`.

**分支 3 不是新规则**, 而是既有不变量换了一条查到持有者的路: `codex-recovery-poke.ts` 在排程时与每轮探测重解析时都已有 `holder_alive → 不发`.  声明式查找必须原样继承, 否则一次配置笔误就能让通知去劝一个活着的 agent 交出身份 —— 那比"恢复不了"严重得多.

**分支 4 是新增的、更保守的读法, 只加在声明路径上, key 路径有意不变.**  同一个"无正数 pid", 两条路径给出相反的结论: key 路径读作 dead 并照常排程, 声明路径读作 unknown 并拒发.  这个不对称是刻意的, 理由是两条路径的持有者与本次 pre-reg 之间的关系根本不同 —— key 的持有者**证明地**属于同一条座位血缘 (它持有的正是 launcher 为这个 pane 铸的那把 key), 所以"接管"是自我接管; 而声明的持有者只是名字撞上了, `(team, name)` 是一个全局可寻址的元组, 别的 runtime 天天持有它.  同一个"无 pid", 在两条路径上的风险不是一回事.

这一段必须写下来, 否则下一个人读到两条路径不一致会去"统一"它, 而两个方向都是坏的: 统一到分支 4, key 路径的恢复被无谓削掉 (影响面很小, 但白削); 统一到 key 路径的读法, 分支 4 消失, 静默接管活身份的洞原样回来.

每轮重解析同样按声明重新判定, **活性处理与 key 路径一致 (复活即取消), 无 pid 处理则有意不一致** (声明路径拒发, key 路径照发).

pid 为空不是死亡证据: kimi-code、opencode、custom 与部分 codex 行在正常存活时也可能没有 pid.  因此分支 4 必须保守拒发.  代价是一个确实已经死亡但始终无 pid 的 runtime 不会自动恢复; 这是有意取舍, 因为丢掉一次恢复仍可人工修复, 静默接管活身份则会破坏原持有者的 delivery 坐标.

### D4: 标签校验在入口硬失败, 不容忍

`pre_register_codex_pane` 收到违反 `validateNameLabel` / `validateTeamLabel` 的声明时返回 `invalid_arguments`, detail 指明是哪个字段违反了哪条规则.

理由来自调用方的形态: launcher 的降级重试只能看退出码, **分不清"daemon 不认识这个 flag"和"daemon 认识但值非法"**.  若 daemon 对非法值宽容 (接受并丢弃, 或接受并存下), 则人最可能写出的 `mvr-coder(monkeys)` 会走出这样一条路: 调用成功 → pane 看起来健康 → 声明其实不存在 → 直到下一次会话重建才发现"怎么还是不认识我".  那正是本变更要消灭的病的又一种得法.

硬失败让这一类错误在录入期就暴露 (launcher 侧据此在输入期本地拒收非法字符, 使坏值根本进不了持久层).  代价是新增一处跨仓耦合, 记在 proposal 的 Impact 里.

标签还拒绝 Unicode 控制字符与 U+2028/U+2029 行分隔符.  后两者不属于 Unicode `Cc` 类, 单独列出是为了让"声明标签不含行终止符"这一合同字面成立.  这不是对新安全漏洞的修复: tmux `paste-buffer -p` 使用 bracketed paste, U+2028/U+2029 不会让通知提前提交; 收紧只是让标签和固定通知模板的单行字段保持一致.

### D5: 两条通道, 一套字段

codex 的工具进程跑在共享 app-server 中, 读到的环境变量属于启动那个 server 的 shell, 所以它**无法自读**声明, 只能由 launcher 经 pre-reg 通道代传.  其余 runtime (claude / kimi / opencode) 能读自己的环境变量, 走 `XATS_TEAM` / `XATS_AGENT_NAME` 自报.

因此: pre-reg 参数是 codex 的必需通道, 环境变量是通用通道, 两者字段语义相同.  `register_agent` 的描述面向所有 `agent_type` 说明这两个变量, 而不是只对 codex 开口 —— "座位换代后身份指针断掉"是所有 runtime 共有的, codex 只是连自愈机会都没有的那个极端.

### D6: 两列存在 pre-reg 行上, 而不是复用既有列

`team` / `agent_name` 作为两个可空列加在 `codex_pane_pre_registrations` 上, 与 `identity_key` 并列, 迁移时对既有行填 NULL.

它们必须与行同生命周期: 行被覆盖时一并被覆盖 (含"新调用不带声明则清空", 与 `identity_key` 现有语义一致), 行被消费或过期时一并消失.  把声明放在别处 (例如 agents 行) 会让它在 pre-reg 行之外独立存活, 于是"这个 pane 这一次声明了什么"就不再是一个可被 full-snapshot 保护的事实.

声明不进入 full-snapshot currency 比较.  安全边界不是 `expires_at` 是否恰好变化, 而是每次覆盖写都会在重新求值之前无条件调用 `cancelCodexRecoverySchedule(reason='row_replaced')`, 确定性退休旧 generation; 在飞 send 会在下一个 generation checkpoint 中止.  currency 比较继续只保护绑定事实, 不承担声明换代的安全职责.

## Risks / Trade-offs

- **配置笔误把身份安错** → D3 的活持有者拒绝挡住"顶掉活人"这一类; 剩下"目标身份是空闲的但名字写错了"仍会发出通知, 由人从日志与 agent 自述中发现.  这是声明式方案固有的代价, 换来的是错误有出处.
- **声明与 key 长期不一致而无人察觉** → D1 的冲突日志是唯一线索, 但日志不会主动提醒.  接受: 不一致本身不影响运行 (以 key 为准, 绑定正常), 只在下次换代时才实际起作用.
- **跨仓耦合**: launcher 侧编码了本仓库的标签字符规则.  → 规则变更时必须通知 launcher; 记在 proposal Impact.
- **无 pid 的死亡持有者无法自动恢复**: pid 为空只能证明 liveness unknown, 不能证明 dead.  → 保守拒发, 避免把 kimi-code、opencode、custom 或 pidless codex 的活身份静默接管.  代价已量过 (2026-08-14 生产库): 恢复通知的真实目标群体是"曾绑过 tmux pane 的 codex 行", 其中有 pid 的 16 行、无 pid 的 1 行, 分支 4 挡住的是 1/17 ≈ 6%; 全库持有 identity_key 且无 pid 的行共 2 个.  写下这两个数是为了让这个取舍不必被反复重开.
- **分支 4 是吸收态, 不只是"丢一次恢复"**: 一个身份一旦以无 pid 形态落库 (例如某次 auto-bind 走了 tty 分支而非 pid 分支), 之后**每一次**座位重建都会命中分支 4, 直到有人让它重新带 pid 注册 —— 而"需要人工介入"正是本变更要消灭的病.  → `holder_liveness_unknown` 日志写明后果, 使运维看得出这是会复发的状态而非一次性 skip.  若日后要收回这部分代价, 抓手是 `runtime_tty` / `tmux_pane_id` (tty 绑定的行并非全无活性线索, 只是没有 pid), 但那是另一个变更.
- **声明不可改不可清**: launcher 今天只支持建会话时录入.  → 本设计不假设声明会在 pane 生命周期内变化; 待 launcher 补齐后无需 xats 侧改动即可支持 (每次 pre-reg 都重新读取).
- **过渡期双次 pre-reg**: 发布前 launcher 每次都会先失败再降级重试.  → 无风险: `rejectUnknownPreRegisterFlags` 在联系 daemon 之前 `exit(2)`, 第一次调用根本不落库, daemon 侧看到的是单次干净写入.  降级重试保留 `--identity-key-env` 是必需的 —— 既因 launcher 自身规则, 也因本仓库"未过期且带 key 的行只有同一把 key 能替换"的规则会拒掉丢了 key 的重试.

## Migration Plan

pre-reg 表加两个可空列, 既有行 NULL.  pre-reg 行 TTL 以分钟计, 不存在需要回填的长寿数据.

回滚即回滚代码: 列留着不用, 声明被忽略, 行为回到本变更前.

发布顺序无约束 —— launcher 已先行发布, 在 xats 发布前一直走降级路径; xats 发布后 launcher 的首次调用即成功, 无需协调切换.

## Open Questions

无.  D1–D6 六条判定均已与 launcher 侧对齐并确认.
