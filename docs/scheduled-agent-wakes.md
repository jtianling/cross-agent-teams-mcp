# agent 定时唤醒

计划支持未来一次性时刻, 固定秒间隔, 每天, 每周或每月的固定时间.  循环可无限或限定累计触发次数.  新版本首次激活需要构建并重启一次 daemon, 后续计划管理立即生效, 无需重启.  本功能只管理本设备目标, 不添加 MCP 工具.  

## CLI

以下命令使用已运行 daemon 的端口发现及现有 token 环境变量, 可另传 `--port` 和 `--pid-file`.  时间仅为示例, 实际创建必须填写未来时刻.  

```sh
cross-agent-teams-mcp schedules add --name once-review \
  --team default --agent steward --prompt '检查实际需求及进展' \
  --kind once --at '2030-01-01T10:00:00+08:00'

cross-agent-teams-mcp schedules add --name daily-review \
  --team default --agent steward --prompt '检查实际需求及进展' \
  --kind daily --time 09:00 --timezone Asia/Singapore --count forever

cross-agent-teams-mcp schedules add --name weekly-review \
  --team default --agent steward --prompt '检查每周进展' \
  --kind weekly --weekday 1 --time 09:00 --timezone Asia/Singapore --count 3

cross-agent-teams-mcp schedules add --name monthly-review \
  --team default --agent steward --prompt '检查每月进展' \
  --kind monthly --day 31 --time 09:00 --timezone Asia/Singapore --count forever

cross-agent-teams-mcp schedules add --name hourly-review \
  --team default --agent steward --prompt '执行记忆中的管家巡检' \
  --kind interval --every-seconds 3600 \
  --start-at '2030-01-01T10:00:00+08:00' --count forever
```

`--count` 缺省表示无限, once 固定为一次.  count 指累计到期触发次数, 包含失败或合并, 不包含停机跳过的 tick.  `--time` 接受 `HH:mm` 或 `HH:mm:ss`.  CLI 缺省捕获调用机器当前时区并保存, 建议显式填写.  weekday 使用 ISO 1-7, 周一为 1.  月份没有指定 day 时跳过该月.  夏令时缺失时刻跳过, 重叠时刻只取较早一次.  

```sh
cross-agent-teams-mcp schedules list
cross-agent-teams-mcp schedules show --id '<完整 UUID>'
cross-agent-teams-mcp schedules runs --id '<完整 UUID>'
cross-agent-teams-mcp schedules pause --id '<完整 UUID>'
cross-agent-teams-mcp schedules update --id '<完整 UUID>' --prompt '新的巡检提示'
cross-agent-teams-mcp schedules update --id '<完整 UUID>' \
  --kind daily --time 10:30 --timezone Asia/Singapore --count 5
cross-agent-teams-mcp schedules resume --id '<完整 UUID>'
cross-agent-teams-mcp schedules remove --id '<完整 UUID>'
```

更新日历字段必须同时给 `--kind` 和该类型完整时间字段.  修改保留已触发次数, 增大 count 可延长计划.  暂停后修改仍为暂停, resume 计算下个未来时刻, 固定间隔沿用原始基准.  once 若暂停期间错过时刻, 需修改为新的未来时刻.  已结束循环计划可修改到未来时间并增加剩余额度; 已触发的 once 若要再响一次, 请新建计划.  同名同配置重复 add 返回原计划, 同名不同配置报冲突.  

## HTTP

