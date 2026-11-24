# Antigravity CLI 原生会话

`xats-agy` 在独立 PTY 中运行本机的 `agy`, 保留原生输入框和已有登录态.  每次启动生成独立的本机投递地址.  xats 有新邮件时, 启动器在空白输入框提交固定收信提示, 正文通过当前身份的 `get_inbox` 读取.  `send_message` 的已读回执表示收件方已经读信, 回复会作为另一封邮件送回.

本机需要 Python 3.9 或更新版本, 已登录的 Antigravity CLI, 以及包含此功能的 xats daemon 和两个命令行入口.  从本仓库安装时, 先执行 `pnpm build`, 再通过 `npm link` 将包内命令加入 PATH.  daemon 也需运行对应构建.  原生输入框已在 macOS 上使用 agy 1.5.14 的 inline 渲染模式验收.  在 Antigravity 的 MCP 配置中添加一次 stdio 服务:

```sh
agy mcp add --type stdio xats-agy xats-agy-mcp
```

用明确的名称和团队打开原生终端会话:

```sh
xats-agy --name reader --team demo -- --settings '{"useG1Credits":false}'
```

AoE 等持有独立 slot key 的宿主也可以先打开原生 TUI, 再由用户在当前会话中指定名称和团队:

```sh
xats-agy --defer-registration -- --settings '{"useG1Credits":false}'
```

宿主可以分别运行 `xats-agy --capabilities-json` 和 `xats-agy-mcp --capabilities-json`.  两个入口都报告 `defer_registration: 1` 时支持上述流程.  宿主仅向 launcher 进程注入该 slot 的 `XATS_AGY_IDENTITY_KEY`.  launcher 在启动 agy 前移除身份密钥, 将本次启动标识和原生 PID 传给子进程.

宿主的 MCP 入口核实当前启动进程和 slot 后, 向自己的桥进程注入同一个 key 并执行 `xats-agy-mcp`.  同一 slot 只配置一个提供业务工具的桥.  用户首次要求注册时, agy 调用桥提供的 `register_agent(name, team)`.  桥验证本次启动的归属, 再将用户明确指定的身份注册到 daemon.  成功后, 当前 TUI 即可自动收信, PID 和对话保持连续.  重复相同身份返回同一 agent ID.  若注册结果未知, 使用相同名称和团队重试.  已绑定的运行实例会拒绝改名或换队.  若仅桥进程重启, 新桥在下一次业务调用时可恢复此启动实例已经确认的身份.

启动器从 PATH 查找 `agy`.  `--` 后的参数传给 agy.  相同名称和团队用于恢复 xats 邮箱.  若要同时恢复指定的 agy 对话, 传入该对话的实际 UUID:

```sh
xats-agy --name reader --team demo -- --conversation "$conversation_id"
```

stdio 服务根据当前启动器的身份连接本机 daemon.  默认从 xats 的 `daemon.pid` 发现端口, 测试环境可显式设置 `CROSS_AGENT_TEAMS_MCP_URL` 为私有 daemon 的回环 `/mcp` 地址.  配置了鉴权的 daemon 使用环境中的 `CROSS_AGENT_TEAMS_MCP_TOKEN`.  使用稳定 slot key 的启动器应在重启时继续传入相同的 `XATS_AGY_IDENTITY_KEY`.

如果需要自动读信并回复, 在 agy 的权限设置里允许 `mcp(xats-agy/get_inbox)`, `mcp(xats-agy/send_message)` 和 `mcp(xats-agy/send_message_by_id)`.  括号内使用实际配置的 MCP 服务名.  启动器保留 agy 的工具审批行为.

另外一个 agent 向 `reader@demo` 发送需要回复的测试邮件后, 可用返回的消息 ID 查询 `get_delivery_status`.  `poked` 描述启动器是否提交了收信提示, `read` 描述邮箱游标是否已经越过这封邮件.

当前台有草稿、菜单、审批或屏幕状态无法确认时, `agy_busy` 表示邮件已经写入邮箱, daemon 将按重试时序再检查.  `agy_unavailable` 表示本次启动器无法接受通知.  普通 agy 或旧版 AoE stdio 桥可以继续使用原有邮箱和身份.  启动器只控制自己创建的 PTY.

