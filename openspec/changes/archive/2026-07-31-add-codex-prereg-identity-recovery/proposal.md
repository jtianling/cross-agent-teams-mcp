# add-codex-prereg-identity-recovery

## Why

identity_key 恢复机制 (add-identity-key-recovery) 依赖调用方在 register_agent / reconnect 时携带 `$XATS_IDENTITY_KEY`, 但 codex `--remote` 模式的工具在共享 app-server 内执行, 读不到客户端进程环境变量, 导致 codex 注册永远带不上 key, 重启后身份零恢复.  同时重启后的新 codex 会话没有任何 kickoff, 即使 key 送到了 daemon, 也没人引导它重新注册.  与 aoe (agent-of-empires) 商定的联动方案 (jt 已拍板): launcher 在 exec codex 之前的 pane shell 里能读到 key, 由 `pre-register-codex-pane` CLI 把 key 送进 daemon; daemon 借此识别 "这是某身份的 pane 重启", 并在 codex 进程就绪后 poke 引导其重新注册.

## What Changes

- `codex_pane_pre_registrations` 表新增可空 `identity_key` 列 (与 `xats_agent_id` 分列, 不合并); `pre_register_codex_pane` MCP tool 加可选 `identity_key` 参数, `pre-register-codex-pane` CLI 加可选 `--identity-key-env [VAR]` 标志 (默认读 `XATS_IDENTITY_KEY`, key 值从环境变量取, 决不落任何 argv).  key 只走 CLI→HTTP(带 token) 通道, 绝不进任何进程命令行.
- pre-register 携带 identity_key 到达时, daemon 立即按 key 反查 (存量 `findByIdentityKey`) 上次绑定的 (team, name); 命中即判定为该身份的 pane 重启, 调度一次恢复 poke.
- 恢复 poke 不立即发送 (此刻 pane 内还是 shell, paste+Enter 会被 shell 执行): 首发 gate 在 "该 pane 的 tty 上检测到 argv 含对应 `xats.agent_id` uuid 的 codex `--remote` 进程" 之后 (复用 autoBindCodexPane 探测原语), 发送时走现有 quiet-guard + pane-host-verify; 瞬态拒绝 (quiet-guard 未过、载体后台化且未写入) 不入任何长退避梯子, 同代回到探测轮询按探测间隔续试, 以 pre-reg 行生命周期 (过期/覆盖/消费) 为界.  话术引导 codex 以恢复出的 name/team 调 register_agent (thread_id 用 `$CODEX_THREAD_ID`).
- register_agent 的 codex auto-bind 消费 pre-reg 行时, 把行内存储的 identity_key 按既有四分支规则附到 caller 行; 但**候选资格**先做归属判定: 行内 key 与 caller 已持非空 key 矛盾、或该 key 属于另一 (team, name) 且其 holder 存活或存活性未知 (无正数 pid) 时, 该行整行不作候选 —— 不绑、不消费、不附 key, 记 debug 日志, 行留给真正的主人 (caller 无 key 且 key 无 holder、或 holder 已被证实死亡的正路不受影响).  该判定在 bind 之后于同一同步事务内重验, 期间出现真正 owner 时回滚已写入的绑定; detect fallback 也不得绑定仍挂未过期 pre-reg 行的 pane; 无候选时按既有 fail-closed 落 detect fallback (`identity_key_conflict` 仅保留在 register_agent 显式传 key 的路径上).
- codex 在恢复 poke 发出前自行注册成功的, 消费 pre-reg 行时取消 pending poke.
- poke 调度以 pre-reg 行未过期为前提; `identity_key` 全程可选, 不传时所有现有路径行为不变 (与 aoe 版本解耦, xats 先发版).

## Capabilities

### New Capabilities

<!-- 无新增 capability: 全部落在既有 capability 的既有工具与投递设施上 -->

### Modified Capabilities

- `agent-registry`: `codex_pane_pre_registrations` 表加 `identity_key` 列; `pre_register_codex_pane` tool 加可选 `identity_key`, CLI 加可选 `--identity-key-env`; auto-bind 消费 pre-reg 时按四分支附 key, 而 key 判定属于另一身份的行**整行不作候选** (不绑不消费不附 key, 记 debug); 候选判定在异步验证后于同一事务内重验, 判定 foreign 或附 key 失败即整体回滚 (运行时写与在位 pane 驱逐一并回退); detect fallback 的 "目标 pane 无有效 pre-reg 行" 检查同样压在最终写的事务内; 自行注册成功时取消 pending poke
- `agent-delivery`: 新增 daemon 发起的恢复 poke — 触发条件 (pre-reg 带 key 且命中身份)、首发 gate (codex 进程探测)、发送设施复用 (quiet-guard / pane-host-verify) 与同代探测轮询续试 (瞬态拒绝不入梯子)、过期与取消语义

## Impact

- `src/storage/schema.ts` — pre-reg 表新列 + 幂等迁移
- `src/mcp/codex-pane-pre-register-repo.ts` — 行结构与读写
- `src/mcp/pre-register-codex-pane.ts` — 输入 schema 与存储
- `src/cli.ts` — CLI `--identity-key-env` 从环境变量读 key 后透传
- `src/mcp/tools.ts` — tool schema、pre-register 处理入口挂恢复调度、auto-bind 附 key
- `src/mcp/auto-bind-codex-pane.ts` — 消费时附 key / 取消 pending poke
- 新增恢复 poke 调度模块 (探测 gate + 同代轮询续试 + pane-host-verify)
- 外部契约: 与 aoe 的 bootstrap 变更配对 (`--identity-key-env`, launcher 在 pane shell 导出 `XATS_IDENTITY_KEY`, key 值不落 argv; 带标志失败降级不带标志); 发布顺序 xats 先发
- 向后兼容: 不传 identity_key 时 pre-register / auto-bind / poke 各路径行为与现状完全一致
- 依赖: 建立在未归档 change `add-identity-key-recovery` (四分支 / findByIdentityKey) 与 `add-poke-pane-host-verification` (pane-host-verify) 之上
