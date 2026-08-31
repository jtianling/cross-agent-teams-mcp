## Why

daemon 往 codex pane 注入时, 唯一的"现在可以打字了吗"判据是静默守卫 (`runQuietGuard`): 抓 8 行 pane tail, 停 2 秒, 再抓一次, 两次字符串相等就放行。  它判的是"画面不动", 而注入的最后一步是 `tmux send-keys Enter` —— **一个阻塞式 TUI 菜单对这道守卫是完美隐身的, 它比正常输入框还安静**。

2026-08-31 02:10Z 这个缺口第一次收到账单。  codex 0.150.0 启动时弹出交互式更新菜单 (默认项 `1. Update now (runs npm install -g @openai/codex)`, `Press enter to continue`) 并阻塞等输入; 菜单画面静止, 守卫放行, codex-recovery 注入的 Enter 替 codex 选中了默认项。  codex TUI 退出去跑 `npm install -g`, 进程树结束, aoe 的 pane-died hook 把 pane 落回裸 `/bin/zsh`。  `~/.config/xats/local-daemon.log` 里 `%9`(monkeys-coder)、`%10`(mvr-coder)、`%7`(verifier) 三个 pane 在 `delivered` 之后再无任何 `register_agent bind`; 同一流程 02:36 重跑时 `delivered` 后 20 秒内三个 bind 全部到齐, 是干净的对照组。

守卫本身没有 bug —— 02:10:16 那两条 `guard_failed` 说明它正按写出来的样子工作 (开机画面还在画)。  问题是**"静止"这个代理指标不等于"就绪"**, 而这条路径专打刚重启的 codex, 正好是启动期菜单最容易出现的窗口。

## What Changes

- **给 codex 目标的 tmux 注入加一道就绪形态判据**: 在静默守卫通过之后、任何写入之前, 要求 pane 尾部呈现 codex 的空 composer 形态 (positive evidence)。  判否则本次不写入, 归还轮询循环。
- **用允许列表, 不用拒绝列表。**  匹配 `Update available` / `Press enter to continue` 这类字符串与 codex 版本绑死, 且挡不住 npm 确认、ssh host key 确认等任何其他阻塞式 TUI。  允许列表约束的是"我认得出这是可以打字的地方", 不是"我认得出这个特定的坑"。
- **理由是失败方向不对称**: 允许列表误判为否 → pane 不恢复, 可见、可重试、pre-reg row 到期自然收场; 现状误判为是 → pane 自杀, 静默且不可逆。  不能拿可恢复的失败去换不可恢复的失败。
- **判否使用独立的日志 reason, 不并入 `guard_failed`。**  允许列表有一个拒绝列表没有的爆炸半径: codex 一改 composer 渲染, 所有 recovery 会一起静默停摆。  该失败必须能与"画面还在动"区分开, 否则故障模式从"一个 pane 没恢复"变成"全部 pane 没恢复且没人知道为什么"。
- **不新增重试机制。**  codex-recovery 的既有 `resumeProbePolling` (`RECOVERY_PROBE_INTERVAL_MS = 5s`, 由 pre-reg row 生命周期兜底) 就是这条路径的重试, 判否只需成为第三种 transient refusal。  `send_message` auto-poke 那条 30s/180s/600s 阶梯不属于本路径, 不引入。
- **范围只覆盖 codex 目标**: codex-recovery (`codex-recovery-poke.ts`) 与同形态的 codex-seeding (`codex-seeding-poke.ts`)。  两者最终都汇入 `tmuxPokeImpl`, 所以判据作为该原语的一个**可选谓词参数**由 codex 侧调用方传入。

**明确不做**:

- **不改 `runQuietGuard` 本身。**  它还服务 claude 等其他 pane, 那些 pane 的"就绪形态"完全不同; 把 codex composer 的允许列表塞进通用守卫会废掉所有非 codex 的 poke。  未传谓词的调用方行为一字不变。
- **不覆盖普通 `send_message` 回落 tmux 打到 codex pane 的同类洞。**  同一病灶, 但暴露面小得多: 能被普通 poke 找到的 agent 已经注册过, 早过了启动菜单窗口。  design 中点名, 不在本变更范围。
- **不做 codex 侧的 `check_for_update_on_startup=false`。**  那是 aoe launcher 的范围, 已由对方在做, 且它才是根因侧的修复; 本变更是纵深防御, 挡的是下一个还没见过的阻塞菜单。
- **不做形态字符串的运行时可配置 (环境变量覆盖)。**  可观测性需求由独立 log reason 满足; 配置项是投机性的灵活度。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `agent-delivery`: 新增"codex 目标的 tmux 注入要求就绪形态的正面证据"这一要求, 并修订 "Recovery poke first send is gated on codex process detection" —— 其 transient refusal 从两种扩为三种, 送出序列在静默守卫与写入之间插入就绪形态判据。

## Impact

`src/mcp/poke.ts` (`tmuxPokeImpl` 增加可选的就绪谓词参数, 在守卫之后、`capture_before` 之前求值), 新增一个形态判据模块及其在 `src/mcp/codex-recovery-poke.ts` 与 `src/mcp/codex-seeding-poke.ts` 两个调用点的接入, 以及两者 transient refusal 分类与日志 reason 的扩展。  `src/mcp/poke-guard.ts` 不改。  对应单元测试 (tmux 全部 mock, 不起真实 tmux)。

**没有用户可见的行为变化**, 除了一种情况: codex pane 停在非 composer 形态时, 恢复注入现在会推迟而不是打进去。  那正是本变更的目的。
