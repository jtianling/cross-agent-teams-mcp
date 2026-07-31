## Why

tmux poke 的投递目标是**注册行上记录的 `tmux_pane_id`**, 而 pane 是会被别人接管的物理资源.  两者之间没有任何校验, 于是注册行一旦"腐坏" (进程死了但行还在), poke 就会打到**当前占用该 pane 的另一个 agent** 身上 —— 而 mailbox 行仍写在原目标名下.  唤醒与信箱就此分家.

2026-07-27 ~ 07-28 的真实事故: `webdot` team 的 `tester-2` 于 07-24 进程退出, 注册行连同 `tmux_pane_id=%19` 保留; `sub2api` team 的 `reviewer` 于 07-27 接管了 `%19`.  此后 webdot-main 发给 tester-2 的 **12 条 broadcast + 1 条直发**, poke 全部注入到 reviewer 的终端, 而 reviewer 每次 `get_inbox` 都是空的 —— 它信箱里从头到尾只有一条无关消息.  受害方无法自查 (看不到跨 team 的 `list_agents`, 也无法反查 pane 被谁登记过), 前后浪费十几个回合, 最终动用三个 team 联合排查才定位.

两个方向的损害都真实发生了:

- **误报**: 无关 agent 被反复唤醒, 每次空查信箱
- **漏报 (更严重)**: 真正的收件人收不到唤醒, 消息静静躺在信箱里.  webdot-main 因此空等 tester-2 的交叉验收好几天, 一直以为任务在跑

事故当时全库 105 条本地 pane 绑定里 **99 条已腐坏** (pid 已死或 pane 已不存在), 十几个 pane 上堆着 2-5 条历史绑定 —— 这不是个例, 是绑定只增不减的必然结果.  存量已于 07-28 手工清空 (104 条), 但**产生机制未修复**, 不做本变更会重新长回来.

关键讽刺: 存活判定 `isAgentLive` **早已实现**, 但只服务于 `list_agents` 的 `online` 字段, 投递路径一次都没调用.  所以 `list_agents` 明明显示 `online: false`, poke 却照发不误, 且 `poke_skip_reasons` 里从不出现该目标 —— 每次都是"投递成功".

## What Changes

- tmux 注入前新增**宿主校验**: 校验该 pane 当前仍由目标 agent 占用, 不通过则跳过并记新的 skip reason `pane_reassigned`.  校验按"设备 → pid 存活 → pid 与 pane 的 tty/pane_pid 一致 → 无 pid 时的排他性回落"四级判定, 首个匹配生效
- 校验落在 **poke 原语的 tmux 分支**, 因此同时覆盖 `send_message` / `broadcast` / `broadcast_to_role` / 重试 tick / `poke` 工具直调 —— 事故中那条直发证明只修 broadcast 收件人查询是补不全的
- 注册期 pane 绑定改为 **last-writer-wins**: 某行绑定 pane P 时, 同设备其他行对 P 的绑定在同一事务内清空
- 唤醒提示补上**目标身份** (`→ {name}@{team}`), 让"收到 poke 但信箱为空"的受害者一眼定位, 而不是跨 team 联合排查
- `pane_reassigned` 不排重试 (与 `no_pane` 同类: 重试不会让宿主变回来)

## Capabilities

### New Capabilities
<!-- 无新增 capability: 全部落在既有 poke / 注册 / 邮箱三条既有路径上 -->

### Modified Capabilities
- `agent-delivery`: tmux 注入前的宿主校验判定规则; 路由要求中两条 tmux 回落分支受该校验约束
- `agent-registry`: pane 绑定改为 last-writer-wins; 澄清"投递不依赖存活性"与"tmux 注入需宿主校验"的边界
- `mailbox`: 新增 `pane_reassigned` skip reason 及其不重试语义; 唤醒提示格式增加目标身份

## Impact

- `src/mcp/poke.ts` — tmux 分支前置校验
- `src/mcp/transport-dispatch.ts` — `dispatchClaude` / `dispatchUnknown` 等所有 `dispatchTmux` 入口统一走校验
- `src/mcp/auto-poke-fanout.ts` / `src/mcp/fanout-with-retry.ts` — 新 skip reason 的透出与不排重试
- `src/mcp/delivery-status.ts` — `DeliverySkipReason` 联合类型扩容
- `src/storage/agents-repo.ts` — 注册事务内的 last-writer-wins 解绑
- `src/mcp/tools.ts` — `buildAutoPokeHint` 增加目标身份
- 向后兼容: 校验通过的路径行为逐字节不变; 校验不通过的路径此前是**误投**, 现在变为显式 skip, 不存在"原本正确现在被拦"的情形

## Out of Scope

- **`unknown_agent` 反复失绑**: 回合开头第一次调用即 `unknown_agent`, 需重新 `register_agent` 才恢复.  共同点是 **MCP session 被换掉**, 与 pane 绑定腐坏不同源.  daemon 重启只是其中一种触发方式 (已实证 `2026-07-27T10:06:24Z` 有一次, 落在 reviewer 的时间窗内); 但 `2026-07-28T03:26Z` xats-main 那次是**反例** —— daemon 进程未变 (`pid 67479`), agents 行完好 (`agent_id` 与 `runtime_ui_pid` 均未变), 绑定仍然丢失, 是 MCP 连接自身断开重连所致.  这一类没有任何外部事件可关联, 立项时若只盯 daemon 生命周期会漏掉它
- **注册/重连/session 生命周期无审计**: `events` 表只记 `message_sent`, 上述两次失绑都只能靠 `ps` 与直接查 sqlite 定位, 库里没有任何痕迹.  这与上一条应合并为同一个 change —— 不补审计就查不出来, 只修失绑等于下次继续手工排查
- 后台定时清扫离线行的 pane 绑定 —— 本变更的 pid 校验是其惰性等价物, 更实时且零成本
