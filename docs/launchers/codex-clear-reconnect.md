# Codex clear 后恢复 xats 身份

`/clear` 会新建线程, 单独使用新 `CODEX_THREAD_ID` 无法反查旧线程的 xats 身份.
Claude 的 clear 恢复仍使用原 UI pid, 两者的恢复入口不同.

## 启动与调用

Codex launcher 将同一个启动 UUID 写入实际 argv 的 `xats.agent_id` 和会话级配置:

```text
shell_environment_policy.set.XATS_CODEX_LAUNCH_ID="<launch UUID>"
```

clear 后, agent 从 shell 工具读取 `XATS_CODEX_LAUNCH_ID` 与
`CODEX_THREAD_ID`, 调用:

```text
reconnect({launch_id: <launch UUID>, thread_id: <current thread UUID>})
```

该环境值仅用于 shell 工具, 不依赖 hooks.  不将长期 identity key 放入启动参数,
不读取共享 app-server 环境中的 `XATS_IDENTITY_KEY`.

## 恢复保证

- 仅接受本机连接和唯一的已完成 launch 绑定, 复核前台 carrier, pane, pid 与 tty.
- 从已登记 endpoint 读取目标线程元数据, 拒绝 fork, 子代理及元数据不完整的线程.
- 保留原名字, team, `agent_id`, 收件游标和 pane.  其它身份已占用的目标线程被拒绝.
- 在同一事务中更新 agent delivery 与 launch binding 快照.  写入失败整体回滚.
- 异步验证后复核注册代际, 在连接接管前再次同步复核, 旧请求不能关闭更新后的连接.

现有按 `thread_id` 的 reconnect 保持兼容.  未升级 launcher 的旧进程没有该会话级
环境值, 不能凭空恢复 launch.  初始注册仍需完成原有 pane challenge, 本路径不把
历史猜测绑定升级成可信绑定.  仅知道 launch 标识也不代表正在选中的 UI 线程,
调用方必须传自己 shell 中的当前线程 ID.

## 2026-09-14 验证记录

- xats 定向测试覆盖恢复, schema, Claude 与 identity-key 回归, binding 生命周期.
- 实际 Codex TUI v0.153.3 在隔离 HOME, CODEX_HOME 和 app-server 下执行 `/clear`.
  确认线程 ID 改变, 新线程 shell 仍读取同一 launch UUID.
- 同一真实新线程通过 `thread/read` 验证并恢复隔离数据库中的原身份,
  agent delivery 与 binding 快照同步更新.  pane 探针使用模拟值, 未声称真实 tmux
  绑定 E2E 已完成.
- 两个隔离线程分别读到各自的 launch UUID.  全程不调用模型, 不操作在线 tmux.
- AoE 通过 `cargo check --tests --offline`, `cargo clippy --tests --offline -- -D warnings`
  和格式检查.  未运行会接触 tmux 的 Rust 测试套件.
- 独立代码审查发现并修复提交后连接接管的并发窗口, 复审通过.

本机复现脚本位于忽略目录 `.e2e-test/codex-clear-tui-probe.mjs` 与
`.e2e-test/reconnect-real-thread.mts`.  测试创建的 app-server, PTY 子进程及临时
目录在结束时清理.  在线 daemon 和 AoE 未重启或替换, 启用需加载新版 daemon
及 launcher, 已运行的旧 pane 不自动获得新增配置.
