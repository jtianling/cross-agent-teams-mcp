## Why

`reconnect` 的三个反查键 (`runtime_ui_pid`, codex `thread_id`, kimi/opencode 的 `(base_url, session_id)`) 全是进程级的, 只能救 "同一个进程被 `/clear` 清空上下文" 的场景.  一旦 pane 被真正重启, 这些键全部改变, agent 的 xats 身份就永久丢失 —— codex 尤其严重, 换了 `thread_id` 之后现在零恢复手段.

外部 launcher (AoE) 需要一个**跨 restart 稳定**的反查键, 且不希望自己持有 `team` / `name` (那会让 launcher 侧的副本在用户改名后变成脏数据).  launcher 只想持有一个不透明值, 身份的所有权完整留在 xats 侧.

## What Changes

- `agents` 表新增 `identity_key` 列, 附 `UNIQUE(device, identity_key)` 索引与幂等启动迁移
- `register_agent` 接受可选 `identity_key`, 按**四分支规则**绑定: 未知 → 绑定; 命中同一行 → 幂等; 命中异行但旧行进程已不可用 → 迁移 (旧行置空); 命中异行且旧行绑着活着的其他进程 → 返回 `identity_key_conflict`
- `reconnect` 新增第四个 resolver: 按 `identity_key` 反查 `(team, name)`.  与现有三个 resolver 不同, `identity_key` **不进** exactly-one 互斥组 —— 允许 `{identity_key, ui_pid}` (claude) 与 `{identity_key, thread_id}` (codex) 共存, 使身份恢复与 pane / delivery 刷新在同一次调用内完成
- channel proxy 读取 `XATS_IDENTITY_KEY` 环境变量, 把它**内联填进** startup hint 的 `register_agent` 调用模板, 并把 identity-key 分支排在现有 "记得身份 → register" / "不记得 → reconnect(ui_pid)" 两支**之前**
- `register_agent` tool description 的 DETECTION 块新增 `XATS_IDENTITY_KEY` 探测条目, 覆盖没有 channel proxy 的 codex 路径

## Capabilities

### New Capabilities
<!-- 无新增 capability: 本变更全部落在既有三个 capability 的既有工具上 -->

### Modified Capabilities
- `agent-registry`: `agents` 表新增 `identity_key` 列与唯一索引; `register_agent` 接受 `identity_key` 并实现四分支绑定; tool description DETECTION 块新增探测条目
- `agent-reconnect`: `reconnect` 新增按 `identity_key` 的反查路径, 且该键可与 `ui_pid` / `thread_id` 共存
- `claude-channel-transport`: channel proxy 读取 `XATS_IDENTITY_KEY` 并重排 startup hint 的分支顺序, 把 identity key 内联进注册调用模板

## Impact

- `src/storage/schema.ts` — 新列 + 唯一索引 + 幂等 healing
- `src/storage/agents-repo.ts` — 写入路径与新的 `findByIdentityKey` 反查
- `src/mcp/register-agent.ts` — 四分支绑定规则 (含旧行进程存活判定)
- `src/mcp/reconnect.ts` / `src/mcp/tools.ts` — 第四个 resolver 与 zod 互斥组调整
- `plugins/cross-agent-teams-channel/src/cli.ts` — 读 env + `buildStartupHint` 分支重排
- 外部契约: 与 `agent-of-empires` 的 `preserve-xats-identity-across-restart` 变更配对, 环境变量名 `XATS_IDENTITY_KEY` 已双方锁定
- 向后兼容: `identity_key` 全程可选, 不传时所有现有路径行为不变
