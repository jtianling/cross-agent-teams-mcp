## ADDED Requirements

### Requirement: 三类规则独立配置

系统 MUST 要求显式选择 added, completed 或 tag 事件, 每条规则可独立指定本机 team/name 接收者.  tag 规则 MUST 指定非空 tag 名称, 非 tag 规则 MUST 拒绝 tag 字段.  tag 名称 SHALL 去除一个前导 #, 对 ASCII 英文大小写折叠并作 Unicode NFC 规范化, 拒绝空白和内部 #.  三类规则以及不同 tag MUST 可并存, 完全重复的规则 MUST 返回冲突.  所有规则 MUST 支持运行中增删与持久化, 无规则仍无监控副作用.

#### Scenario: 同一列表独立创建
- **WHEN** 对同一列表和接收者分别添加 added, completed 和 tag 规则
- **THEN** 三条独立规则均成功, 可分别查看或删除, 事件互不混用

#### Scenario: 拒绝缺少事件和错误参数
- **WHEN** 创建规则没有 event, tag 事件缺少 tag, 或其他事件带 tag
- **THEN** 返回输入错误, 不调用 remindctl 或建立规则

### Requirement: 独立新增与完成语义

added MUST 保持首次基线不回放和连续五分钟未修改后通知, MUST 不因完成动作单独通知.  completed MUST 监控任务左侧完成勾选对应的 isCompleted false→true, 在下一次扫描发现变化后通知, 不等待五分钟, MUST 不因新增任务或取消完成单独通知.

#### Scenario: 新任务很快完成
- **WHEN** 新任务先被观测到未完成, 随后在五分钟内被勾选完成
- **THEN** completed 规则在下一次扫描通知, added 规则继续其自己的编辑稳定期

### Requirement: 原生 tag 添加与稳定期

系统 MUST 通过原生 tags 判断指定 tag, 不从标题或备注猜测.  tag 规则首次 MUST 只建立基线, 后续任务从无指定 tag 变为有指定 tag, 或首次出现时即有该 tag, MUST 等待连续 30 秒内容及修改时间无变化才发送一次唤醒.  tag 保持存在 MUST 不重复通知.  稳定期内编辑 MUST 重置计时, 移除 tag 或删除任务 MUST 取消待通知, 移除后重新添加 MUST 重新计时并允许再次通知.

#### Scenario: 审核 tag 添加
- **WHEN** 基线任务被添加已审核 tag 并连续 30 秒无变化
- **THEN** 仅匹配该 tag 的规则发送一次固定唤醒信号

#### Scenario: 初始已有 tag
- **WHEN** 建立规则时任务已有目标 tag
- **THEN** 仅基线, 后续保持 tag 和其他内容编辑不回放 tag 通知

#### Scenario: 编辑与移除
- **WHEN** 等待期间修改内容或修改时间, 或移除目标 tag
- **THEN** 修改重置 30 秒等待, 移除取消通知, 重新添加重新等待

### Requirement: 读取隔离与可靠状态

只有 tag 规则 SHALL 读取 info --native.  系统 MUST 校验实际返回 task ID, list ID 和 tags 数组.  读取失败或缺少原生 tags MUST 显式记录错误, 不当作空 tag 推进状态.  删除规则 MUST 取消它的在途读取, 不再启动该规则的后续逐任务原生命令, 不影响其他规则和同时进行的新规则基线读取.  tag 等待和去重状态 MUST 跨重启持久化, 通知仍 MUST 与邮箱原子提交, 正文不包含任务或 tag 内容.

#### Scenario: 不支持原生读取
- **WHEN** tag 读取缺少 tags 或命令失败
- **THEN** 规则报告具体错误并保留快照, 其他正常规则仍能使用

#### Scenario: 重启等待中的 tag 规则
- **WHEN** tag 的 30 秒稳定期内重启 daemon
- **THEN** 恢复原指纹和等待时间, 不重建基线或重复通知

#### Scenario: 删除在途 tag 读取
- **WHEN** 某 tag 规则正在读取一个任务时删除该规则
- **THEN** 取消该次读取, 不再启动该规则其他任务的 info, 不通知或复活规则, 其他规则和新建基线读取继续正常工作

### Requirement: 旧规则安全迁移

若数据库存在旧新增与完成组合规则, 系统 MUST 原子迁移为两个独立规则, 保留接收者和已知任务快照, 迁移重试 MUST 不重复拆分, 不回放历史通知.

#### Scenario: 已有数据库升级
- **WHEN** 新版本首次读取旧组合规则表
- **THEN** added 保留旧 ID 与快照, completed 获得独立 ID 并保留完成状态, 再次启动不增加规则
