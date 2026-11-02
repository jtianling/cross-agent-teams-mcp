# 本机定时唤醒候选构建激活

本轮只完成候选构建和说明, 未停止或重启共享 daemon, 未覆盖现有 dist, 未修改生产数据库或 token.  

## 已核对的现场

- 当前 PID: `23112`, 启动于本地时间 `2026-10-29 15:57:00`.  PID 只是本次核对结果, 以后不得据此直接发信号.  
- Node: `/Users/jtianling/.nvm/versions/node/v25.1.0/bin/node`.  
- 入口: `/Users/jtianling/workspace/cross-agent-teams-mcp/dist/cli.js daemon`.  
- 显式启动选项: `--host 0.0.0.0 --port 9100`.  认证参数和原进程环境未采集.  
- 数据库: `/Users/jtianling/.cross-agent-teams-mcp/data.db`.  
- PID 文件: `/Users/jtianling/.cross-agent-teams-mcp/daemon.pid`, 当前 JSON 为 pid/port.  `.config/xats/local/daemon.pid` 是另一份整型 PID 文件, 不能当 daemon 原生 JSON 文件解析.  
- stdout/stderr: `/Users/jtianling/.config/xats/local-daemon.log`.  
- 只读检查显示生产已有 3 条 Reminders 规则, schema 含 event/tag, 尚无 wake_plans 表.  本轮没有更改这些规则.  

未发现已核验的 xats LaunchAgent 或通用 restart 命令, 当前父进程为 zsh.  必须由 jt 在原 shell/原启动上下文保留认证配置启动, 不能只凭上面的非敏感参数重建命令.  这是尚缺的操作者信息, 不读取进程环境或复制凭据来补齐.  

## 候选产物

绝对路径:

```text
/Users/jtianling/workspace/cross-agent-teams-mcp/.cache/xats-staged-wakes/20261030T014820Z
```

- `dist/`: 完整 16 个产物, 包含 CLI, channel CLI, 动态 import 分块和类型文件.  
- `SHA256SUMS`: 所有 dist 文件的 SHA-256.  
- `manifest.json`: 构建时间, 实际 HEAD, Node, 工作区变更清单和验证边界.  
- `source-sha256.json`: 构建输入快照.  构建前后输入一致.  
- `live-dist-sha256.json`: 构建前后未改动的原 dist 校验值.  
- `build.log`: 独立构建日志.  

SHA256SUMS 自身 SHA-256 为 `e2297cca21ecaa47b70f039bef782af4d1f0fa276bba1d4e3325d88c3fa6c658`.  新 cli.js SHA-256 为 `bacb11a362ea99f8805f6e137476862193e50adfe80cc1b09e18d768d84177c5`, 现场原 cli.js 为 `249f6589507dfffe3d6ef2176f613d5356b35273598ea43ee49c7a30a918a504`.  

这是当前整个工作区的候选构建, 包含已有 Reminders, Codex challenge 修复和 pane lookup 等变更, 不声称只包含本次定时功能.  manifest 记录了所有 dirty 路径, 本轮没有替其它改动做提交或发布.  

## 校验和切换

以下步骤只是交付说明, 本轮没有执行切换.  

1. 校验完整候选产物:

```sh
cd /Users/jtianling/workspace/cross-agent-teams-mcp/.cache/xats-staged-wakes/20261030T014820Z
shasum -a 256 -c SHA256SUMS
```

2. jt 决定停机窗口, 在已确认的原 daemon 终端停止该 daemon.  会短暂中断 xats MCP/HTTP/唤醒连接, agent 业务进程不由本步骤停止.  不重启 AoE TUI, Codex app-server 或 tmux.  先让活动 agent 工作到合适的断点.  

3. 确认旧 daemon 已退出, 9100 已无监听, PID 文件不再指向活进程.  不在 daemon 运行时替换 dist: 动态 import 尚可能读取旧构建分块.  如果现场 dist 自构建后已被其它工作修改, 先停止本次切换, 重新核对候选版本.  

```sh
lsof -nP -iTCP:9100 -sTCP:LISTEN -t
```

该命令应无监听 PID 输出.  然后备份并替换整个目录, 若任一步失败就停止, 不继续启动:

```sh
task_root=/Users/jtianling/workspace/cross-agent-teams-mcp
task_stage="$task_root/.cache/xats-staged-wakes/20261030T014820Z"
test ! -e "$task_stage/previous-dist" && \
  mv "$task_root/dist" "$task_stage/previous-dist" && \
  cp -R "$task_stage/dist" "$task_root/dist"
```

4. jt 在原 shell 中使用原启动命令和认证上下文重新启动同一 daemon.  保持原数据库, PID 文件, device, host/port 和 token, 不创建第二套生产服务.  上面的显式选项不是完整启动命令, 不应自行补一个无认证的 `0.0.0.0` 启动命令.  

5. 核对新监听仍为 9100, PID 文件属于新进程, `/health` 正常.  使用原认证环境执行 `schedules list --port 9100`, 由 steward 创建正式每小时计划并核验一次真实唤醒与真实 get_inbox 读取.  新计划的后续增删改, 暂停和恢复无需再重启.  

## 回滚

若新版本启动或验证失败, 先在其原终端停止新 daemon, 确认退出和端口空闲后, 保留失败构建并恢复旧目录:

```sh
(
  task_root=/Users/jtianling/workspace/cross-agent-teams-mcp
  task_stage="$task_root/.cache/xats-staged-wakes/20261030T014820Z"
  test -d "$task_stage/previous-dist" || exit 1
  test ! -e "$task_stage/failed-dist" || exit 1
  if test -e "$task_root/dist"; then
    mv "$task_root/dist" "$task_stage/failed-dist" || exit 1
  fi
  mv "$task_stage/previous-dist" "$task_root/dist"
)
```

然后仍由 jt 沿原启动上下文启动旧 daemon.  此回滚只恢复代码, 不撤回已发送消息或业务状态, 不直接编辑数据库.  新增计划表不会由旧版本执行, 保留其中数据, 不手工清表.  若任何目录已存在, 不覆盖它, 先核对当前切换状态.  
