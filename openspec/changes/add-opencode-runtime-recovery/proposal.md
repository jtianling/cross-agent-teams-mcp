## Why

AoE 重启 OpenCode pane 时, xats 目前只能按易漂移的最新 session 恢复投递, 无法证明启动代次、精确 session 和实际 MCP 连接属于同一个运行时。  这会让旧 endpoint 被继续 poke, 或让控制面连接误占 agent 身份。

## What Changes

- 增加 OpenCode 运行时的 reserve/commit 控制面协议, 以单调 `runtime_generation` 隔离并发启动和陈旧提交。
- 增加 launcher-facing CLI 与无 agent 身份也可调用的 MCP 控制工具, 同时加入 CLI/daemon 协议握手和安全的 identity key 环境变量读取。
- 将 OpenCode fence generation 与已提交 delivery generation 分开持久化, 并在恢复窗口阻止旧 endpoint poke, 但继续写入 mailbox。
- 扩展 key-based OpenCode `reconnect`, 只接受完整且精确的运行时形状, 并把 OpenCode 自己的 MCP 连接重新绑定到原 agent 身份。
- 扩展首轮 OpenCode 注册, 原子写入精确 session、fence generation 和 delivery generation。
- 提交 delivery 后向精确 OpenCode session 调度固定恢复提示, 支持部分失败、重试收敛和 generation-scoped 取消。

## Capabilities

### New Capabilities

- `opencode-runtime-recovery`: 定义 reserve、commit、CLI 握手、精确 session 恢复提示和控制面边界。

### Modified Capabilities

- `agent-reconnect`: 增加 identity key 驱动的 OpenCode 完整运行时重连形状和当前 MCP 连接绑定语义。
- `agent-registry`: 持久化独立 OpenCode fence generation, 并以 CAS 保证代次单调和身份字段不变。
- `agent-delivery`: 为 OpenCode delivery 持久化已提交 `runtime_generation`, 并定义恢复态下的 mailbox/poke 行为。
- `opencode-server-transport`: 要求 commit 和 reconnect 使用精确 session 探测, 并向精确 session 发送无 key 的恢复提示。
- `daemon-core`: 增加 paired CLI/daemon 协议握手, 不匹配时 fail closed。

## Impact

影响 CLI 参数解析和 daemon 连接引导, MCP 工具 schema 与注册/重连服务, SQLite agents schema 与迁移, OpenCode delivery 序列化和派发, prompt_async 调度, 以及对应的单元和集成测试。  AoE launcher 的调用实现不在本仓库变更范围内。
