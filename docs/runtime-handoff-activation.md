# Runtime handoff 本机激活候选

状态: 2026-11-04, jt 已决定暂不重启共享 daemon, 因影响范围较大.  本轮激活和真实现场测试暂缓, 不再等待或重复请求确认.  仅保留候选和备份, 共享 daemon/dist/真实身份/pane 均未改动.  后续必须取得新的明确激活授权并重新核对现场和备份时效, 不能直接执行下方历史准备步骤.

## 已核对目标

- 当前 xats daemon PID 为 58307, 入口为本仓库 dist/cli.js, host=0.0.0.0, port=9100, device=jt.  执行前必须重新核对 PID 文件和进程入口, 不照抄旧 PID 发信号.
- 原生 JSON PID 文件为 ~/.cross-agent-teams-mcp/daemon.pid, 本机 wrapper 的整型 PID 文件为 ~/.config/xats/local/daemon.pid, 当前均指向同一个 daemon.
- 当前健康检查显示 53 个已注册 MCP session, 与当前会话同用这一服务.  重启会短暂断开 MCP, 客户端需重连或重注册.
- SQLite 文件由当前进程打开, 路径为 ~/.cross-agent-teams-mcp/data.db.  原 token 与 ~/.config/xats/token 的内容在脚本内比较一致, 没有输出任何凭据.
- 普通 start-xats 会同时影响 Codex app-server, 不作为本轮的 daemon-only 切换入口.  不停止 TUI, tmux server/session, Codex/OpenCode/Kimi runtime.

## 备份与候选

受限目录为 /Users/jtianling/.cross-agent-teams-mcp/backups/runtime-handoff-20261104T110507Z, 目录0700, 数据库和元数据0600.

- previous-dist/: 原共享 dist 的16个文件.
- candidate-dist/: 已通过检查候选的16个构建文件.
- data.db: SQLite在线备份, 不是直接复制WAL中的主文件.  integrity_check通过, 已在临时隔离文件完成恢复和逐表行数核对.
- preflight.json: 时间, 产物大小/hash, 两套dist逐文件hash与核验结果, 不含token.

候选原始证据为 .e2e-test/runs/runtime-handoff-20261104-182944/.  xats 23文件260测试, 类型检查, 隔离构建, OpenSpec strict和独立review通过.  AoE helper对隔离daemon/WS fixture的HTTP/CLI合同测试5/5通过, AoE独立review通过.  原生TUI产品E2E仍未执行, 未修改用户13号/%44现场.

## 待用户确认的切换步骤

1. 重新核对当前daemon精确PID/入口, 目标SQLite和候选/现有dist hashes.  若现有dist或进程已变化则停止重新核对.  现有在线备份在真正切换前复核时效, 需要时另做一份, 不覆盖旧备份.
2. 仅向已确认的xats daemon发送SIGTERM, 等待退出及9100监听释放.  不在旧进程运行中替换动态import的dist.  替换完整dist后沿当前启动参数和原本地token启动同一daemon, 更新两份PID文件的各自格式.  不重启app-server/TUI/tmux或其他runtime, 不运行会连带停止它们的通用start/stop函数.
3. 核对health, 相同device/数据库/端口和新handoff路由的只读或无匹配身份请求, 恢复本会话xats身份, 确认客户端可以重连.  接着通知aoe-main仅做用户另已授权的目标pane验证, 不替它操作现场.

若新daemon在任何真实handoff写入前启动或冒烟失败, 保留失败产物并恢复旧dist/原启动参数.  若已经有真实handoff提交, 先停止继续交接并报告, 不直接回滚至无新fence防护的旧代码.  数据库备份仅提供恢复依据, 不自动恢复生产数据库, 避免丢失备份后新增消息及状态.
