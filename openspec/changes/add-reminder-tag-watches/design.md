## Context

现有未发布实现将新增与完成合并为同一规则.  用户现要求 added, completed, tag 三类独立配置.  tester 已真实确认普通 show/export 无 tag, info --native 返回顶层 tags 字符串数组, 需要逐任务原生读取.

## Goals / Non-Goals

目标是独立选择事件和接收者, 仅 tag 规则读取原生 tag, 连续 30 秒稳定后唤醒.  不扫描用户未指定的列表, 不传递任务正文, 不改变全局 MCP 工具或生产 daemon, 不把正文中的 # 文本当作原生 tag.

## Decisions

- 创建规则必须显式 event=added/completed/tag.  tag 分支必须提供单个 tag 名称, 非 tag 分支拒绝 tag 字段.  CLI 使用 --event 和 --tag.
- 规则唯一键扩展为 list/team/name/event/tag.  同一列表和接收者可添加三类规则或多个不同 tag, 真正重复仍返回 409.
- 初始所有规则只建基线.  added 保持五分钟内容稳定期.  completed 对观测到的 isCompleted false→true 即时通知, 即使任务刚新增且尚未满足五分钟.  tag 对 absent→present 等待连续 30 秒内容和修改时间不变, 已有 tag 只建基线, 移除取消待通知状态, 重新添加重新计时.
- tag 读取先执行现有 show all, 再按完整 task ID 依次 info --native --json --no-input.  校验每项 id/listID 和 tags 数组.  原生读取失败不能降级为无 tag, 不推进快照.  普通规则不调用 info --native.
- 快照增加可选的 tag 存在及已通知标记.  延用内容摘要与 stable_since, 延用消息与状态的原子事务, 保持固定唤醒文案不含 tag 或任务内容.
- 读取按所属规则 ID 关联 AbortController, 删除时仅取消对应读取, 不取消其他规则或未提交的新建规则基线.  每条外部命令执行前检查取消状态, 防止已取消的原生批量读取继续启动后续 info.
- 数据库存在旧组合规则时, 在同一迁移事务中拆为 added/completed 两条独立规则并保留快照, added 保留原规则 ID.  已是新结构则不重复迁移.  尚未发布的旧 CLI 无 event 调用明确拒绝, 不默选事件.

## Risks / Trade-offs

- tag 每轮需要逐项原生读取, 大列表耗时会延长实际扫描周期.  仅启用 tag 的列表承担此成本, 所有调用可取消且有超时.
- 30 秒为从观测到变化后的最短稳定期, 30 秒轮询和命令耗时可能进一步延迟通知.
- 两次扫描之间移除再添加且完整导出未变化的瞬时事件无法可靠捕获, 按最后观测状态处理.
