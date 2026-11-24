# 仅启动或重启 xats daemon

在项目根目录运行:

```sh
./start-only-xats
```

本机已在 `~/.local/bin/start-only-xats` 放置指向仓库脚本的链接, 可以在任意目录直接运行 `start-only-xats`.

脚本先暂存当前源码的新构建, 备份原构建和 SQLite 数据库, 再停止原来运行的 xats daemon, 等待旧进程退出后启动新实例.  停止前核对进程身份和鉴权, 已运行的 Node 路径和 token 会保留.  新实例启动失败时尝试恢复原构建, 按旧服务原有参数重新启动, 不自动回滚数据库.  构建失败不会停止旧服务.

正常运行时与本机 `start-local-xats` 使用相同配置: 数据库为 `~/.cross-agent-teams-mcp/data.db`, device 为 `jt`, 监听 `0.0.0.0:9100`.  如果设置了 `CROSS_AGENT_TEAMS_MCP_HOME`, 两个命令都会使用该目录下的 `data.db`.  原 daemon 没有显式传入 `--db` 时, 脚本会核实该进程确实打开了默认数据库文件.

Codex app-server, Kimi 和 tmux session 不会被重启.  daemon 切换期间 MCP 连接会短暂中断.

默认使用 `~/.cross-agent-teams-mcp/daemon.pid`, 同步更新 `~/.config/xats/local/daemon.pid`, 日志写到 `~/.config/xats/local-daemon.log`.  首次启动时读取 `~/.config/xats/token`, 也可通过 `CROSS_AGENT_TEAMS_MCP_TOKEN` 提供 token.  默认监听 `0.0.0.0:9100`.  备份位于状态目录的 `backups/start-only-*`, 具体路径会在执行时输出.  未识别的启动参数或其他进程占用会使脚本拒绝继续.

脚本需要项目依赖已安装, 以及 Node.js, pnpm, Python 3, ps 和 lsof.  它只提供本地 daemon 切换, 不发布 npm 包.

若执行过程中被强制中断, 锁目录可能保留.  再次执行时会提示锁路径.  先核对目录内 `owner.pid` 对应的进程已退出, 并确认没有其他切换任务, 再删除该锁目录后重试.  不要在切换过程中中断脚本.

`--repo PATH --state-dir PATH` 用于隔离测试, 必须指向另一份项目目录.  隔离模式将 PID, token, 日志和数据库都放入指定状态目录, 首次启动监听 `127.0.0.1` 的随机端口, 重启时保留隔离实例的原配置.
