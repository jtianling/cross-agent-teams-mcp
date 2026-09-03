# free-xats-codex 启动器

`free-xats-codex` 是一个 zsh 函数, 用来在 tmux 会话里启动
`codex --remote`, 并提前向 cross-agent-teams-mcp (xats) 后台宣告
"我即将在 pane X 启动 agent UUID Y".  CLI 固定连接 8799 上的独立
app-server, 该 server 使用 `CODEX_HOME=~/.codex-cli`.  用户选择 App xats
时, 桌面 App 使用默认 `~/.codex` 和 8800, 两者不会共享 session.  后续 codex
agent 调用 `register_agent` 时, daemon 可以自动选择持有其 `thread_id` 的
endpoint 并绑定 tmux 身份.

## 前置条件

- 已安装 `cross-agent-teams-mcp` (`pnpm -C <repo> build && npm link` 之类)
- daemon 已经在运行 (`cross-agent-teams-mcp daemon ...`)
- CLI app-server 已用 `CODEX_HOME=~/.codex-cli` 监听
  `ws://127.0.0.1:8799`
- 正在 tmux 会话中 (`$TMUX_PANE` 非空)

## 推荐的 zsh 函数

把下面的函数贴到 `~/.zshrc` 里 (本仓库**不会**自动改你的 zshrc, 需要自己 opt-in).  启动器做三件事:

1. 如果之前 alias 过同名命令, 用 `unalias` 保护
2. 生成一个 per-launch UUID
3. 在 tmux 环境下调用 `pre-register-codex-pane`, 然后 `exec codex ...`

```zsh
free-xats-codex() {
  unalias free-xats-codex 2>/dev/null

  local uuid
  uuid=$(uuidgen)

  if [[ -n "$TMUX_PANE" ]]; then
    cross-agent-teams-mcp pre-register-codex-pane \
      --pane "$TMUX_PANE" \
      --agent-id "$uuid" \
      >/dev/null 2>&1 \
      || echo "[xats] pre-register failed (continuing without pane claim)" >&2
  else
    echo "[xats] pre-register skipped: not in tmux" >&2
  fi

  exec codex --remote ws://127.0.0.1:8799 \
    -C "$PWD" \
    -c xats.agent_id="\"$uuid\""
}
```

> `-c xats.agent_id="\"$uuid\""` 里外层双引号是 zsh 的, 内层 `\"` 最终让 codex 在 argv 里看到字面量 `xats.agent_id="<uuid>"` — daemon 的 auto-bind 正是按这个字面量来匹配 pane 的.

## 行为说明

- **tmux 内启动**: 先发一条 pre-register 给 daemon (pane_id + UUID + 120s TTL), 再 `exec codex`.  codex agent 跑起来之后调用 `register_agent({client:"codex", ...})` 时, daemon 会用 pending pre-reg 自动解析 UI pid 并绑定 `tmux_pane_id`.
- **非 tmux 启动 (SSH 纯终端 / CI 等)**: 打印 `[xats] pre-register skipped: not in tmux`, 然后 `exec codex`.  CLI 仍连接常驻的 8799 runtime, 不会看到 App 的 8800 session; 只是没有自动绑定 pane.
- **pre-register 调用失败 (daemon 没跑起来等)**: 打印一行错误到 stderr, 但不阻塞 `exec codex`.  同样退回到现有 no-pane 路径.
- **TTL 过期 / pane 里没有预期的 UUID**: daemon 端会跳过这条 pre-reg, 也不会误绑到其它 pane, 最坏情况是回退到 no-pane hint.

## 为什么不自动改 `~/.zshrc`

以上函数是**推荐写法**, 不是强制.  `~/.zshrc` 是用户个人配置, 本仓库默认不会动它.  你可以自由调整 `ws_url` / `codex` 参数 / 是否 `exec`.  但请保留三个关键点:

1. 在 tmux 内调用 `cross-agent-teams-mcp pre-register-codex-pane --pane "$TMUX_PANE" --agent-id "$uuid"` (忽略失败)
2. 启动 codex 时带上 `-c xats.agent_id="\"$uuid\""`, 这样 daemon 才能用 argv UUID 反向校验 pane
3. `-C "$PWD"` 必须保留 — `codex --remote` 默认会用 app-server 的 cwd, 不是 TUI 的; 不带 `-C "$PWD"` 的话, 无论你在哪个目录跑 launcher, codex session 都会落到 app-server 启动时的那个目录

完整的可选双 runtime `start-xats`, `stop-xats` 和 `xats-codex-app` 函数见
[README.agent.md](../../README.agent.md).  只有用户明确选择在 App 中启用 xats
时, daemon 才应收到:

```zsh
export CROSS_AGENT_TEAMS_CODEX_WS_URLS='["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]'
```

App runtime 必须使用当前 `/Applications/Codex.app` 或
`/Applications/ChatGPT.app` 中的 `Contents/Resources/codex`, 并启用
`features.code_mode_host=true`.  禁止回退到 PATH binary, 否则版本或签名身份不匹配
可能导致 App peer 被拒绝.  即使使用匹配的 bundle binary, 外部 app-server 模式
当前仍不能使用 ChatGPT in Chrome 插件.  如果用户需要 Chrome 插件, 只启用 CLI
xats, App 从 macOS 图标原生启动, 并接受 App 不接收 xats poke.

## Caveats (常见坑)

- **app-server 的 env 在启动那一刻固化**.  `codex app-server --listen ...` 继承启动它那个 shell 的环境变量; 之后即便在 zshrc 加了 `export CROSS_AGENT_TEAMS_MCP_TOKEN=…` (或全局 `~/.codex/config.toml` 里配了 `bearer_token_env_var = "..."` 的那个变量名), 已经在跑的 app-server 看不到, codex MCP 握手会报 `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` (实际上是 daemon 返 401, codex 把 body 当 JSON-RPC 帧解析失败).  解决: 杀掉旧 app-server, 在已经 export 过对应 env 的 shell 里重启它.
- **CLI 登录必须单独完成**.  先创建 `~/.codex-cli`, 再用
  `CODEX_HOME="$HOME/.codex-cli" codex login`.  不要从 `~/.codex` 复制
  `auth.json` 或 session 目录; App 默认 home 保持不变.
- **project-level `.codex/config.toml` 会盖全局**.  陈旧的 per-project MCP 配置块 (尤其在 iCloud / Dropbox 之类跨机同步目录里) 会盖掉全局 `~/.codex/config.toml` 的鉴权设置, 报错形如 `codex mcp list` 里**看不到的** server 名启动失败.  审计办法: `find ~ -path '*/.codex/config.toml' -print`, 一份份检查, 删掉或对齐.
- **不要再用 `[mcp_servers.X.headers]`**.  Codex 0.130+ 不认这个 key 名 (会静默忽略), 实际生效的是 `http_headers` 和 `bearer_token_env_var` — 推荐后者, token 不会落进可能被签入仓库的配置里.

## 调试

- 查看 pending 的 pre-reg: `sqlite3 ~/.cross-agent-teams-mcp/data.db 'SELECT * FROM codex_pane_pre_registrations;'`
- 手动调用 CLI (需要 daemon 在跑): `cross-agent-teams-mcp pre-register-codex-pane --pane "$TMUX_PANE" --agent-id "$(uuidgen)"`
- 查看 codex 进程 argv: `ps -o pid=,command= | grep codex`
