## Why

AoE 切换 Codex, Claude 和 OpenCode 时需要保留原身份及 inbox.  当前同类型恢复接口拒绝跨类型, 直接放宽检查又会允许旧 runtime 覆盖新会话.

## What Changes

- 增加 unmanaged 本机 handoff prepare/commit/status/abort, 持久化源快照与 fence.
- 新 runtime exact proof 后原位提交, 隔离旧注册, 旧连接和延迟回调.
- managed prepare 允许带旧类型和当前 fence 的显式类型交接.
- 固定 AoE helper 协议, 不向模型传 identity key 或交接 secret, 不操作真实 pane.

## Capabilities

### New Capabilities

- `runtime-type-handoff`: 保留身份的跨类型两阶段交接, fencing 和失败恢复.

### Modified Capabilities

无.  既有恢复契约继续适用, 新交接路径增加其使用前提.

## Impact

涉及 runtime handoff, managed claims/service, 注册与 MCP session 门禁, 及 daemon REST.  复用现有 runtime 验证, 不增加第三方依赖, 不修改 AoE 项目或共享服务.