## 原生 agentapi 通道 (`--agentapi`, 推荐)

除默认 PTY 模式外, `xats-agy` 支持 `--agentapi` 无 PTY 通道模式.  该模式直接 `fork/exec` 原生 `agy`, 不创建伪终端, 不解析终端屏幕, 也不向输入框粘贴提示词, 因此完全不受自定义 `statusLine`, 多行底栏或终端模式影响.  宿主运行 `xats-agy --capabilities-json` 返回 `{"defer_registration":1,"agentapi_channel":1}` 且 `PATH` 中存在 `xats-agy-channel-bind` 时可启用该模式.

```sh
# 延迟注册 (新建会话)
xats-agy --agentapi --defer-registration -- --settings '{"permissions":{"allow":["command(regex:^xats-agy-channel-bind$)"]}}'

# 命名会话或恢复会话
xats-agy --agentapi --name reader --team demo -- --conversation "$conversation_id" -i 'Run xats-agy-channel-bind once via run_command to bind xats wakeup channel, then reply OK.'
```

在 `--agentapi` 模式下:

- 启动器向子进程注入 `XATS_AGY_AGENTAPI=1` 和一次性内存令牌 `XATS_AGY_BIND_TOKEN`.  `xats-agy-mcp` 检测到 `XATS_AGY_AGENTAPI=1` 时, 会在 `register_agent` 的工具说明和成功返回体的 `next_step` 中提示模型立即执行一次 `xats-agy-channel-bind`.
- `xats-agy-channel-bind` 在 `agy` 的 `run_command` 环境中读取 Antigravity 官方注入的 `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`, `ANTIGRAVITY_CONVERSATION_ID` 与 `ANTIGRAVITY_AGENTAPI_EXE`, 通过本机 Unix socket 交给同会话 `xats-agy` 仅保存在进程内存中 (不落盘, 不写日志).
- 绑定完成后, xats 新邮件到来时, 启动器直接调用 `agy agentapi send-message --title=xats <conversation_id> <message>` 以原生 `<SYSTEM_MESSAGE>` 唤醒当前对话.  绑定前到达的唤醒返回 `agy_busy` (`awaiting_agentapi_bind`), 由 daemon 自动重试.
- 若用户在会话内手动执行 `/clear` 或 `/resume` 切换了 `conversation_id`, 宿主的 `SessionStart` hook 可调用 `xats-agy-channel-bind --update-conversation [<uuid>]` 同步更新内存中的目标对话 ID.  该命令在非 `--agentapi` 会话中静默退出并返回 `0`.

---

## PTY 屏幕模式 (兼容回退)

以下诊断与接管机制仅适用于未启用 `--agentapi` 的 PTY 模式:

收到 `agy_busy` 后, 可用本次启动的 `launch_id` 和已注册的名称、团队, 在另一个本机终端查询对应启动器:

```sh
xats-agy --diagnose "$launch_id" --name reader --team demo
```

`current` 是检查当时第一个阻止唤醒的条件, `ready` 表示检查通过.  `last_busy` 和 `busy_count` 分别记录此启动器最近一次拒绝唤醒的原因和累计次数.  进程重启后重新计数.  诊断只返回原因码、阶段和计数, 不发送通知或按键, 不读取邮箱.  旧启动器需要在下一次启动时加载此功能.

若解析器遇到未支持的持久终端模式, `reset_required_...` 会记录首次触发的屏幕 (main 或 alt)、指令类型及有限长度的数字参数.  该原因跨清屏和尺寸变化保留.  收到终端完整复位指令 (RIS) 后, 启动器从头验证新绘制的输入框.  旧版仅返回 `reset_required`, 无法用该值反推出历史指令.

原生界面靠近编辑框的提示有时与聊天历史中的文字相同.  例如 `Esc to cancel` 紧贴输入框时, 启动器会等该提示消失再尝试.  可通过 `get_delivery_status` 查看重试结果.

如果用户输入与通知粘贴同时发生, 启动器会先暂存按键, 等确认已撤回通知后再交给 agy.  若此时界面变化导致无法确认撤回, 可按 `Ctrl+]` 手动接管.  接管会丢弃暂存的按键并关闭本次启动的自动唤醒, 以免误提交草稿.
