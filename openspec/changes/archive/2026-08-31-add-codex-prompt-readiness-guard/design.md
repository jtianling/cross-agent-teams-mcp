## Context

daemon 有两条会往 codex pane 主动注入文本的路径: codex-recovery (`codex-recovery-poke.ts`, 重启后恢复身份) 与 codex-seeding (`codex-seeding-poke.ts`, 首次启动的并发消歧)。  两者最终都汇入同一个 tmux 注入原语 `tmuxPokeImpl` (`src/mcp/poke.ts`), 其写入序列是:

```
runQuietGuard  →  confirmOwnership  →  capture_before  →  load_buffer
   →  confirmOwnership  →  paste_buffer  →  settle
   →  confirmOwnership  →  sendEnter  →  settle  →  capture_after
```

这条序列在**所有权**维度做得很足: 三个同步 `confirmOwnership` 检查点, 加上 `codex-recovery` 传入的复合谓词 (generation 未取消、row 快照仍有效、holder 未漂移且仍已死、目标侧前台 carrier 证明)。  `poke.ts` 里那句注释 "pasted text is recoverable; an executed Enter is not" 说明"Enter 不可撤销"早已被意识到 —— 只是当时只往"pane 被别人接管"一个方向收口了。

**pane 此刻在显示什么, 全链路无人过问。**  唯一沾边的是 `runQuietGuard` (`poke-guard.ts`): 抓 8 行 tail, 停 `POKE_QUIET_MS` (默认 2s), 再抓一次, 相等即 pass。  它判的是"画面不动"。  全 `src/` 搜索任何屏幕形态检查, 零命中。

2026-08-31 02:10Z 的事故即由此: codex 0.150.0 的启动更新菜单阻塞等输入, 画面静止, 守卫放行, 注入的 Enter 选中了默认项 `Update now`。  日志显示 `%9`/`%10`/`%7` 在 `delivered` 后再无 `register_agent bind`, 而 02:36 的重跑 20 秒内三个 bind 全部到齐。

约束:

- `runQuietGuard` 是共享的, claude 等非 codex pane 的 poke 也走它。
- codex-recovery 的重试语义已经定型 (`resumeProbePolling`, 5s 探测间隔, 由 pre-reg row 生命周期兜底), 且 spec 明确写了 "SHALL NOT enter any long-backoff retry ladder"。
- 现有 spec 已确立 "ANY probe error, timeout, EPERM, missing column, or otherwise unknown state SHALL read as not-safe" 的 fail-closed 原则, 本设计继承它。

## Goals / Non-Goals

**Goals:**

- codex 目标的注入在写入前必须拿到"这是一个可以打字的地方"的**正面证据**, 而不是"画面没动"的反面推定。
- 判否是一个**可与 `guard_failed` 区分**的日志事件, 因为两者的运维含义完全不同。
- 判否复用既有的 transient refusal 通路, 不引入任何新的调度或重试机制。
- 非 codex 调用方的行为逐字节不变。

**Non-Goals:**

- 不识别具体的坑 (更新菜单、npm 确认、ssh host key 确认)。  见 D1。
- 不覆盖普通 `send_message` 回落 tmux 打到 codex pane 的同类洞。  同一病灶, 但能被普通 poke 找到的 agent 已经注册过, 早过了启动菜单窗口, 暴露面小一个量级。
- 不做 codex 侧的 `check_for_update_on_startup=false`。  那是 aoe launcher 的范围且是根因侧修复; 本变更是纵深防御。
- 不保证注入永不落入奇怪状态。  本变更把判据从"零证据"提到"一个正面证据", 不声称穷尽。

## Decisions

### D1: 允许列表, 不是拒绝列表

**决定**: 要求 pane 尾部呈现 codex 的空 composer 形态才放行, 而不是枚举已知的危险形态并拒绝。

**理由是失败方向不对称**:

