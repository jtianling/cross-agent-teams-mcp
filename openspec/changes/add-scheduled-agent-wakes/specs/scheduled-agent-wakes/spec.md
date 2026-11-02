## ADDED Requirements

### Requirement: 明确时间和循环规则
系统 SHALL 支持未来一次性时刻, 固定秒间隔, 每日, 每周和每月固定时分秒计划. 日历计划 MUST 保存时区, weekly 使用 ISO weekday, monthly 缺日期跳过, DST 缺失时刻跳过且重叠只取较早一次. 循环计划 SHALL 支持无限或有限累计触发次数, once 固定一次.  

#### Scenario: 有限循环
- **WHEN** 创建每周一 09:00 的三次计划
- **THEN** 三个触发时刻消费后计划结束, 不再安排第四次

#### Scenario: 月底及夏令时
- **WHEN** 配置每月 31 日或 DST 不存在的本地时刻
- **THEN** 跳过缺失日期或时刻, 重叠时刻不得重复触发

### Requirement: 动态持久管理
系统 SHALL 提供本机 CLI 和 HTTP 的创建, 查询, 修改, 暂停, 恢复, 删除及最近执行记录. 相同 name 和配置重试 MUST 幂等, 同名不同配置 MUST 冲突. 无活动计划 SHALL 无调度定时器. 服务重启 MUST 保留计划, 跳过循环过期时刻而非集中补发, 到期 once SHALL 补发一次.  

#### Scenario: 无需重启管理
- **WHEN** 服务运行中增删改或暂停恢复计划
- **THEN** 新配置立即生效, 暂停和删除只影响未来调度

#### Scenario: 重启与时钟跳变
- **WHEN** 停机跨过多个循环时刻或时钟向前跳
- **THEN** 恢复不回放全部 tick, 正常运行最多消费一个到期事件并推进到未来

### Requirement: 系统消息与可观察性
系统 MUST 只向本设备当前 name/team 目标发送计划提示, 使用专用系统身份, 正常进入 inbox. 系统 SHALL 分别提供消息创建, transport 结果及真实 get_inbox 已读证据, 保存具体失败原因. 同计划上一条对当前目标仍未读时 SHALL 合并并计入有限次数. 消息和计划推进 MUST 原子提交, 已提交后的派发失败 MUST 不重复建信.  

#### Scenario: 当前身份和读取
- **WHEN** 目标重新注册或更换当前 runtime
- **THEN** 发送按当前身份定位, transport delivered 不代表 read, 仅真实 inbox cursor 推进表示读取

#### Scenario: 忙时与故障
- **WHEN** 上一条仍未读或目标不存在或 transport 失败
- **THEN** 合并未读事件或保存具体失败, 不产生同计划重复未读提示, 不冒用业务身份

### Requirement: 管理边界
管理接口 MUST 受现有 daemon token 与 loopback 限制, 严格验证时区, 时间, 次数, 目标和未知字段. 不配置功能的调用者 SHALL 继续正常使用既有 MCP 与消息功能.  

#### Scenario: 无效和远程请求
- **WHEN** 请求来自非 loopback, token 错误, 目标带设备后缀或时间配置无效
- **THEN** 返回明确错误, 不创建计划或触发唤醒
