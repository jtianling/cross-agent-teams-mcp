# 显式 dead pane key 缺席证明

状态: 开发候选, 尚未激活.  这是原 `POST /api/runtime/panes/release` 的严格opt-in扩展, 不新增路由, ticket或DB schema.  没有flag的原live-only行为保持不变.

2026-11-16 当前AoE策略已改为best-effort身份释放: xats失败不阻止session删除, 错误持久记录, 未释放身份保留.  本文仍描述服务端严格合同和已验证候选, 不要求为本地删除启用候选, 不授权放宽身份检查或静默伪造释放成功.

```json
{
  "protocol_version": 1,
  "targets": [
    {
      "tmux": {
        "socket_path": "/private/tmp/example.sock",
        "server_pid": 12345,
        "server_started_at": 1794566104,
        "pane_id": "%7"
      },
      "identity_key": "<活peer原key>"
    },
    {
      "tmux": {
        "socket_path": "/private/tmp/example.sock",
        "server_pid": 12345,
        "server_started_at": 1794566104,
        "pane_id": "%8"
      },
      "identity_key": "<本dead slot原key>",
      "allow_dead_if_identity_unclaimed": true
    }
  ]
}
```

坐标是占位, 必须由launcher读取实际值.  flag只接受字面量true或省略.  显式分支必需原字节非空白key, 不得携带 `opencode_session_id`, 不接受客户端自报 `pane_dead`.  不支持字段的旧daemon会返回400, 客户端不得以过滤dead target或降级请求伪装释放成功.  AoE可按当前策略记录该失败后继续本地session删除, 不删除未释放的身份.

服务端按准确socket及server代次取得包含 `pane_dead` 的tmux inventory, 独立确认唯一目标为dead=true, pane_pid=0, TTY严格为空.  `?` 或空白未知TTY不当成空TTY.  标记目标变live, PID仍为正数, 缺少明确dead标志或socket/server代次改变均拒绝, 不回退普通live分支.  同批两轮完整物理证明必须一致.

同key的任何role agent holder, 同pane的任何存量agent row, 或同key的prepared/bound managed claim均阻断.  不使用 `identity-key/lookup:not_found` 代替managed检查, 因为该lookup只查agent row.  不允许无key dead pane或猜测其他key的身份.

旧Codex binding的owner仍声明当前pane或没有明确迁移位置时拒绝.  已迁其他pane的owner或已移除owner, 只有旧binding结构完整且旧PID明确消失时才可继续.  旧PID被复用也拒绝.  无owner的未完成binding必须为空快照; 活跃或期限未知的pending预登记仍拒绝.  具体managed关联继续使用原fenced路径.

最终单一SQLite事务重新核对key/pane缺席, managed claim, 旧binding关联owner完整归属字段和binding/pending快照.  任一目标失败不注销已验证peer.  心跳和消息cursor不属于归属变化.  dead分支自身不删除身份, binding, managed claim或历史消息; 没有被同批显式释放的迁移owner和无位置logical owner完整保留.  若旧binding的owner恰为同批明确授权释放的活peer, 该活owner仍按原注销流程清理其旧binding.

```json
{
  "ok": true,
  "protocol_version": 1,
  "results": [
    {
      "index": 0,
      "state": "released",
      "agent": {
        "agent_id": "<实际活peer UUID>",
        "name": "worker",
        "team": "project",
        "agent_type": "claude-code"
      }
    },
    {
      "index": 1,
      "state": "dead_key_unclaimed",
      "agent": null
    }
  ]
}
```

`dead_key_unclaimed` 只能对应请求了flag的准确目标.  它证明该dead物理目标的slot key在提交时没有agent holder或未释放managed claim, 不表示所有旧或未知logical身份已注销.  普通结果仍为 `released` 或 `already_unregistered`.  数量, 顺序和index保持原合同; 响应不包含key或完整argv.

无效组合返回400, 物理/归属/managed冲突仍返回409及目标索引, probe失败返回503和retryable=true.  保留原错误envelope, 不对detail文本作固定枚举匹配.  failed batch不部分注销, 存储失败回滚, 不自动删资源或恢复agent.

服务端不能将OS状态与SQLite一起锁住.  本扩展将dead key缺席断言与活peer注销放进同一事务, 但launcher仍须在release前后及最终物理删除前复核完整session/pane集合和代次.  API返回之后新增pane或respawn仍须明确拒绝, 不宣称跨进程全局锁.  本接口不停止进程, 不操作native thread或共享backend.

