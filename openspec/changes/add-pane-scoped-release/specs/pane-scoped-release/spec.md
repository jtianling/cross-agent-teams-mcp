## ADDED Requirements

### Requirement: 本机严格批量控制
系统 MUST 仅接受本机鉴权launcher请求, 严格验证完整tmux坐标和最多16个不重复目标.  identity_key若存在必须保留原字节, managed MUST 使用既有fenced release.

#### Scenario: 外部请求和托管成员
- **WHEN** 非loopback请求或目标为managed身份
- **THEN** 明确拒绝且不删除任何身份.

### Requirement: 精确当前归属证明
系统 MUST 核对socket所有权和server代次, 普通分支还须核对活pane和前台carrier.  给定key或native session必须与同一身份一致, 不得凭key或旧pane编号删除已转移的身份.  显式dead key缺席分支必须使用独立的严格物理与身份缺席证明.

#### Scenario: OpenCode没有存量pane字段
- **WHEN** 前台attach载体的exact URL/session匹配唯一当前OpenCode身份
- **THEN** 允许进入后续CAS, 不猜最新session或修改进程.

#### Scenario: 手动无key和停止pane
- **WHEN** 请求省略key或pane已经停止
- **THEN** 前者仍须验证唯一当前物理身份; 未显式启用dead key缺席证明的停止pane必须拒绝, 不得声称已释放.

#### Scenario: 旧 server 代次的其他身份残留相同 pane 编号
- **WHEN** 给定 key 无 holder, 旧记录持有不同非空白 key, verified 绑定早于当前 server 代次, 旧 PID 已确定消失且非 managed
- **THEN** 仅排除旧物理 pane 别名, 保留完整历史身份及其逻辑 runtime 归属检查, 仍核对当前完整物理证明.

#### Scenario: 历史记录仍持有当前 attach 的逻辑 session
- **WHEN** 新 pane 的 OpenCode attach 与历史记录指向同一 URL/session
- **THEN** 继续验证该逻辑 owner 和 key, 不因旧物理别名过期而返回已未注册.

### Requirement: 显式 dead key 缺席证明
系统 MUST 仅在target显式携带 `allow_dead_if_identity_unclaimed:true` 和原字节非空白key时启用dead分支, 禁止同时携带OpenCode session.  服务端 MUST 独立取得 `pane_dead=1`, PID0和严格空TTY的准确物理快照.  标记目标已变live, 缺key, 存在任何agent holder, 同pane存量身份或未释放managed claim时必须拒绝, 不得降级普通分支.  成功 SHALL 仅返回 `dead_key_unclaimed` 和null agent, 不宣称未知logical身份已注销.

#### Scenario: prepared managed key 尚无 agent row
- **WHEN** key lookup返回not_found, 但同key有prepared或bound managed claim
- **THEN** 返回409 managed_control_required, 同批活peer不得注销.

#### Scenario: 旧 binding 的身份已迁移到其他 pane
- **WHEN** 当前dead pane无存量身份, 旧binding关联身份已明确登记在其他pane且旧PID已消失
- **THEN** 保留未被同批显式释放的迁移身份及旧binding, 并将关联身份和binding完整快照纳入最终复核.

#### Scenario: dead 证明期间 respawn 或出现新 holder
- **WHEN** 两轮物理证明或最终事务之间发生pane代次, key, 同pane身份, pending launch, managed claim或关联binding变化
- **THEN** 拒绝整批, 不注销活peer; API返回之后的物理删除仍由launcher复核.

### Requirement: 原子释放与晚到竞争复核
系统 MUST 先完成全部目标证明, 再在同一事务中复核注册代次, runtime, pane与竞争者集合.  任一目标失效或存储失败 MUST 不部分删除.

#### Scenario: 晚到同runtime注册
- **WHEN** 第二轮probe期间新增竞争身份但旧目标行未变
- **THEN** 事务复核拒绝整批, 不能只比较原目标行.

#### Scenario: 历史物理别名在证明后被重新注册或转为 managed
- **WHEN** 历史快照或相关 managed claim 在两轮证明及提交之间变化
- **THEN** 拒绝整批, 不修改历史身份或已验证 peer.

### Requirement: 幂等和会话清理
系统 SHALL 对仍可核验且无身份的活pane返回already_unregistered, 对已释放目标关闭其MCP连接并保留历史消息.  错误必须包含目标索引与重试分类, 日志记录具体原因且遮盖批次全部key.

#### Scenario: 左右pane重复释放
- **WHEN** 同批成功后重发相同请求
- **THEN** 返回按请求顺序的幂等结果, 不修改其他成员或停止其runtime.
