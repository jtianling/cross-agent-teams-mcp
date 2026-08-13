## Why

codex pane 换代后永远恢复不了 xats 身份, 且状态机不可收敛。

`classifyRowClaim` 的第一条分支是终态拒绝: caller 行持有的 `identity_key` 与 pre-reg 行的 key 不同即判 `identity_key_contradiction`, 后续所有证据都不再考察。  `attachConsumedIdentityKey` 的 `caller_holds_different_key` 是同一道墙的第二层。

对 codex 这构成自锁死。  写入新 key 的宽松通道是 `register_agent` 显式带 `identity_key` (`planIdentityKeyBinding` 只检查新 key 有无活持有者, 不看 caller 旧 key, 无条件覆盖), 但 codex 的工具进程跑在共享 app-server 里, `printenv XATS_IDENTITY_KEY` 读到的是启动 app-server 那个 shell 的值, 不是自己 pane 的那把 —— 这条通道对 codex 形态上不可用。  于是唯一可用的写入通道就是 auto-bind 的 attach, 而严格拒绝恰好只长在这条通道上: bind 被拒 → 新 key 永远进不了 agents 行 → 下次重启 `reconnect({identity_key})` 查无持有者 → `need_register` → agent 只能反问人要 name 和 team。

触发条件不罕见: launcher 的 key 按座位铸造, tmux session 删除重建即换代 (这是 launcher 侧的 by design)。  生产库中已有 4 个 codex agent 卡死 (`monkeys/monkeys-coder`, `monkeys/mvr-coder`, `monkeys/verifier`, `monkeys/vercel-logger`), daemon 日志三轮复现 `nonce outcome=resolved → auto-bind targeted → skip reason=identity_key_contradiction`。

## What Changes

- 当 pre-reg 行是被**已消费的 recovery nonce 定向选中**时, 允许把 caller 行的 `identity_key` 轮换成该行的 key, 而不是判 `identity_key_contradiction` 永久拒绝。  依据是权限对等: nonce 已足以让 caller 拿走该 pane 的 runtime binding 并驱逐原住民, 那是比改写一个 key 字段更重的授权; 既已授大权, 再以小权为由拒绝并不自洽。
- 没有 nonce、纯靠 scan 的 unique-candidate 推断出来的行, **维持现有严格拒绝**。  轮换门只开在 daemon 自己拥有的事实 (它把 token 写进了哪个 pane) 上。
- 轮换发生时补一行日志, 旧/新 key 只打前 8 位。  当前这类问题只能靠对着 DB 手查。
- `register_agent` 工具描述为 codex 补一句: 你 `printenv` 读到的 `XATS_IDENTITY_KEY` 不是你自己 pane 的那把, 不要传。  现状只写了"不要传 ui_pid", kimi 的同类 caveat 反而写全了。

**明确不做**: 不以"旧 key 的载体已死"作为放行条件。  caller 旧 key 的持有者就是 caller 行自己 (`agents_identity_key_idx` 是 `(device, identity_key)` 唯一索引), 它的 `runtime_ui_pid` 在合法重启场景里必然是死的 —— 以此放行等于把该检查在唯一会触发它的场景里整体变成空操作。  而它唯一会拒绝的那一类恰好是"某 pane 在旧载体死后接管另一个身份", 正是 `Seat identity for key migration is the pane, never the tty` 那次事故的形状, 等于在另一条通道上重造同一个洞。

## Capabilities

### Modified Capabilities

- `agent-registry`: nonce 定向的 pre-reg 行可授权 caller 行的 identity key 轮换; 轮换留下可审计日志; `register_agent` 工具描述为 codex 补 key 不可读的 caveat。

## Impact

`src/mcp/auto-bind-codex-pane.ts` 的 `classifyRowClaim` / `attachConsumedIdentityKey` / candidacy 与 commit 内 re-arbitration 的入参, `src/mcp/tools.ts` 中 nonce 消费结果向 auto-bind 的传递, `register_agent` 工具描述文本, 以及对应单元测试。  存量卡死行的解锁 (置 NULL) 已由运维手动完成, 不在本变更范围内。
