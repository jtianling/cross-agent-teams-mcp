## Context

现有内部 Reminders 发件人模式及消息持久化回调可复用.  生产 daemon 正在服务实时 agent, 本轮实现和验收必须隔离, 不覆盖 dist 或重启服务.  

## Goals / Non-Goals

支持 once, interval, daily, weekly, monthly, 无限或有限总触发次数, 本设备目标和动态 CRUD.  不增加 cron 表达式, 跨设备计划或 agent 工作完成协议.  

## Decisions

- SQLite 保存计划与最近 100 条执行记录.  name 唯一, 相同配置重试创建返回原计划, 不同配置同名返回冲突.  
- once 使用带 offset 的 ISO 时间, 日历计划保存明确 IANA 时区与时分秒, weekly 的 weekday 为 ISO 1-7.  monthly 缺日期跳过, DST 缺失时刻跳过, 重叠取较早一次.  Intl 计算时区, 不新增包.  
- max_runs 为计划累计消费的触发次数, 包括合并和失败, 不包含停机跳过.  null 表示无限, once 固定一次.  修改保留计数, 可提高上限.  
- 单个调度器按计划串行, 不同计划独立派发, 慢 transport 不阻塞其它闹钟入库, 最多每分钟重新校准时钟, 无活动计划无 timer.  正常延迟最多处理一个到期事件, 下次定位未来.  重启跳过循环过期时刻, 一次性到期补发一次.  
- 系统身份 scheduler@__xats_schedules__, 每次按本设备 name/team 查当前目标, 不固化 thread/pane.  提示作为正常消息写入 get_inbox.  本计划上一条消息对当前目标仍未读时合并, 使用现有 transport 的忙时 guard/steer/retry, 不创建并行业务 turn, 但不声称知道 agent 的业务完成状态.  
- 消息与计划推进, 执行记录同事务提交, 延长现有 onPersisted 回调携消息坐标, 无参数回调保持兼容.  提交后 transport 失败不得重新创建消息.  
- 暂停或删除只取消未来调度, 不撤销已入 inbox 的消息及已有 transport retry.  更新后保持暂停状态, finished 计划修改为剩余额度及未来时间后可恢复.  

## Risks / Trade-offs

- 系统休眠, event loop 或 transport 延迟影响精度 -> 声明 best effort, 保存计划和实际执行时刻, 不保证硬实时.  
- 未读合并不代表任务互斥 -> 明确消费语义, 巡检自身由 steward 记忆规定.  
- 重启后旧唤醒重试不持久 -> 保留消息和投递证据, 不谎报已读, 下次计划仍使用当前身份.  

## Migration Plan

首次加载自动创建独立表.  验收只使用临时 DB 和随机 loopback.  激活新代码需要操作者安排构建及一次 daemon 重启, 后续计划管理无需重启.  
