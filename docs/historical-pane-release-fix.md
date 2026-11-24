# 上一 server 代次的 pane 别名释放修复

2026-11-14 的现场错误为 HTTP409, `pane_unverifiable`, `no_verified_current_carrier`.  两个当前活 pane 仍有上一 tmux server 代次的其他身份记录, 旧 PID 已退出.  同一编号不代表同一物理生命周期.  另外, 全局还存在无位置 Codex logical owner, 不能因此把当前未知 UI 视为未注册.

候选只修复第一层历史物理别名判断.  目标 key 必须无 holder, 旧记录持有另一非空白 key, 有 verified PID/TTY 元数据, 绑定早于已验证当前 server 代次, 旧 PID 明确消失, 且非 managed.  旧记录只豁免物理 pane 编号冲突, 逻辑 runtime 归属仍完整校验.  历史身份, key, 消息和 MCP 连接均保留.  两轮证明和最终事务 CAS 检查历史快照及晚到普通/managed owner, 任一失败不注销已验证 peer.  HTTP409 现在记录具体安全原因.

本候选不放宽未知 live Codex carrier 检查, 不新增 quiescence/ticket 接口.  当前存量删除另由 AoE 在用户明确删除意图下, 即时核实完整 instance/session, socket/server 代次及准确未知 pane/root/载体后, 关闭两个准确未知 pane, 保留全部无法映射的 logical/managed owner, 再使用原 CLI 删除剩余 session.  不猜 thread, 不补登记, 不删除未知身份或直接修改 DB.  缺席 key 查询与随后 peer release 不是同一事务, 不声称整个跨请求过程严格原子.

验证: 4 个定向文件共 64 项通过, 类型检查, 隔离 ESM/声明构建, OpenSpec strict 和独立 review PASS.  OpenCode 同 URL/session 仍由历史身份持有的反例已先复现失败再修正.  覆盖历史身份/邮箱/MCP 连接保留, key 非空白, 旧 PID 复现/未知, 晚到 owner/managed 与批量失败保留 peer.  默认探针边界使用自建 socket 和假 tmux/ps, 没有执行真实 tmux 命令或调用真实 release.

候选与证据在 `.e2e-test/runs/historical-pane-release/`: `candidate/dist/`, `manifest.json`, `before/`, `targeted.log`, `typecheck.log`, `build.log`.  完整构建按所有 JavaScript sourcemap 的完整项目相对路径比较, 避免构建复制后相对路径失真.  本轮变化仅 `src/pane-release/proof.ts`, `service.ts`, `routes.ts`, 没有额外夹带其他工作区行为.

若后续明确批准激活, 在当前源码与候选仍一致时运行 `start-only-xats`.  它重新暂存构建, 核对当前 daemon 身份及鉴权, 备份原 dist 和 SQLite, 等待旧 daemon 退出后只启动 xats.  DB/device 与 `start-local-xats` 一致, app-server 和 UI 不重启.  MCP 连接会短暂断开, 客户端需恢复绑定.  新实例启动失败时脚本尝试自动恢复旧 dist 和原启动配置.

若启动健康后发现功能回归, 只停此次准确 daemon, 恢复该次脚本输出的备份目录中的 `previous-dist`, 按该目录 `manifest.json` 记录的原 Node/DB/host/port/device 和原本地 token 重启同一 daemon, 更新原 PID 文件.  不用重新运行构建代替功能回退, 不回滚生产 DB 或恢复已实际删除的成员.  操作流程沿用 [daemon-only 切换与回退边界](dead-pane-inventory-fix.md), token 不进入命令记录或文档.

本轮没有替换共享 dist 或重启 daemon, 未提交或发布.  当前一次性存量删除路径使用已激活的原 v1, 不需要为这次源码候选先重启 daemon.
