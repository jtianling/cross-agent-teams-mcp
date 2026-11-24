# Launcher 精确 pane 批量反注册 v1

状态: 2026-11-11 开发合同, 共享daemon尚未激活.  接口用于AoE删除session之前释放普通pane的xats身份, 不停止任何进程, 不kill tmux或原生runtime.  managed pane继续使用原fenced managed release, 不放入本批次.

2026-11-16 当前对接策略: AoE删除入口对xats身份释放采用best-effort.  释放失败不得阻止本地session删除, 具体HTTP/错误码/目标索引持久记录且遮盖key/token, 未释放身份保留.  不直接删除身份, 不放宽xats校验, 不将失败宣称为已注销.  本地session归属变化, 文件存储或进程清理失败仍正常报错.  此策略替代此前将xats释放作为AoE删除硬前置条件的描述, 不改变服务端批量原子性, 无需为此激活候选.

## 请求

POST `/api/runtime/panes/release`, 复用daemon bearer, 仅接受实际loopback来源.  不增加agent-facing MCP工具.  JSON严格拒绝未知字段, targets数量1到16, 同批不能重复完整pane坐标或已给定identity_key.

```json
{
  "protocol_version": 1,
  "targets": [
    {
      "tmux": {
        "socket_path": "/private/tmp/aoe-example.sock",
        "server_pid": 12345,
        "server_started_at": 1793000000,
        "pane_id": "%7"
      },
      "identity_key": "<本地slot原key>"
    },
    {
      "tmux": {
        "socket_path": "/private/tmp/aoe-example.sock",
        "server_pid": 12345,
        "server_started_at": 1793000000,
        "pane_id": "%8"
      },
      "opencode_session_id": "ses_example"
    }
  ]
}
```

示例PID和代次只是占位, 必须从明确tmux server inventory取真实值.  socket_path为无控制字符的绝对路径, server_pid/server_started_at为正安全整数, pane_id为百分号加数字.  identity_key可省略以支持手动注册, 给定时必须非空白且不trim, 不能把不同key的当前成员当旧key已注销.  opencode_session_id可省略, 给定时必须为ses前缀并与精确当前attach和登记一致.  不接受name/team模糊删除或单独agent_id.

默认v1只接受可核验的活pane.  停止/缺失pane, socket离线或缺少server代次时明确失败, 不声称其成员已经释放.  无key也必须验证当前物理身份.  原生绑定沿用pane lookup的verified_pid_tty_pane, PID启动时间, TTY/前台及Codex launch证明.  OpenCode HTTP row没有pane/PID时, 在指定socket的pane TTY枚举前台载体, 支持 `opencode attach <URL> --session <ses>` 或 `-s <ses>`, 并严格匹配唯一当前URL/session/key.  不查询最新session, 不把opencode server进程当attach客户端.  载体/参数无法可靠解析或存在多组前台匹配时失败关闭.

2026-11-15 开发候选新增 [显式dead key缺席证明](dead-pane-key-absence.md): 只有原批target明确opt-in并通过独立服务端证明时返回 `dead_key_unclaimed`.  此扩展尚未激活, 不改变未携flag的原合同.

## 响应

HTTP200完整固定envelope:

```json
{
  "ok": true,
  "protocol_version": 1,
  "results": [
    {
      "index": 0,
      "state": "released",
      "agent": {
        "agent_id": "<实际原agent_id>",
        "name": "worker",
        "team": "project",
        "agent_type": "claude-code"
      }
    },
    {
      "index": 1,
      "state": "already_unregistered",
      "agent": null
    }
  ]
}
```

results数量和顺序必须与targets完全一致, index从0连续.  released必须agent非null, already_unregistered必须null.  agent_type为字符串或null以兼容旧数据, 不将未知类型推断成某已知类型.  响应不包含key, token或完整进程argv.

错误固定envelope:

```json
{
  "ok": false,
  "protocol_version": 1,
  "error": "stale_binding",
  "detail": "identity_ownership_changed",
  "target_index": 0,
  "retryable": false
}
```

| HTTP | error | 语义 |
| --- | --- | --- |
| 400 | invalid_request | 整个请求schema或JSON无效, target_index=null |
| 403 | remote_forbidden | 实际来源非loopback, target_index=null |
| 409 | identity_mismatch | key, session或已存pane指向其他身份/位置 |
| 409 | ambiguous_identity | 多个身份或载体, 无法唯一授权 |
| 409 | pane_unverifiable | pane停止, server代次不符或缺当前carrier证明 |
| 409 | stale_binding | probe期间或提交时归属/注册/launch/竞争者集合变化 |
| 409 | managed_control_required | 必须改用原managed fenced release |
| 503 | probe_failed | socket/tmux/ps探针失败, retryable=true |
| 500 | internal_error | 具体脱敏原因见daemon日志, target_index=null |

目标错误的target_index为对应请求索引.  其他错误retryable=false, 不自动放宽归属或改用旧DELETE.  daemon外层401沿用原鉴权响应, 旧版本缺该路由的404仍为Fastify格式, 均不是释放成功.  不对detail字符串做固定枚举匹配, 它只解释机器错误码.

