## Context

`reconnect` 在实现上不是一种独立的恢复机制.  `executeClaudeReconnect` (`src/mcp/tools.ts`) 做的事只有两步: 用某个键反查出 `(team, name, device, role)`, 然后拿它去调 `executeRegister` —— 和手工 `register_agent` 走的是同一个函数.  codex / kimi / opencode 三个分支形状完全一致, 只是反查键不同.

因此本变更的性质是 **加第四个 resolver, 不是加一套机制**.  接管语义 (同 `agent_id`、保留未读游标、关闭旧 MCP 连接、`ui_pid` 驱动的 pane 与 channel 重绑) 全部来自现有 register 路径, 一行都不需要重写.

现有三个反查键都是进程级的: `runtime_ui_pid`、codex `thread_id`、kimi/opencode `(base_url, session_id)`.  它们能救 `/clear`, 救不了 restart —— restart 之后三个键全变.  codex 尤其彻底: `thread_id` 换掉之后没有任何恢复手段.

外部依赖: `agent-of-empires` 的 `preserve-xats-identity-across-restart` 变更负责 mint 并注入这个键.  环境变量名 `XATS_IDENTITY_KEY`、注册期四分支规则、claude / codex 两种 reconnect 形状、hint 分支顺序, 均已与该项目双方书面锁定.

## Goals / Non-Goals

**Goals:**

- 让一个被真正重启 (而非仅 `/clear`) 的 pane 恢复它此前的 xats 身份, agent_id 与未读游标不变
- 身份的所有权完整留在 xats 侧, launcher 只持有一个不透明值
- claude 与 codex 两条路都覆盖
- 不传 `identity_key` 时, 所有现有行为逐字节不变

**Non-Goals:**

- 跨设备恢复身份
- 让 launcher 读取、显示或配置 `team` / `name`
- 由 proxy 代替 agent 注册
- 防住"键被复制后用来偷身份" —— 这在 daemon 侧无法判定, 见 Decision 4

## Decisions

### Decision 1: 键存在 `agents` 行上, 不复用 codex 预注册表

`codex_pane_pre_registrations` 里那个 uuid 和本变更的键形状相似但语义相反: 前者是**一次性证据** (证明某 pane 里的进程是 launcher 起的), pane_id 主键, TTL 120s, 消费即删; 后者是**持久别名** (说明某身份叫什么), 生命周期等于身份本身.

合表的具体后果不是抽象的"语义不清", 而是 `deleteExpired` 会按 TTL 扫掉行 —— 身份会被定时删除.  因此 codex pane 同时携带两个 uuid, 各走各的.

### Decision 2: 唯一性作用域是 `(device, identity_key)`

现有三个反查的第一个 WHERE 条件都是 `device = localDevice`, 因为 pid / thread / session 都只在本机有意义.  身份键没有理由破例: 跨设备恢复没有意义 (pane 在别的机器上), 而 device 作用域顺带让键被带到别的主机后自动失效, 这正是 AoE 侧"不加密不轮换"的前提.

SQLite 的唯一索引把 `NULL` 视为互不相同, 所以绝大多数没有键的行不受影响, 不需要 partial index.

### Decision 3: 注册期四分支, 而不是"已绑就报错"

最初和 AoE 商定的契约是二分: 键已绑到另一身份就报错.  这条在实现前被推翻, 因为它会误伤**用户改名**这个完全合法的操作.

推翻的依据是 schema 事实: 唯一约束是 `UNIQUE(device, team, name)`, 所以改名重注册**不是原地更新**, 而是 INSERT 一行新的、拿到新 `agent_id`, 旧行原封不动留着.  键还挂在旧行上.  二分规则下这次注册会直接失败; 就算放行, 下次 restart 也会恢复到用户已经抛弃的那个身份 —— 不报错, 但恢复错人.

四分支用"旧行的 `runtime_ui_pid` 是否指向一个活着的、不同于本次调用的进程"来区分两种情况:

- 旧行的 pid 为空 / 等于本次的 `ui_pid` / 进程已不存在 → 同一个 pane 在改名, 迁移
- 旧行的 pid 指向一个活着的其他进程 → 两个 pane 真的在抢, 报 `identity_key_conflict`

存活判定用 `process.kill(pid, 0)` 即可, 不需要引入 tmux 探测.

考虑过的替代方案: 让键无条件迁移 (总是后到者拿走).  拒绝的理由是两个 pane 会静默地来回争夺键, 症状只是"重启后恢复的是另一个身份", 没有任何诊断信息.

### Decision 4: 冲突检查只是第二道网, 防重复是 minting 侧的责任

在 reconnect 那一侧, "A 重启后恢复自己" 和 "B 拿着抄来的键偷 A 的身份" 是**完全无法区分**的两次调用 —— 参数一样, 结果一样.  daemon 不可能判定.

所以真正的防线只有一条: minting 侧克隆 / fork 时必须重新 mint.  注册期的冲突检查只能拦住"注册时两个 pane 都活着"这一种, 拦不住已经干净绑定之后的偷取.  这条认知写进 spec 正文而不只是设计文档, 免得后来者以为 daemon 侧已经防住了.

### Decision 5: `identity_key` 不进 exactly-one 互斥组

现有 zod 校验要求 `ui_pid` / `thread_id` / `base_url` 三选一.  身份键回答的是**哪个身份**, 那三个回答的是**哪个活着的运行时**, 是正交的两件事, 强行互斥会导致恢复完还要再调一次 `bind_runtime_identity`, 而那个中间窗口里 poke 会打到已经死掉的 pane.