| | 误判为否 | 误判为是 |
|---|---|---|
| 允许列表 | pane 不恢复 —— 有日志、有重试、row 到期收场 | 需要"非 composer 的东西长得像 composer" |
| 拒绝列表 | (几乎不发生) | **pane 自杀 —— 静默、不可逆** |

拒绝列表把默认放在"放行", 于是每一个没被枚举到的阻塞式 TUI 都是一次潜在的 pane 自杀。  允许列表把默认放在"拒绝", 代价是可恢复的、可观测的停摆。  **不能拿可恢复的失败去换不可恢复的失败。**

**考虑过的替代方案**: 匹配 `Update available` / `Press enter to continue`。  否决理由有二 —— 字符串与 codex 版本绑死 (0.150 的措辞不保证 0.151 一致), 且它只挡住了我们这次碰巧看见的那一个菜单; npm 的确认提示、ssh host key 确认、git 凭据提示都能以完全相同的方式致命, 而拒绝列表一个都挡不住。

### D2: 判据求值放在原语内部, 作为可选谓词参数

**决定**: `tmuxPokeImpl` 增加一个可选参数 (形如 `requireReady?: (paneTail: string) => boolean`)。  未传时行为完全不变; 传入时在 `capture_before` 拿到 `pane_tail_before` 之后、`load_buffer` 之前求值, 判否则不写入任何东西并返回一个专属 error。

**为什么复用 `capture_before` 的读取**: 该原语本来就在守卫之后做了一次 `capturePaneTail(pane_id, TAIL_LINES=8)` 用于返回诊断。  在它之上求值意味着**零额外 tmux 调用**, 且这是全序列里离写入最近的一次屏幕读取 —— 判据与它所保护的写入之间只隔一个 `load_buffer` (不触碰 pane)。

**注意这次捕获的真实范围不是"最后 8 行"。**  `capturePaneTail` 执行的是 `capture-pane -p -S -8`, 其语义是"起点取到可见区上方第 8 行, 一直抓到可见区末尾", 所以返回的是**整个可见 pane 再加 8 行 scrollback**。  2026-08-31 对生产 pane `%9` 实测: pane 高 51 行, 捕获返回 59 行。  这对判据是有利的 (composer 必定落在捕获范围内, 不存在抓不到的情形), 但它同时意味着捕获里含有大量历史输出 —— 见 D3 末段与 Risks。

**考虑过的替代方案**:

1. *塞进 `runQuietGuard`* —— 否决。  它服务所有 pane 类型, claude pane 的就绪形态与 codex composer 毫无关系, 塞进去会把所有非 codex 的 poke 一起废掉。
2. *让 `runQuietGuard` 把捕获的 tail 返回出来, 由调用方判断* —— 否决。  要改共享函数的签名, 收益仅是省掉一次已经存在的捕获。
3. *在调用方 (`codex-recovery-poke.ts`) 调 `tmuxPoke` 之前自行捕获并判断* —— 否决。  会在判据与写入之间插入整个原语的守卫+所有权序列 (含 `POKE_QUIET_MS` 的 2 秒停顿), 把一个 TOCTOU 窗口开在正好要防的那件事上; 且两个调用方要各写一遍。

### D3: 形态标记选结构性的 prompt 前缀, 不选 placeholder 文案

**决定**: 判据要求 pane 尾部出现 codex composer 的 **prompt 行**, 即首个非空白字符为 `›` 的那一行。  不使用 placeholder 的文案内容。

**先考虑并否决了 placeholder 文案。**  最初的设计是匹配空 composer 的提示语 `Ask Codex to do anything`。  它在生产在跑的 codex 0.151.0 二进制里逐字存在 (`strings` 可查), 看上去可用; 但 codex 较新的源码已经把它换成从一个 8 条数组里**随机**取一条 (`chatwidget.rs:1981` 的 `PLACEHOLDERS`, 由 `chatwidget/constructor.rs:40` 的 `rng.random_range` 选取), 而 `Ask Codex to do anything` 不在那 8 条之内。

