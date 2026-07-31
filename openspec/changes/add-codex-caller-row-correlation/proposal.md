# add-codex-caller-row-correlation

## Status: 触发条件已命中, 暂缓结束 (2026-07-31T21:00Z)

下面"什么时候必须捡起来"的**第 2 条已经在生产上发生**, 所以本 change 不再处于可暂缓状态,
现等 jt 放行实现.

```
[2026-07-31T21:00:10.427Z] auto-bind skip (debug): reason=candidate_count
    caller=bc98ce97-… candidates=2 pending=2 panes=%82,%83
[2026-07-31T21:00:11.826Z] auto-bind skip (debug): reason=candidate_count
    caller=3ea2618c-… candidates=2 pending=2 panes=%82,%83
```

`aoe-codex` 与 `aoe-codex-2` 双双注册、双双被挡、一个都没绑上 (0.8.0 daemon).  该日志行**昨天
之前不存在**, 这条路径此前完全静默.

**严重程度高于本文档原先的估计**: 它卡住的不是"绑定"这一件事, 而是**整条身份恢复链的入口** ——
`agents.identity_key` 的**唯一**入口是"预注册行被消费" (`register_agent` 显式传 key 这条 codex
拿不到 key; seat-follow 是绑定落定之后的钩子), 而消费正是被挡的那一步.  于是
`evaluateCodexRecoveryOnPreRegister` 的 `findByIdentityKey` 永远返回空, **恢复 poke 从不调度**,
重启后的 codex 没有任何东西提示它注册.  jt 报的"完全不自动重新注册"由此得到完整解释.

## Status (历史): 方向已定, 实现暂缓 (jt, 2026-07-31)

四轮判定实验已跑完 (E1/E2/E3/E5, 全否), 方向收敛到 **M9 — 恢复 poke 携带一次性 nonce, 注册时
回带** (见 design).  **jt 决定暂不实现**, 本 change 作为文档保留.

**为什么可以暂缓**: 今天生产上的失败是 `identity_key_contradiction` (4 次) 与 `bind_failed`
(3 次), 后者已修; **`candidate_count` 这条今天在生产上零命中** —— 因为一次 Shift+C 目前只产出
一行预注册 (aoe 的 `extra-agent-pane-parity` 尚未与 0.7.8 一起生效).

**什么时候必须捡起来 —— 两个触发条件, 任一命中即不可再缓**:

1. **0.7.8 与 aoe 的 `extra-agent-pane-parity` 即将一起生效之前.**  两者到位而本条不到位时净
   效果为负: 每次 Shift+C 稳定产出两行且都消费不掉, 比现状更差 (现状至少一半启动只产一行).
   **这是本 change 与发版之间的硬依赖, 不是建议.**
2. **生产日志出现 `reason=candidate_count`.**  该日志今天刚补上 (此前这条路径完全静默), 一旦
   出现即说明并发窗口已经在真实发生.

**暂缓期间不做的事**: 不实现 M9, 不改扫描的选行逻辑, 不动预注册写入路径 (S9 那条因此仍然
是红的 —— 红基线 `lab/s9-prereg-overwrite.sh` 三个方向保留在库里, 不要为了让它绿而放松断言).

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
