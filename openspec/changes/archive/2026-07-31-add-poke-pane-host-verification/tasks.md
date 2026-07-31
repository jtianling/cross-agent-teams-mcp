## 1. 宿主校验原语

- [x] 1.1 新建 `src/mcp/pane-host-verify.ts`, 导出纯函数 `verifyPaneHost({ row, paneSnapshot, localDevice, isProcessAlive })`, 返回 `{ ok: true } | { ok: false; reason: 'pane_reassigned' }`
- [x] 1.2 实现四级判定 (device → pid 已死 → pid 存活且 tty/pane_pid 匹配 → 无 pid 时的排他性回落), 首个匹配生效; pid 存活判定复用 `src/daemon/pid.ts` 的 `isAlive` (EPERM 视为存活)
- [x] 1.3 pane 快照复用 `listTmuxPaneRows`, 但 `#{pane_pid}` 当前未在 `TmuxPaneRow` 里, 需在 `src/daemon/tmux-pane-list.ts` 的 format 串与解析中补上该字段
- [x] 1.4 第 4 级需要"同 (device, pane) 是否存在已确认活宿主的其他行", 通过注入的查询函数提供, 保持本模块无 DB 依赖便于测试
- [x] 1.5 单测: 四级各自的通过/不通过, 以及 tmux 快照为 null (不可用) 时不返回 `pane_reassigned`

## 2. 接入 dispatch

- [x] 2.1 `src/mcp/transport-dispatch.ts`: 在 `dispatchTmux` 入口处统一校验, 使 `dispatchClaude` / `dispatchCodex` / `dispatchOpencode` / `dispatchKimi` / `dispatchUnknown` 五条回落路径自动覆盖
- [x] 2.2 `DispatchDeps` 增加校验依赖与 pane 快照, `TargetRow` 补 `device` / `runtime_ui_pid` 两个字段 (当前只有 `agent_type` / `delivery` / `tmux_pane_id`)
- [x] 2.3 `src/mcp/poke.ts`: SELECT 补上 `device` / `runtime_ui_pid`; 无 fanout 的 legacy tmux 分支同样走校验
- [x] 2.4 校验不通过时返回 `{ error: 'pane_reassigned', transport_used: 'tmux-poke' }`, 不执行 quiet-guard, 不做任何 tmux 写操作
- [x] 2.5 测试: 五条回落路径各构造一次"宿主不匹配", 断言零注入且 reason 正确

## 3. skip reason 透出

- [x] 3.1 `src/mcp/auto-poke-fanout.ts` 的 `AutoPokeSkipReason` 与 `src/mcp/delivery-status.ts` 的 `DeliverySkipReason` 增加 `pane_reassigned`
- [x] 3.2 确认 `pane_reassigned` 不进重试: 现有条件是 `res.reason === 'guard_failed'` 才排 tmux 重试, 应无需改动, 加测试锁住该行为
- [x] 3.3 `send_message` / `broadcast` / `broadcast_to_role` 三个工具 description 里的 skip reason 列表补上该值
- [x] 3.4 测试: `get_delivery_status` 能查到 `skipped` + `skip_reason='pane_reassigned'`

## 4. 一轮 fan-out 复用一份 pane 快照

- [x] 4.1 `fanoutAutoPoke` 在开始前取一次 pane 快照, 经 `AutoPokeArgs` 透传到 poke 原语, 避免每个收件人各查一次 tmux
- [x] 4.2 单收件人路径 (`send_message`) 与重试 tick 各自取一次即可, 不共享
- [x] 4.3 测试: N 个收件人的 broadcast 只触发一次 `tmux list-panes`

## 5. 注册期 last-writer-wins

- [x] 5.1 `src/storage/agents-repo.ts`: 在 `register` 事务内, 写入 pane 后执行 `UPDATE agents SET tmux_pane_id=NULL WHERE device=? AND tmux_pane_id=? AND agent_id != ?`
- [x] 5.2 `setRuntimeBinding` 是 `bind_runtime_identity` 与 codex pre-reg auto-bind 的共同写入点, 同样纳入且包在事务里
- [x] 5.3 只清 `tmux_pane_id`, 不动 `agent_id` / 游标 / mailbox / `delivery` / `runtime_ui_pid`
- [x] 5.4 测试: 抢占后旧行 pane 为 NULL 且其余字段逐字段不变; 跨设备同名 pane 不受影响; 同 agent 重复绑定幂等; 任意序列后 `(device, pane)` 分组不超过一行

## 6. 唤醒提示带目标身份

- [x] 6.1 `buildAutoPokeHint` (`src/mcp/tools.ts`) 增加目标行入参, 渲染 `→ {name}@{team}`
- [x] 6.2 目标行解析不到时省略整个 ` → ...` 段, 不留占位符
- [x] 6.3 `createAutoPokeImpl` 与 `poke-retry.ts` 的重试 tick 两处调用点都传目标行
- [x] 6.4 测试: 同 team / 跨 team / 无 display_name / 目标不可解析 四种渲染, 以及最长标签下不超过 200 字符

## 7. 回归与验收

- [x] 7.1 复现事故: A 绑 pane P 后杀掉进程, B 注册占用 P, 从 A 的 team 向 A 发消息 → 断言 B 的 pane 零注入、A 的 mailbox 有行、发送方看到 `pane_reassigned`
- [x] 7.2 同一场景走直发 `send_message_by_id` 再验一次 (事故中确有一条直发中招, 只测 broadcast 会漏)
- [x] 7.3 断言正常路径 (活宿主同 pane) 的注入行为与改动前逐字节一致
- [x] 7.4 `openspec validate add-poke-pane-host-verification --strict`
- [x] 7.5 全量 `pnpm test`