这不是一个"将来也许会变"的风险, 而是一张**已经排好期的失效通知**: codex 自身会自动更新 (本次事故的起因正是它的启动更新菜单), 所以按文案锁定等于约定好在某次例行升级当天让所有 recovery 一起静默停摆。  文案是 copy, copy 会被改写; 结构才有惯性。

**`›` 是熬过那次改版的结构。**  它由 `bottom_pane/chat_composer.rs` 在 `textarea_rect` 左侧固定渲染 (`input_enabled` 时 bold, 否则 dim; bash 模式下换成 `!`), 在生产 0.151.0 的二进制中同样存在 (原始 UTF-8 字节可查)。  codex 自己的 TUI 快照测试里, 空闲 composer 渲染成的正是 `› Ask Codex to do anything` —— placeholder 换了, 前缀没换。

**已对生产在跑的版本实测确认。**  2026-08-31 只读采样 (`tmux capture-pane -p -S -8`) 了两个正在跑 codex 的 pane (`%9` / `%10`, 横幅自报 `>_ OpenAI Codex (v0.151.0)`), 两者底部都是行首无缩进、无边框的:

```
› Ask Codex to do anything
  gpt-5.6-sol xhigh fast · Context 94% left · ~/workspace/... · main · …
```

这排除了"0.151 的 composer 外面包了边框, 导致 `›` 不在行首、判据对所有 pane 判否"这一风险 —— 那会是第一天就触发本设计最坏形态。

**这仍然是一个与渲染耦合的启发式**, 只是耦合到了一个已经证明比文案稳定的结构上。  D4 的独立 reason 正是为它准备的: 一旦这个结构也变了, 现象必须能被立刻认出来。

**判据只问"存不存在", 不问"在第几行"。**  同一次采样发现 codex 把**已提交的用户消息也用 `›` 前缀渲染**, 于是 `%9` 的捕获里有两个 `›` 开头的行: 一条历史消息, 一条才是活的 composer。  由此确实存在一类假阳性 (阻塞弹窗挡在前面, 但屏幕上还留着旧的 `›` 历史行)。

**曾考虑并否决**: 把判据收窄成"尾部 N 个非空行内存在 `›` 开头的行" —— 活的 composer 一定紧挨底部状态栏。  否决理由与 D1 是同一条, 只是低了一层: 该收窄的假阴性触发条件是"codex 在输入框下方多渲染一行", 而底部已经有一行状态栏, 再加提示行/通知行属于日常小改动; 也就是为了堵一个罕见假阳性, 把"全部 pane 一起静默停摆"这个最致命失败的触发概率从"某次大改版"拉到"某次小调整"。  不能拿可恢复的失败去换不可恢复的失败。

保留的这个假阳性实际有多大, 也要说清: 真正付出过代价的场景 (启动期更新菜单) 发生在 TUI 起来之前, 整屏没有任何 `›`, 简单判据对它 100% 命中。  要触发假阳性, 需要一个已经跑起来、屏幕上留有 `›` 历史、又恰好停在阻塞弹窗上、同时还在等待 recovery 的未注册 pane; 且即便撞上, 后果是 Enter 落在 codex 自己的弹窗上, 而不是 pane 退出去跑 `npm install`。

**为什么不额外要求 composer 为空**: 空态判定只能靠 placeholder 是否出现, 而那正是上面否决掉的东西。  prompt 行本身在 composer 有内容时同样渲染, 所以本判据不区分空/非空。  这是相对最初设计放宽的一处: 它不再顺带挡住"composer 里已经有别人半截草稿"的情形。  该情形的危害等级远低于本变更要挡的事故 (追加粘贴 + Enter 会连同草稿一起提交, 但 pane 里跑的确实是 codex, 不会自杀), 且既有的所有权检查覆盖了其中"别的 agent 接管了 pane"的那一半。

