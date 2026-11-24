## Context

普通pane可有稳定key, 手动注册可能无key.  OpenCode HTTP登记常无runtime PID/pane字段, 因此只按key查成员不够.  共享tmux有大量实时session, 测试只能使用注入fake和隔离HTTP/MCP.

## Goals / Non-Goals

只释放当前可核验活pane中的普通身份, 多目标冲突不部分删除, 已注销可重试.  不猜测已停止pane的logical身份, 仅允许显式启用严格dead key缺席证明.  不把本接口当managed release, 不kill任何进程或清理用户资源.

## Decisions

- 请求严格schema, 最多16个不重复目标, 复用现有loopback/bearer门禁, 省略key时也必须取得唯一当前身份.
- 原生绑定复用PaneLookupService证明.  OpenCode attach分支使用准确socket中的pane TTY前台载体, 解析URL与--session/-s, 对比当前唯一native pair和可选key/session.
- 两轮系统证明后, SQLite事务重新检查目标行, pane/runtime/PID竞争者集合与Codex launch元数据.  liveness与cursor不进归属快照, 任一冲突全批不删.
- 成功复用removeAgentRow, 不删消息.  事务提交后清理对应MCP session和旧回调.  接口不保证停止旧模型进程, AoE成功后继续原删除流程.
- 当前 key 无 holder 时, verified 绑定时间早于当前 server 代次且旧 PID 明确消失的不同 key 记录可作为历史物理别名.  仅豁免 pane 编号冲突, 不排除逻辑 runtime owner; 历史完整快照和 managed 归属仍进入最终事务复核.
- opt-in dead target仍留在原批次, 使用服务端7字段tmux inventory, 不接受客户端自报dead.  独立dead证明拒绝任何role的key/pane holder和prepared/bound managed key.  旧binding只允许无owner或已迁移owner且旧PID消失的情况, pending launch须已确定过期, 完整快照进入同批事务.  dead分支不删身份/binding; 同批明确释放的活owner仍沿用原身份清理行为.

## Risks / Trade-offs

系统状态不能跨进程持锁 -> 公开为保守快照, socket/server/carrier和提交时registry全部复核, 不以旧pane编号或key单独授权.  原生argv不能可靠解析 -> 明确拒绝, 不执行字符串或猜最近session.  500/网络中断 -> 客户端保留资源并重新核验, 不自动降级到旧DELETE.