所有路由只允许 loopback, 复用 daemon bearer token.  不需要绑定或冒用 agent 身份.  创建和修改的未知字段会拒绝.  

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/schedules` | 创建, 新建 201, 幂等命中 200 |
| GET | `/api/schedules` | `{ schedules: [...] }` |
| GET | `/api/schedules/:id` | `{ plan: ... }` |
| PATCH | `/api/schedules/:id` | 修改, `{ plan: ... }` |
| POST | `/api/schedules/:id/pause` | 暂停, 无 body |
| POST | `/api/schedules/:id/resume` | 恢复, 无 body |
| DELETE | `/api/schedules/:id` | 删除, 无 body |
| GET | `/api/schedules/:id/runs` | 最近 100 条 `{ runs: [...] }` |

创建示例:

```json
{
  "name": "daily-review",
  "to_team": "default",
  "to_agent_name": "steward",
  "prompt": "执行记忆中的管家巡检",
  "schedule": {
    "kind": "daily",
    "time": "09:00:00",
    "timezone": "Asia/Singapore"
  },
  "max_runs": null
}
```

schedule 还可为 `{ "kind": "once", "at": "2030-01-01T10:00:00+08:00" }`, `{ "kind": "interval", "start_at": "2030-01-01T10:00:00+08:00", "every_seconds": 3600 }`, 或在 daily 字段基础上改为 weekly 加 weekday, monthly 加 day.  HTTP 日历计划必须明确 timezone.  max_runs 为 null 表示无限, once 会归一为 1.  

## 运行语义

- 使用独立系统身份 `scheduler@__xats_schedules__`, 提示正文通过正常 `get_inbox` 返回.  每次按本设备的当前 name/team 查找目标, 不写死旧 thread, pane 或 agent ID.  
- 同计划上一条对当前目标仍未读时复用该消息并再次尝试唤醒, 记为 coalesced, 不新增重复 inbox 内容.  提示修改不会改写已发消息, 旧消息未读时仍合并至旧消息, 查收后下次事件使用新提示.  
- 复用现有 transport 的 guard, 忙时 steer 或 retry, 不另建业务 session.  inbox 已读不是业务任务完成证明, 业务巡检自身的互斥或阶段推进由目标 agent 负责.  
- 计划和执行历史持久化在 daemon SQLite.  消息与触发计数及下次时刻原子提交.  发送失败记具体原因; 提交后的 transport 错误不重复创建消息.  
- `queued` 表示消息入库, `coalesced` 表示复用未读消息, `failed` 表示未建信, `missed` 表示重启跳过循环时刻.  run 的 delivery 来自现有投递记录, read 由真实 inbox cursor 推导.  delivered 不等于 read.  消息已被现有 30 天清理删除时, delivery 和 read 返回 null, 不能声称已读.  
- 重启恢复后循环计划直接定位下一未来时刻, 到期 once 补发一次.  运行中休眠或时钟跳跃最多消费一个到期事件后定位未来, 不集中补发全部 tick.  无活动计划没有调度 timer, 不创建系统身份或发送消息.  
- 暂停和删除仅取消未来调度, 已入 inbox 的消息和 transport retry 不撤回.  计划时刻按秒支持, 受系统休眠, event loop 和 transport 延迟影响, 不保证硬实时到达.  

## 验证与激活

本轮不覆盖共享 dist 或重启生产服务.  开发侧 103 项定向测试通过, 包含调度, 时间边界, HTTP/CLI, Reminders, 旧消息及 PID 端口发现回归; 类型检查, 独立 ESM/dts 构建与 OpenSpec strict 校验通过.  独立代码审查最终 PASS.  tester 完成 8 项隔离验收和 3 项故障专项复验, 随后对端口发布修复后的候选构建完成 6 项真实进程启动和冷重启检查, 均 PASS.  

候选构建已经独立暂存, 实际入口, 校验值, 停机切换和回滚步骤见 [本机激活说明](scheduled-agent-wakes-activation.md).  正式启动仍需 jt 的原 shell 认证上下文, 不推测或复制 token.  

真实 agent runtime 唤醒 SKIPPED: 独立 CODEX_HOME 没有登录或可用 API key, 未复制凭据, 未向可能误查生产 inbox 的现有会话注入通知.  月末, DST 和每周边界使用确定性时间计算.  真实时钟触发和 MCP get_inbox 已验证, transport sink 为模拟.  追加冷启动验收使用两个真正独立 Node CLI 进程, 不存在的隔离目标准确记录 unknown_recipient, 未用模拟 sink 冒充真实 agent.  

调度报告: [本机网页](http://127.0.0.1:65175/report.html), 至新加坡时间 2026-11-01 09:30 自动结束.  离线目录为 `.e2e-test/runs/20261010-expire-stale-agents/.e2e-test/runs/schedule-wakes-final-20261030-013027-q29v72s3/`.  后续 CLI 端口发布修复的真实进程证据为 `.e2e-test/runs/20261010-expire-stale-agents/schedule-final/cold-smoke-fixed-result.json`.  当前全部构建输入已与新候选中的 `source-sha256.json` 校验一致.  