### D4: 判否是第三种 transient refusal, 使用独立 reason

**决定**: 新增一个专属 error/reason (拟名 `prompt_not_ready`), 与 `guard_failed` 并列而非合并。  在 `codex-recovery-poke.ts` 中它成为继 `guard_failed`、`carrier_backgrounded` 之后的第三种 transient refusal: 归还 `resumeProbePolling`, 保持同一 generation token, 按 5s 探测间隔重试, 由 pre-reg row 生命周期兜底。  `codex-seeding-poke.ts` 同样把它并入既有的 transient 分类。

**为什么必须独立**: 这是允许列表相对拒绝列表唯一的额外代价 —— codex 一改 composer 渲染, **所有** recovery 会一起判否并静默停摆。  若与 `guard_failed` 共用 reason, 故障现象就从"一个 pane 没恢复"退化成"全部 pane 没恢复, 且日志说的是画面还在动", 排查方向会被直接带偏。  既有的"每条连续 streak 只打一次、该阶段通过后标记清零"的日志节流对它同样适用, 所以不会刷屏。

**不新增重试机制**: `resumeProbePolling` 就是这条路径的重试。  `send_message` auto-poke 的 30s/180s/600s 阶梯属于另一条路径, 且 spec 明令本路径 "SHALL NOT enter any long-backoff retry ladder", 不得引入。

### D5: 捕获失败 fail-closed

**决定**: 判据求值所依赖的捕获若抛错或超时, 一律读作"未就绪", 不写入。

与既有 spec 的 "ANY probe error, timeout, EPERM, missing column, or otherwise unknown state SHALL read as not-safe: no paste, no Enter" 同一立场。  `capture_before` 本就在 try 内, 抛错会被 `classifyTmuxError` 归类, 天然不写入。

## Risks / Trade-offs

- **codex 改掉 prompt 前缀的渲染 → 全部 recovery 静默停摆** → D4 的独立 reason 让该状态在日志中可直接识别 (每个 pane 每条 streak 一行, 内容明确指向"没认出输入框"而非"画面在动")。  这是本设计最大的爆炸半径, 已知并接受: 它换来的是 pane 不会自杀。  选 `›` 而非 placeholder 文案已经把这件事的预期发生时间从"下次例行升级"推远了一个数量级 (见 D3), 但没有消除它。
- **bash 模式的 prompt 前缀是 `!` 而不是 `›`** → 该状态下判否, pane 不恢复。  接受: 一个停在 bash 模式的 codex 也不是本路径预期的就绪态, 拒绝方向正确。
- **捕获范围是整屏而非最后 8 行** → 已实测确认 (`%9`: pane 高 51, 捕获 59 行)。  对判据有利 —— composer 必定在范围内; 代价是捕获含大量历史输出, 见下一条。
- **codex 用同一个 `›` 前缀渲染已提交的用户消息, 造成假阳性** → 已知并接受, 不收窄判据。  完整论证见 D3 末段: 收窄成"尾部 N 行内命中"会把最致命失败的触发条件降为一次底部布局微调; 而这个假阳性既罕见 (启动期菜单场景整屏无 `›`, 命中率 100%), 后果也只是 Enter 落在 codex 自己的弹窗上。
- **判据不区分 composer 空/非空** → 见 D3 末段。  相比最初设计放宽了一处, 换来的是不依赖会被改写的 placeholder 文案。
- **本变更不覆盖普通 `send_message` 的 tmux 回落** → 明确记为 Non-Goal, 需要时另开 change。

## Open Questions

1. **是否并列第二个结构标记** (例如 prompt 行下方的状态栏形态), 使判据不吊死在单个字符上。  倾向暂不加 —— 凭空并列候选是投机, 且第二个标记同样会被改; 真正的保险是 D4 的可观测性, 不是标记数量。  若实测发现 `›` 单独命中率不稳, 再补。