所以:
- claude: `{identity_key, ui_pid}` —— 键定身份, pid 刷 pane/tty/csid
- codex: `{identity_key, thread_id}` —— 键定身份, thread 改写 delivery; **故意不传 `ui_pid`**, 因为传了会关掉 launcher 的 pane 预注册路径 (`autoBindRuntimeIdentity` 只在没有 `ui_pid` 时才回落到 `autoBindCodexPane`)

这与现有 codex reconnect 接受 `thread_id + ws_url` 的形状一致, 不是新模式.

### Decision 6: proxy 把键**内联填进** hint, 而不是让 agent 自己 `printenv`

整条链最脆弱的一环是"agent 在它的第一次 `register_agent` 里必须带上键".  漏了的后果是: 绑定永远不发生, 后续每次恢复都返回 `need_register`, 而按设计 `need_register` 是正常状态 —— **两侧都不会报错**, 症状只是"这功能对某些 pane 就是不生效", 且无从诊断.

而这一步恰恰是全流程里唯一由自然语言 hint 驱动的一步.

缓解办法是把值直接烤进 hint 里给出的调用: channel proxy 是 Claude Code 的子进程, 继承 pane 的环境, 自己就能读到 `XATS_IDENTITY_KEY`.  agent 看到的是一句填好的、照抄即可的 `reconnect(...)`, 而不是"去读某个环境变量然后拼参数".

codex 没有 proxy, 只能靠 `register_agent` 的 tool description —— 加一条独立说明, 不塞进 `agent_type` 的 first-match-wins 探测序列 (键不指示运行时种类, 对所有 `agent_type` 都适用).

### Decision 7: 键从环境读, 不从 flag 读

`.mcp.json` 是**目录级共享**配置.  这条路早年踩过: proxy 曾经带 `--agent-team` / `--agent-name`, 结果同目录起两个 Claude, 两个 proxy 都往同一行写自己的 csid 互相覆盖 (见 `openspec/changes/archive/2026-04-19-add-claude-channel-transport/design.md`).  flag 会让该目录下每个实例拿到同一个值, 正好复现那个 bug.

环境变量是进程级的, launcher 逐 pane export, 天然不共享.  这也是 `KIMI_XATS_BASE_URL` / `OPENCODE_XATS_BASE_URL` 已经在用的模式.

### Decision 8: 变量名避开 `TOKEN` 字样

本项目里 `XATS_TOKEN` 已经是 daemon 的 bearer 认证 token (`docs/configs/codex-cli.md`, `README.agent.md`), 而且会和身份键在**同一个 launcher shell 里并存**.

如果两者都叫 `*_TOKEN`, 一次顺手的混用 (把 bearer 当身份值 export) 会让全设备每个 pane 拿到同一个值 → 所有 pane 恢复成同一身份互踢, 而每一步看起来都配置正确.  这个失败模式足够严重且足够隐蔽, 值得为它换个名字: `XATS_IDENTITY_KEY`.

DB 列名同样用 `identity_key`, 与 AoE 侧列名一致 —— 不是协议要求, 只是跨项目排查时同名省事.

### Decision 9: 身份跟着 slot 走, 不跟着工具走

同一个 pane 换工具 (原来跑 claude, 后来跑 codex) 时, 新工具会拿同一个键恢复同一个 `(team, name)`.  daemon 覆盖 `agent_type` 与 delivery, 保留身份与 `agent_id`.

这是预期行为: 那个 pane 在队友眼里就是同一个协作者, 换掉底层工具不该改名.  记在这里是因为将来一定有人问.

## Risks / Trade-offs

- [agent 首次注册漏传键] → proxy 把值内联进 hint 的调用模板 (Decision 6); codex 侧靠 tool description.  这是本设计唯一无法在任何一侧观测到的失败, 缓解只能放在提示词层
- [hint 文案改坏, 连带破坏现有 `/clear` 恢复路径] → 分支顺序在 spec 里定死并有独立场景覆盖; 无键时 hint 要求与改动前**逐字节相同**, 使回归可机械检测
- [键被复制到克隆的 pane] → daemon 侧只能拦"两个都活着"那一种 (Decision 4).  真正的 guard 在 AoE 侧, 已在对方 spec 的 requirement 正文中承重
- [旧行 pid 复用导致误判为冲突] → pid 复用会把"改名"误判成"冲突", 表现为一次可见的注册失败并附带旧行 team/name.  可诊断、可重试, 优于反向误判 (静默迁移别人的键)
- [遗留数据库缺列] → 走既有幂等 healing 路径, 与 delivery 列、channel_session_id 列同一套机制
- [AoE 侧先 ship] → 注入一个没人读的环境变量是惰性的; 本侧未落地前不产生任何行为变化

## Migration Plan

1. 加列与唯一索引, 走幂等 healing.  旧库的所有行 `identity_key = NULL`, 行为不变
2. `register_agent` 接受并按四分支绑定; 不传时行为不变
3. `reconnect` 加第四个 resolver 与组合校验
4. proxy 读 env 并重排 hint 分支; 无键时输出与改动前一致
5. `register_agent` tool description 加独立说明段

回滚在数据层是安全的: 旧二进制忽略该列, 没人读的环境变量无副作用.

## Open Questions

无.  与 AoE 侧的五条契约已锁定, 改名场景的处理由 Decision 3 的四分支给出确定答案.
