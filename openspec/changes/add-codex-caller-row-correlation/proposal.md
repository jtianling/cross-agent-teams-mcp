# add-codex-caller-row-correlation

## Why

codex 注册时, daemon 要在若干条待消费的 pre-reg 行里挑出**属于这个调用者**的那一条.  它现在
唯一的手段是 "**全机恰好只有一个候选**" —— 而那不是关联, 那是**在没有关联时对唯一性的碰运气**.
扫描凭 uuid 证明的是**那个 pane 里的 codex 身份**, 从来不证明**调用者身份**.

2026-07-31 实测把后果定死了:

- **两个 codex pane 的 pre-reg 窗口重叠时, 两条都消费不掉, 两边都绑不上.**  因果已证 (联测
  tester: 只干掉其中一个 pane 的载体 —— **只改候选数、不改 pending 数** —— 同一个真身立刻绑上,
  消费的正是剩下那行).  日志为 `reason=candidate_count candidates=2 pending=2`.
- aoe 的 `extra-agent-pane-parity` 之后, **一次 Shift+C 前后脚产出两行**, 间隔以秒计 —— 这个
  失败从"偶发"变成**确定性**.
- 同一个缺失还有三种别的表现: pre-reg **写入路径完全没有仲裁** (陌生人可覆盖任意 pane 的行,
  连带销毁受害者的 identity_key 并封住它自己的 pane —— 场景 S9, 三个方向全红); 扫描可能把外来
  pane 交给 caller; 行上的 identity_key 只能靠启发式来保护.

所以这条**不是一项改进, 而是"多于一个 codex 同时启动时该功能能不能用"的前提**.  身份恢复链
(`add-codex-prereg-identity-recovery`) 的前两件 (发版让 key 进得了行 / aoe 两个 pane 都预注册)
在本条不到位时**净效果为负**: 每次 Shift+C 稳定产出两行且都消费不掉, 比现状更差 —— 现状至少
有一半的启动只产一行.

## What Changes

- 引入一条 **daemon 可独立验证的 caller↔row 关联**, 并让它成为扫描的**主选择器**; "唯一候选"
  退化为 fail-closed 兜底, 不再承担关联职责.
- **机制尚未选定.**  三个候选各自依赖一个**尚未验证**的事实, 而它们的信任面差别很大 (见
  design.md).  **本变更第一阶段是三个判定实验, 不是实现**; 实现形态由实验结果决定, 结果出来
  前不写实现代码.
- 关联建立之后, pre-reg **写入**路径才第一次具备仲裁的前提 —— 届时 S9 那条可以按"这一行属于谁"
  正面解决, 而不必依赖 "key 当写凭证" 这个只挡得住模型、挡不住第二个 launcher 的近似手段.

## Capabilities

### New Capabilities

<!-- 无新增 capability: 全部落在既有 agent-registry 的注册/绑定路径上 -->

### Modified Capabilities

- `agent-registry`: codex 注册的 pre-reg 扫描改为按可验证的 caller↔row 关联选行; 候选唯一性
  降级为兜底; 关联缺失或多义时 fail-closed 并记独立 reason; pre-reg 写入路径在关联可用后加入
  归属仲裁

## Impact

- `src/mcp/auto-bind-codex-pane.ts` — 候选选择从"计数"改为"关联", 计数保留为兜底
- `src/mcp/tools.ts` — 注册入口把关联输入 (caller 侧标识) 传进扫描
- `src/mcp/pre-register-codex-pane.ts` — 写入侧仲裁 (第三阶段, 依赖关联可用)
- 可能新增一个"关联解析"模块 (形态取决于实验结果: 读 codex 会话记录 / 问 app-server / 采信
  caller 自报并交叉校验)
- 外部契约: 若选中 M1 (caller 自报 `xats.agent_id`), 需要 aoe 与 codex 侧配合; 若选中 M2/M3,
  **不需要 aoe 做任何事**
- 向后兼容: 关联不可得时行为回落到现状 (唯一候选), 不制造新的失败模式
- 依赖: 建立在未归档 change `add-codex-prereg-identity-recovery` 之上; 与它的发版顺序见
  design.md "Release ordering"
