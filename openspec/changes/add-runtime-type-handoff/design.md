## Context

现有 OpenCode 同类型恢复与 managed ownership 各有 fence.  旧进程可能在异步 probe 或 MCP 连接中继续运行.  本机实时 session 不参与测试, 不重启共享 daemon.

## Goals / Non-Goals

保留身份, inbox 和 cursor, 提供可重试且无部分更新的交接.  不负责 AoE pane 进程启停, 不让模型读取 key/token, 不放宽同类型恢复.

## Decisions

- Unmanaged 使用独立持久 handoff 表与源快照.  prepare 不修改 agent, commit exact 新 runtime 验证后在事务内 CAS.  liveness, last_seen_at 和消息 cursor 不参与 CAS.
- Claude 输入允许仅 ui_pid, 由本机 proxy 查询解析 channel 后验证.  Codex 使用 helper 收集真实 thread, 不依赖注册前 lookup 或 cwd 推断.
- 首次交接后普通注册必须匹配当前 runtime, MCP 连接记住交接 epoch, 旧连接不能继续操作新身份.  新 helper commit 后目标正常注册.  旧 runtime mutation 仍受类型和 register fence 约束.
- Managed prepare 用 previous_agent_type 显式声明跨类型, 新 instance/current previous fence 必填.  推进 agent register_generation, 清理旧绑定残留, 验证后 bind.
- 控制响应统一固定字段, 不输出 key 或 auth reference, 失败有具体原因和重试分类.  原 standalone 路径不依赖 AoE.

## Risks / Trade-offs

后台旧 probe -> 提交时再验证 fence, 清理旧 pending Codex schedules.  旧同类型会话 -> exact 地址与交接 epoch 联合门禁.  旧 source stop -> 普通断连不改 row, 真正地址变化返回 stale.  崩溃 -> SQLite 保存 pending 和终态.
