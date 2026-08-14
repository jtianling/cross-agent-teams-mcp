## Why

座位换代后, xats 无法把新 pane 连回它原本的身份, agent 只能反问人"我叫什么".

现有的恢复链路完全建立在 `identity_key` 上: `pre_register_codex_pane` 收到 key → `findByIdentityKey` 反查持有者 → 用持有者的 `(team, name)` 发一条**带身份**的 recovery 通知 → agent 照着它重新注册.  这条链路只在 key 稳定时成立.  launcher 的 key 是按座位铸的, tmux 会话删除重建时随座位换代 (launcher 侧认定 by design: 新会话是新座位), 于是新 key 查无持有者, `evaluateCodexRecoveryOnPreRegister` 在 liveness 判断之前就 return, **永不排 recovery**.  剩下只有 seeding 通知可发, 而它只报 pane, 不报身份.

生产现场四个 agent 因此卡住, 每次会话重建都要人工改 DB 或人工报名字.  这不是 codex 专属: launcher 侧的 claude pane 同样 `need_register`, 差别只是能自读 key 的 runtime 下一代能自愈, codex 连自愈机会都没有 (工具跑在共享 app-server, 读到的 key 属于别的 pane).

根因是 xats 手里没有任何东西能跨会话重建把 pane 连回身份: key 重铸了, pane id 是新的, agent 行上存的 pane id 是上上代的, tty 会复用本就不能认亲.  **角色名从来只存在于人打给 agent 的那句话里**, 没有任何系统持久化过它.  launcher 已实现声明式配置 (change `declare-xats-pane-identity`), 把 `(team, name)` 变成可持久化、会话重建后依旧存在的配置字段.  本变更实现 xats 侧的消费.

## What Changes

- `pre_register_codex_pane` 接受可选 `team` / `agent_name`, 与 `identity_key` 并列持久化到 pre-reg 行 (新增两列 + 迁移).
- CLI `pre-register-codex-pane` 接受 `--team` / `--agent-name` 并转发; 二者独立可选, 允许只出现一个.
- 声明的标签在 pre-reg 入口 trim 后按现有身份标签规则校验 (name 拒 `:` `(` `)`, team 拒 `(` `)`), 并额外拒绝双引号、控制字符与 U+2028/U+2029 行分隔符, 违规返回 `invalid_arguments` 并指明字段, **不静默容忍** —— 否则调用方的降级重试会把配置错误救成静默成功, 声明被丢掉而 pane 看起来健康.
- key 查不到持有者时, 恢复通知改用声明的 `(team, name)` 排程, 发出**带身份**的通知; 声明也缺失才回落到现有的 seeding 通知.
- 冲突规则: 声明身份的行载体仍活着 → 不发通知并记日志, 绝不静默 takeover (继承现有 `holder_alive` 不变量); 声明与 key 查到的持有者不一致 → 以 key 为准并记冲突日志 (key 是运行时事实, 声明是配置意图).
- `register_agent` 工具描述引导**所有** runtime 读 `XATS_TEAM` / `XATS_AGENT_NAME` 自报身份 —— codex 走 pre-reg 通道, 其余 runtime 自读环境变量, 两条通道同一套字段.

## Capabilities

### New Capabilities

<!-- 无: 本变更扩展既有能力, 不引入新的能力域. -->

### Modified Capabilities

- `agent-registry`: `pre_register_codex_pane` 增加 `team` / `agent_name` 参数与标签校验; pre-reg 行增加两列与迁移; CLI 增加对应 flag; `register_agent` 描述增加 `XATS_TEAM` / `XATS_AGENT_NAME` 自报指引.
- `agent-delivery`: 恢复通知排程从"仅按 key 查到持有者"扩展为"key 未命中时按声明身份排程", 并定义活持有者与声明/key 冲突两条拒绝规则.

## Impact

`src/mcp/pre-register-codex-pane.ts` 与其 schema、`src/mcp/codex-pane-pre-register-repo.ts`、`src/storage/schema.ts` (pre-reg 表新增两列及迁移)、`src/mcp/codex-recovery-poke.ts` (排程与每轮重解析的持有者判定)、`src/cli.ts` (flag 解析与 `PRE_REGISTER_FLAGS`)、`src/mcp/tools.ts` (工具描述), 以及对应单元测试.

新增一处跨仓耦合, 而且它是**双向**的: launcher 在录入期本地实现了同一套标签字符规则, 以便坏值根本进不了持久层.

放宽的方向只是错配 —— "xats 允许但 launcher 输入框不让打", 用户当场就能发现.  **收紧的方向则会静默地让 launcher 已有的校验失效**: launcher 放行了一个 daemon 现在会拒的字符, 而 launcher 的降级重试只能读退出码, 分不清"daemon 不认识这个 flag"和"daemon 认识但值非法", 于是那次调用退化成一次**不带声明、却看起来健康**的启动 —— 正是本变更要消灭的那个病, 从另一个入口回来.

所以这不是一条礼貌性的知会义务, 是 launcher 侧的**正确性依赖**: 本仓库日后改动 `validateNameLabel` / `validateTeamLabel` 或声明标签的字符集时, 必须同步通知 launcher 侧.  本变更自身已经触发过这条一次 (标签在 review 后先后收紧了双引号与 U+2028/U+2029, launcher 侧据此同步).

launcher 侧的实现不在本变更范围内.  发布之前 launcher 会一直走"未知 flag → 降级重试"的路径, 属预期行为: `rejectUnknownPreRegisterFlags` 在联系 daemon 之前 `exit(2)`, 所以过渡期不会产生重复的 pre-reg 落库.