候选激活需要另行明确批准共享daemon-only切换, 当前运行服务不会因源码和隔离验证自动更新.  不需要升级或重启app-server或agent TUI; daemon切换会短暂断开MCP.  激活与回退边界沿用 [本地daemon脚本](start-only-xats.md), 不回滚生产DB.

## 验证与待批准激活

6 个定向文件共 102 项通过, 类型检查, 隔离 ESM/声明构建, OpenSpec strict 和独立 review PASS.  存储回滚用两个活peer验证: 第二个delete失败时, 已删除的第一个peer会随事务恢复.  真实临时loopback HTTP验证有序混合成功, 以及prepared/bound managed无agent row仍拒绝整批.  默认探针使用实际自建Unix socket和假tmux/ps, 验证7字段inventory和子进程环境清理, 没有宿主tmux/ps调用.

编译CLI另使用临时DB/PID, 随机loopback端口和假tmux/ps完成合同验收.  当前旧dist收到新flag返回400, 且probe零调用; 候选真实HTTP返回200的 `released` + `dead_key_unclaimed`, prepared managed反例返回409并保留活peer.  临时daemon和socket均已清理.  这不是对真实UI或真实成员的删除测试.

候选与证据: `.e2e-test/runs/dead-target-unclaimed-20261115/`, 包含完整 `candidate/dist`, `manifest.json`, `before/`, 单测/类型/构建/spec日志, `cli-contract.py` 和 `cli-contract.json`.  全部sourcemap按最长完整项目相对路径比较: 当前dist有129项本项目源文件, 候选有130项.  仅以下9个生产文件变化, 包含此前尚未激活的必要历史别名修复及其409日志, 没有夹带其他WIP运行行为:

- `src/pane-lookup/probes.ts`, `src/pane-lookup/service.ts`.
- `src/pane-release/snapshot.ts`, `carrier.ts`, `schema.ts`, 新增 `dead.ts`.
- `src/pane-release/proof.ts`, `service.ts`, `routes.ts`.

若jt明确批准现在启用, 由AoE统一协调一次切换.  在本项目根目录先执行只读指纹核对:

```sh
node .e2e-test/runs/dead-target-unclaimed-20261115/verify-candidate.mjs
```

核对源文件, 构建输入, 启动脚本, 候选和原运行dist均未变后, 再在本仓库执行 `./start-only-xats`.  脚本会备份原dist和SQLite, 暂存构建并只切换xats daemon, 使用同一DB/device/原token.  记录其输出的备份路径, 不运行会连带重启app-server的旧启动命令.  切换后检查健康和PID, 并核对运行JavaScript确实等于已审候选:

```sh
node .e2e-test/runs/dead-target-unclaimed-20261115/verify-candidate.mjs --activated
```

两个核对命令只读, 无任何信号或服务操作.  不同构建目录造成的sourcemap相对路径差异不作为运行代码差异, activated模式严格核对所有JavaScript文件及源/构建输入指纹.  任一不匹配不得沿用旧核对结果.  不通过真实成员release测试新能力, 使用隔离证据及已核对的运行构建验收.

若另行批准启用此候选, AoE新客户端由AoE侧安装, 已打开的AoE主TUI需退出重开才能加载新客户端逻辑, 这不表示重启agent pane.  共享MCP会短断并需恢复绑定, 不重启Codex app-server, Kimi服务或agent本身.  旧daemon400或异常响应不得被伪装为身份释放成功; 记录后继续本地删除属于当前best-effort策略, 不需要本候选激活.

启动失败由脚本尝试自动恢复原dist和启动配置.  若启动健康后出现功能回归, 仅停止此次准确daemon, 将该次备份的 `previous-dist` 恢复到本仓库dist, 按备份 `manifest.json` 的原Node/DB/host/port/device及原本地token重启同一daemon并更新原PID文件.  不把重新构建当前源码当作回退, 不回滚生产DB或恢复用户已删除的session.  具体边界沿用 [已有daemon-only切换准备](dead-pane-inventory-fix.md).

本轮没有执行共享切换, 未提交或发布, 没有把未激活代码宣称为产品已修复.  原26号session的删除已由AoE另行完成, 本候选用于后续自动处理满足严格合同的dead slot.