## 原子性与生命周期

所有目标先取得并复核socket/server/pane/carrier证据, 随后单一SQLite事务中再核对原注册代次, exact delivery, key, 物理绑定, Codex launch及竞争者集合.  任一验证或归属冲突不删除任何目标.  不能只比较旧行不变, 晚到的同runtime或同pane竞争者也会阻塞.  心跳, 已读cursor和新消息不属于归属变更.

成功复用既有registry移除路径, 释放name/team, 保留历史messages.  收尾只关闭已释放agent对应的MCP session和旧绑定/回调, 不删除其他成员或proxy身份, 不停止原生runtime.  原模型进程仍活时不保证它永不发起新注册, AoE必须在成功后立即按原删除流程停止唯一目标pane并删除其资源, 不把本接口当停止进程的替代品.

系统进程状态无法与SQLite一起持锁, 本接口是保守的当前快照证明, 不是对未来pane状态的保证.  多个TUI共享一个native session应由启动器避免, 不能凭该接口主张某个TUI独占共享native session.  xats验证失败, 非完整成功响应或网络中断时, AoE按当前best-effort策略记录身份释放失败并继续自己的session删除流程.  未释放身份保留, 不猜已注销, 不自动回滚数据库或强删身份; 本地归属和资源清理错误仍独立处理.

本轮不注销任何真实成员用于测试, 不重启共享daemon或替换共享dist.  隔离验证结果见下方, 能力未激活时客户端必须记录不可用, 不能宣称释放成功, 但不因此阻断本地session删除.

## 验证与联调候选

14个定向文件共170项测试通过, 宿主tmux/ps护栏记录零调用.  TypeScript检查, 隔离ESM/声明构建, OpenSpec strict和独立代码复审均通过.  覆盖16-pane成功, 归属转移, 晚到native/PID/pane竞争者, 无成员时的晚到managed claim, 存储失败整批回滚, 手动无key, OpenCode exact attach, 停止root拒绝, 全批key最长优先脱敏, MCP会话关闭, 消息保留及名字再次注册.

默认探针边界另用自建Unix socket和假tmux/ps可执行文件验证, 没有运行真实tmux/ps.  真实socket所有权/类型检查实际执行, 验证子进程清除TMUX/TMUX_PANE并显式使用目标socket, OpenCode的TTY进程查询使用精确session.  这不是原生产品或真实成员E2E.

候选与证据为 `.e2e-test/runs/pane-release-20261111-180539/`, 包含 `manifest.json`, `source-sha256.json`, `targeted.log`, `guard.log` 及静态/构建日志.  `candidate/dist/cli.js` 是当前整个工作区构建, 包含上轮尚未部署的runtime-handoff改动, 不宣称只包含本接口.  仅供临时db/pid-file, 独立device, 显式token和随机loopback端口的隔离联调.

共享daemon/dist未修改, 真实成员未注销, 未提交或发布.  jt此前暂不重启共享服务的决定继续有效, 不为本轮再次请求重启.  旧daemon缺少本路由时AoE必须保留记录并报告不可用, 不能静默绕过前置释放或调用旧DELETE代替.

## 2026-11-13 运行状态与 dead inventory 修复

只读确认共享daemon现已加载release路由, 此前未激活描述为历史记录.  现场遇到非目标pane PID0/空TTY导致全inventory解析503, 源码修复及174项回归已通过, 本轮尚未替换运行dist或重启.  详见 [修复与本机切换准备](dead-pane-inventory-fix.md).

## 2026-11-14 上一 server 代次的物理 pane 别名

开发候选允许严格排除旧物理别名: 请求必须有原字节 key 且该 key 无 holder; 同 pane 编号的旧记录必须持有另一个非空白 key, 保留 verified PID/TTY 绑定元数据, 绑定时间早于当前已核实 server 启动代次, 旧 PID 确实不存在, 且不属于 managed.  缺失证明, 同代次记录, 旧 PID 存活或未知均仍拒绝.  不以 lookup 的 unverifiable 状态直接推断未注册.

排除仅影响物理 pane 编号冲突, 不影响逻辑 runtime 归属判断.  OpenCode 同 URL/session 再次 attach 等情况仍核对全部身份.  历史记录, key, 消息和 MCP 连接不修改; 两轮证明后事务再次核对历史完整快照, 新 owner, managed claim 和所有原有竞争者.  任一变化整批拒绝, 不注销已验证 peer.  409 返回现在也记录具体 error/detail/target, 不输出 key 或完整 argv.

本候选不会绕过全局无位置 Codex owner 的保守检查.  若当前未知 UI 无 thread 证明, 仍可能返回 `no_verified_current_carrier`; 不因此停进程或伪造注销成功.  本轮未实现新 quiescence/ticket 接口.  AoE 可在用户明确删除意图下另行核实并关闭准确未知 pane, 保留所有无法映射的 logical owner, 再使用既有 CLI 删除其余 session.  pane 缺席 key 查询与随后 peer release 不在同一事务, 不对整次跨请求操作宣称严格原子性.
