# cross-agent-teams-mcp

[English README](./README.md)

一个本地 MCP daemon, 让同一台机器上的多个 AI 编码 agent (Claude Code, Codex, opencode) 互相通信.  agent 注册到 daemon, 互发 1-to-1 消息, 在 team 或 role 内广播, 互相唤醒 — 全部通过一个本地 daemon 完成, 不依赖任何外部服务.

## 为什么不直接用 Claude Code 自带的 agent teams?

Claude Code 自己也有 agent teams 功能, cross-agent-teams 表面上和它有重叠, 但解决的是不同的问题.  三个具体的理由:

**跨 agent 支持.**  Claude Code 的 agent teams 是绑定在 Claude Code 自身的 — 每个成员都是 Claude Code 的 sub-agent.  cross-agent-teams 允许在同一个 team 里混用不同的 agent: Claude Code, Codex, opencode, Cursor 等都可以加入同一个 team, 通过同一个 daemon 协作.  按场景选最合适的 agent, 而不是被某一个 harness 锁死.

**更强的持久性与可控性.**  本项目的设计是每个 agent 进程都由你手动启动和停止.  这比"按需隐式拉起"麻烦, 但也更可控, 更持久 — agent 自己保留长期上下文, 记忆, 会话状态, 不会被编排器隐式重建.  一个专家 agent 可以挂着跑几小时甚至几天, 你一直跟同一个 session 对话.

**跨设备 / 跨用户协作.**  daemon 最近新增了跨物理机组 team 的能力 (见 [第 4 节](#4-跨主机--跨设备协作)).  也就是说你可以和跑在队友机器上的 agent 协作, 不同人手上可能有不同的专家 agent 或工作流 — 这是单进程内嵌的 teams 功能无法触达的边界.

## 快速开始

### 推荐: 让 code agent 替你完成配置

完整的设备配置 (zshrc 启动函数, daemon token, codex/opencode 配置) 已写成一份
agent 可读的操作手册: [README.agent.md](README.agent.md).  把下面这段粘贴给任何
能访问 URL、能执行 shell 命令的 code agent 即可:

```
读取 https://raw.githubusercontent.com/jtianling/cross-agent-teams-mcp/HEAD/README.agent.md
并按其内容在本设备上配置好 xats.
```

agent 会与你确认设备标签, `~/.zshrc` 改动, 以及是否也要在 Codex App 中启用
xats.  首次 `start-xats` 时自动生成 daemon token, 并配好
`free-xats-codex` / `xats-codex` / 可选的 `xats-codex-app` /
`free-xats-opencode` / `xats-opencode` 启动函数以及 `start-xats` /
`stop-xats`.  想手工操作的话, 继续往下看.

### Claude Code

```bash
# 1. 启动 daemon (跑一次, 保持运行)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. 在你的项目下安装 MCP 配置
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code

# 3. 带上 channel loader 启动 Claude Code (需要手动确认权限)
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

### 其它 agent (Codex, opencode, ...)

```bash
# 1. 启动 daemon (跑一次, 保持运行)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. 在你的项目下安装 MCP 配置 (交互式选择对应 agent)
npx mcpsmgr add jtianling/cross-agent-teams-mcp

# 3. 按平时的方式启动对应 coding agent
```

注意: Claude Code 默认就能 push 唤醒.  Codex 和 opencode 也都有真正的 push 唤醒, 各自做一次性 launcher 配置即可 (见下面 section 2) — Codex 走 `--remote` app-server 通道, opencode 走 HTTP `prompt_async` 通道.  cursor / 其它 custom agent 只有跑在 tmux pane 里才能被 poke.  某个 agent 没接通 push 唤醒时, 让它手动查 inbox 即可 (跟它说"查一下我的 xats inbox").

之后用平时跟 agent 对话的语言就能用了:

```
# Agent A 里:
Register me to xats as backend on team default.

# Agent B 里:
Register me to xats as frontend on team default.
Send backend a message: the API has changed.
```

就这些.  下面是细节 — daemon 参数, 手动 MCP 配置, codex `--remote` 设置, 更多使用方式.

## 1. 启动 daemon

在本机起一次, 让进程保持运行 (单独终端 / `tmux` / `screen` / `launchd` 都行):

```bash
npx -y cross-agent-teams-mcp@latest daemon --port 9100
```

daemon 默认监听 `127.0.0.1:9100`.  MCP endpoint: `http://127.0.0.1:9100/mcp`, 健康检查: `http://127.0.0.1:9100/health`.

常用参数:

- `--port <n>` (默认 `9100`)
- `--host <addr>` (默认 `127.0.0.1`)
- `--device <label>` (默认从 hostname 派生)
- `--token <t>` (Bearer 鉴权)
- `--db <path>` (默认 `~/.cross-agent-teams-mcp/data.db`)
- `--pid-file <path>` (默认 `~/.cross-agent-teams-mcp/daemon.pid`)

多主机 / 多设备 (LAN, tailscale 等) 场景请看下面的 [第 4 节](#4-跨主机--跨设备协作).

## 2. 在 agent 端配置 MCP client

### 推荐: `mcpsmgr` (快速开始里已经演示)

[`mcpsmgr`](https://www.npmjs.com/package/mcpsmgr) 读取本仓库的 `mcpsmgr.json`, 一次性把对应 agent 需要的 MCP 条目写进配置 — 包括 Claude Code 的 stdio channel proxy 条目, Codex 的 `experimental_use_rmcp_client` 开关和 streamable-http MCP 条目.

覆盖 daemon 端口:

```bash
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code --port 9300
```

### 手动配置

如果不想用 `mcpsmgr` (私有 fork / 自定义 token / 自定义 stdio args / 或者就是想手写), 各 agent 的原始配置如下.

#### Claude Code (两个条目都需要 — HTTP 用于工具, stdio 用于 channel 唤醒)

`.mcp.json` (或 `~/.claude.json`):

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "type": "http",
      "url": "http://127.0.0.1:9100/mcp"
    },
    "cross-agent-teams-channel": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "cross-agent-teams-mcp@latest",
        "cross-agent-teams-channel",
        "--daemon-url",
        "http://127.0.0.1:9100/mcp"
      ]
    }
  }
}
```

启动 Claude Code 时加上 channel loader, 让它订阅 channel proxy 推过来的唤醒通知:

```bash
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

`server:<name>` 后缀 **必须** 等于 `.mcp.json` 里的 MCP server key (上例中是 `cross-agent-teams-channel`).  如果 daemon 启动带了 `--token <t>`, 在 HTTP 条目里加 `"headers": { "Authorization": "Bearer <t>" }`, 并在 channel proxy args 里加 `--token <t>`.

#### Codex CLI

Codex 通过 Streamable HTTP 跟 daemon 通信.  唤醒走 Codex 自己的 app-server WebSocket, 不经 channel proxy.

##### 最小配置 (只能收邮箱, 没有 push 唤醒)

主要的 CLI runtime 使用标准的 `~/.codex/config.toml`.  由 xats 管理的
桌面 App 则使用隔离的 `~/.codex-app/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

`experimental_use_rmcp_client = true` 必须放在**顶级**, 缺这条 streamable-http MCP 加载不了.

daemon 带了 `--token <t>` 时: 在启动 codex 的 shell 里 `export XATS_TOKEN=<t>`, 然后在 `[mcp_servers.cross-agent-teams-mcp]` 块里加 `bearer_token_env_var = "XATS_TOKEN"`.  (Codex 0.130+ 会**静默忽略**老写法 `[mcp_servers.X.headers]` — 它真正认的 key 是 `http_headers` 和 `bearer_token_env_var`, 后者更推荐, token 不会落进可能被签入仓库的配置里.)

这种最小配置下 `send_message` 给这个 codex 会写邮箱, 但需要手动调 `get_inbox` 拉读, 没有跨会话 push 唤醒.

##### 让别人能唤醒你 (codex-appserver poke)

要让别的 agent 能**主动唤醒**这个 codex thread (而不只是发邮件), 需要 `codex-appserver` delivery.  这里有个不直观的坑要写清楚:

> **`codex --remote` 模式下, MCP server 是 app-server 加载的, 不是 TUI 加载的**.  当前版本的 codex (0.144.x 实测) 中, app-server 会**按每个 thread 的 cwd** 解析配置, 把受信任 (trusted) 项目的 `.codex/config.toml` layer 合并到自身 `CODEX_HOME` 之上.  主要的 CLI server 使用标准的 `~/.codex`, 由 xats 管理的 App server 使用隔离的 `~/.codex-app`.  记得传 `-C "$PWD"` 让 thread cwd 指向项目.  仅在 TUI 这边设 `CODEX_HOME` 在 `--remote` 模式下对 MCP 依然不起作用.

启动顺序:

```bash
# 1) 启动使用标准 ~/.codex 状态目录的常驻 CLI server
env -u CODEX_HOME codex app-server --listen ws://127.0.0.1:8799

# 2) 在另一个终端启动 codex TUI, 只连接 CLI server
codex --remote ws://127.0.0.1:8799
```

如果桌面 App 也需要 xats poke, 它必须使用 8800 上的第二个 server.  这个 server
要从当前 Codex 或 ChatGPT App bundle 启动, 并启用
`features.code_mode_host=true`; App 启动时设置
`CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8800`.  不要为 App runtime 回退到 PATH
中的 binary, 以保证 App 和 app-server 版本匹配.  但外部 app-server 模式当前
不能使用 ChatGPT in Chrome 插件.  daemon
使用 `CROSS_AGENT_TEAMS_CODEX_WS_URLS='["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]'`,
注册时会用传入的 `thread_id` 探测并持久化唯一匹配的 endpoint.  完整生命周期函数和
迁移步骤见 [README.agent.md](README.agent.md).  如果 Chrome 插件更重要, 只为 CLI
启用 xats, App 继续从 macOS 图标原生启动; 此时 App 本身不能被 xats poke 唤醒.

如果当前 app-server 的 `CODEX_HOME` 和 thread 所在受信任项目的 `.codex/config.toml` 里都没配 `cross-agent-teams-mcp`, `--remote` 进去的 codex agent 根本看不到 MCP 工具, `register_agent` 调都调不到.

##### 推荐: launcher 函数 (tmux pane 自动绑定)

为了让 daemon 把 wake-hint 直接 inject 到 codex thread (而不是只 paste 到 tmux pane), daemon 需要知道 codex 进程在哪个 tmux pane.  launcher 通过 `pre-register-codex-pane` CLI 在 exec codex 之前先把 pane 占住.  把下面的函数加到 `~/.zshrc`:

```zsh
free-xats-codex() {
    local xats_agent_id
    xats_agent_id="$(uuidgen)"

    if [[ -n "$TMUX_PANE" ]]; then
        npx -y cross-agent-teams-mcp pre-register-codex-pane \
            --pane "$TMUX_PANE" \
            --agent-id "$xats_agent_id" \
            >/dev/null 2>&1 \
            || echo "[xats] pre-register failed (continuing without pane claim)" >&2
    fi

    exec codex \
        --remote ws://127.0.0.1:8799 \
        -C "$PWD" \
        -c xats.agent_id="\"$xats_agent_id\"" "$@"
}
```

行为:

- tmux 内 (`$TMUX_PANE` 非空): 先发一条 pre-register (pane_id + UUID + 120s TTL) 给 daemon.  codex agent 之后调 `register_agent({agent_type: "codex", thread_id: $CODEX_THREAD_ID, ...})` 时, daemon 会用 pending pre-reg + 匹配 codex 进程 argv 自动绑 `tmux_pane_id`.
- `--remote ws://127.0.0.1:8799` 让 codex 连步骤 (1) 起好的 app-server.
- `-C "$PWD"` 设定 thread cwd, 同时也是 app-server 合并受信任项目 `.codex/config.toml` layer (项目级 xats 安装) 的依据 — 不需要 `CODEX_HOME`.
- `-c xats.agent_id="\"$uuid\""` 把 UUID 暴露在 codex argv 里, daemon 用它反向校验 pane.

详细配置 (auth header, 底层 `register_agent` 用法): [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

#### opencode

opencode 自带一流的 headless HTTP API (`POST /session/{id}/prompt_async`), daemon 用它作为专用唤醒通道 — 不需要 tmux pane 注入.  通过 `agent_type="opencode"` 加 `base_url` (指向 opencode 进程的 HTTP 服务器) 注册即可激活.

别的 agent poke 这个 opencode 时, daemon 把 wake hint POST 到 `prompt_async`, **拉起 opencode 一个新的 agent turn** — agent 自己醒来读 inbox, 不需要任何手动提示, 跟 Claude Code 和 Codex 一样是一等公民的 push 唤醒 (而不是 `custom` agent 回落的那种被动 tmux paste).

把下面的 `free-xats-opencode` zsh 函数加到 `~/.zshrc` (镜像 `free-xats-codex` 的模式):

```zsh
free-xats-opencode() {
    local port
    port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    OPENCODE_XATS_BASE_URL="http://127.0.0.1:${port}" exec opencode --port "${port}" --hostname 127.0.0.1 "$@"
}
```

然后用 `free-xats-opencode` 替代原本的 `opencode`:

```bash
free-xats-opencode                              # 默认 agent
free-xats-opencode --agent build --model glm-5.2   # 透传用户参数
```

launcher 做的事:

- 在 `127.0.0.1` 上分配一个空闲 TCP 端口 (支持多个 opencode 实例并发, 不冲突).
- 导出 `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>`, 让 agent 的 Bash 工具能读到, 并把它作为 `base_url` 传给 `register_agent`.
- `exec opencode --port <port> --hostname 127.0.0.1` 启动 TUI, 同时把 HTTP 服务器绑定到 loopback.

在 opencode TUI 里说:

> 注册到 xats, name: oc-1, team: default

agent 会自动检测 `$OPENCODE_XATS_BASE_URL`, 选 `agent_type="opencode"`, 把 env 值作为 `base_url` 传过去, 并省略 `session_id` (daemon 自动解析为 base_url 上 `time_updated` 最大的那个 session).  只有当 opencode 服务器以 `OPENCODE_SERVER_PASSWORD` 启动时才需要 `auth_token_ref`, 这种情况下也传 `auth_token_ref: "OPENCODE_SERVER_PASSWORD"`.

如果你直接用 `opencode` 启动 (没用 wrapper), env 变量缺失, agent 会回退到 `agent_type="custom"` 加 `agent_type_name="opencode"`, poke 通过 tmux pane 注入投递 (见下一节).

#### 其它编码 agent (cursor, ...)

非 Claude Code, 非 Codex, 也非通过 launcher 启动的 opencode — cursor, 编辑器扩展, 自己的 harness — 直接通过 Streamable HTTP 连 daemon, 注册时用 `agent_type="custom"` (agent 自己会判断).  这些 agent 没有专用的唤醒通道; 跨 agent poke 通过把文本注入到 agent 所在的 tmux pane 实现, 所以把 agent 跑在 tmux 窗口里, 注册时 daemon 会自动解析 `pid → tty → pane`.

各工具的具体配置片段在 [docs/configs/opencode.md](docs/configs/opencode.md) (其它在 `docs/configs/`).

## 3. 从 agent 里使用

agent 连上 daemon 后, 你不需要去记工具名字.  直接用平时跟 agent 对话的语言告诉它你想干嘛, agent 会自己挑工具 — 下面列的是 *你说的话*, 不是底层 API.

> 注意: 这些都要在 agent 会话内说.  不要用 `curl` 或其它外部 HTTP client 去手搓 MCP 协议注册或发消息 — 那会开一个不同的 MCP session, 更糟的是 `curl` 版 `register_agent` 会触发跨 session 的 **takeover**, 把你真正的 session 强制关掉.  如果你的 MCP client 传输已经挂了, 只是需要一个救生艇, 用下面这个 loopback-only 的 REST API — 它不碰你的 session.

**救生艇: loopback REST API.**  当 agent 的 MCP client 传输挂掉时, 它连一个 xats 工具都调不了 — 甚至没法说自己卡住了.  正是为了这种情况, daemon 在同一个端口上以 `/api/` 前缀暴露了一个极小的 **loopback-only** REST 接口.  它按 `(team, name)` 解析 agent, 复用和 MCP 工具完全相同的 send / inbox / list-agents 逻辑, 并且**对 session 零副作用** (不 takeover, 哪怕你的 MCP session 还活着也安全).  远程调用一律 `403`; 如果 daemon 带 `--token` 启动, 像 `/mcp` 一样带上 token (`Authorization: Bearer <token>` 或 `?token=<token>`).

```bash
# 以一个已注册的 agent 身份发消息
curl -s http://127.0.0.1:<port>/api/send \
  -H 'content-type: application/json' \
  -d '{"from":{"team":"default","name":"alice"},
       "to":{"team":"default","name":"bob"},
       "body":"我的 MCP client 卡死了 — 正在重启"}'

# 读收件箱 — 省略 since_event_id 会推进你的已读游标,
# 传了则是只读查看, 不推进游标
curl -s 'http://127.0.0.1:<port>/api/inbox?team=default&name=alice'

# 列出某个 team 的 agent
curl -s 'http://127.0.0.1:<port>/api/agents?team=default'

# 删掉一行过期的注册记录 (agent_id 从上面的列表里取)
curl -s -X DELETE http://127.0.0.1:<port>/api/agents/<agent_id>
```

REST 上刻意没有 `register_agent` — 创建或重新绑定身份正是这个接口要规避的 takeover 陷阱, 所以 agent 必须先 (通过 MCP) 注册过一次, 才能用这个救生艇.

**删除注册行.**  `DELETE /api/agents/<agent_id>` 只删这一行, 成功返回 `{"deleted":true,"agent_id":...,"team":...,"name":...}`; id 匹配不到任何行时返回 `404 {"error":"unknown_agent"}`, 所以重复删除会明确告诉你"本来就没了".  它按 `agent_id` 而不是 `(team, name)` 寻址是刻意的 —— 带着 daemon 已经不再使用的 device 标签的那些行, 正是最值得清理的, 而绑定到本机 device 的 `(team, name)` 查找根本够不着它们.  也刻意不看存活状态: 对于注册时既没有 pid 也没有 tmux pane 的 runtime, `online` 会退化成一个以天计的 `last_seen_at` 窗口, 拿它当门槛只会把最该删的行挡在外面.

这是**注册表**操作, 不是停止 agent 的手段.  它不杀任何东西: 不杀进程, 不杀 pane, 不杀 session.  一个正在运行的 agent 被删掉行之后, 它的下一次 xats 调用会以未注册 session 被拒, 需要重新 `register_agent`.  agent 删自己用 `unregister_self` 工具; 删**别的** agent 刻意没有提供 MCP 工具.

> 安全提示: "loopback-only" 也包含同机的浏览器, 所以给 daemon 带上 `--token` 才能挡住本机网页访问 `/api/`.  不带 token 时, 恶意本机网页最多能通过跨站 `GET /api/inbox` 推进某个 agent 的收件箱游标 — 它读不到任何响应 (CORS), 发不了消息, 也冒充不了别人; 唯一后果是那个 agent 可能漏掉未读消息.  这是一个有界的、经过权衡后接受的风险; 带 token 就能彻底消除.

### 注册当前会话

agent 第一次连上 xats 时不会自动注册, 要等你开口.  直接说:

> Register me to xats as alice.

或者指定 team:

> Register me to xats as alice on team backend.

不传 team 的话, agent 会用当前工作目录的 basename 作为默认 team — 一般情况下你不用操心.

### 跟其它 agent 对话

按名字, 按 team, 按 role 都行:

> Send a message to bob: how is the migration going?
>
> Tell my team I'm starting the deploy.
>
> Send the frontend role a heads-up that the API will change.
>
> What's in my inbox?

agent 会自动挑对应工具 (`send_message`, `broadcast`, `broadcast_to_role`, `get_inbox`).  发消息的同时会自动唤醒收件人, 不用单独再 poke.

### 看看还有谁在线

> Who else is registered on xats?
>
> List agents on team backend.

## 4. 跨主机 / 跨设备协作

大部分用户只用单机就够了, loopback 场景下 `device` 这个轴是透明的, 本节可以完全跳过.  只有当你想让多台物理机器 (LAN, tailscale 等) 共享一个 daemon 时, 才需要往下看.

跨设备需要三处配套修改 — **daemon bind**, **远端 `.mcp.json`**, **agent 注册**.  agent 身份按 `(device, team, name)` 命名空间区分: 裸的 `send_message({to_agent_name:"creator"})` 解析到调用者自己的 device, 用 `creator:host-b` 可以指到另一个 device 上同 team 的 agent.

### 1. Daemon 侧: bind 到非 loopback

停掉旧 daemon, 用非 loopback `--host` 和 `--token` 重启.  `--host` 非 loopback 时 `--token` **必填**, 否则 daemon 拒绝启动 (`token_required_for_non_loopback_bind`).  `--device` 可选, 不传则从 daemon 主机的 hostname 派生 (小写 + 非 `[a-z0-9_-]` 替换为 `-`):

```bash
npx -y cross-agent-teams-mcp@latest daemon \
  --host 0.0.0.0 \
  --port 9100 \
  --token "$XATS_TOKEN" \
  --device host-a
```

想限定监听接口, 把 `0.0.0.0` 换成具体 LAN IP (例如 `10.0.0.10`) 或者 tailscale CGNAT IP (`100.x.x.x`) 都行.  macOS 第一次绑非 loopback 端口会弹"允许 node 接受网络连接", 选允许.

### 2. 远端机器侧: 改 `.mcp.json`

每台远端同事的 Claude Code 相对默认 loopback 配置都要改两处 — HTTP 入口加 `Authorization: Bearer …` 头, channel proxy 加 `--token` 和 `--device`.

> **`--device` 对跨主机场景是关键配置.**  daemon 端会拒掉任何不带 device 的远程 `register_agent` (返回 `device_required_from_remote`), 因此 channel proxy 缺 `--device` 时会陷入 register/fail/respawn 死循环, 永远叫不醒目标 agent — auto-poke 会静默退化成 `no_pane`.  v0.5.18 起 proxy 在 daemon 非 loopback 且未传 `--device` 时会用 `os.hostname()` 自动派生一个 label 并 stderr 打 notice, 但派生值仍可能与 daemon 本机标签撞 (触发 `device_spoofing_local_label_from_remote`), 跨主机部署务必为每台机器在配置里显式钉死 `--device`:

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "type": "http",
      "url": "http://10.0.0.10:9100/mcp",
      "headers": {
        "Authorization": "Bearer xats"
      }
    },
    "cross-agent-teams-channel": {
      "command": "npx",
      "args": [
        "-y", "-p", "cross-agent-teams-mcp@latest",
        "cross-agent-teams-channel",
        "--daemon-url", "http://10.0.0.10:9100/mcp",
        "--token", "xats",
        "--device", "host-b"
      ]
    }
  }
}
```

如果远端用的是主要 Codex CLI, 改 `~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams-mcp]
url = "http://10.0.0.10:9100/mcp"
bearer_token_env_var = "XATS_TOKEN"
```

启动前 `export XATS_TOKEN=xats`.

**daemon 所在机器** (host-a 这台) 的 `.mcp.json` 同样需要加 `headers.Authorization` — daemon 一旦设了 `--token`, 所有 `/mcp` 请求 (包括 loopback) 都要带 token, 没例外.

### 3. Agent 注册

重启远端的 Claude Code (或 codex), channel proxy 用新的 `--device` 启动后, startup hint 会把 device 直接嵌进引导文案, 用户回复时一并带上即可:

> Register me to xats as alice, device host-b.

如果远端 `register_agent` 不传 device, daemon 回 `device_required_from_remote` 直接拒.  device 进入身份键 `(device, team, name)`, 所以两台机器都可以有 `team=default` 下的 `creator`, 不会撞名.

### 4. 跨设备寻址

注册完成后, 用 `name:device` 后缀寻址同 team 不同 device 的 agent:

> Send creator on host-a a message: build is green.

这条解析成 `creator:host-a`, 路由到 `(device=host-a, team=…, name=creator)` 这一行.  裸名字 `creator` 始终解析到 caller 自己 device.

要点:

- `list_agents` 每条返回都有 `device` 字段, 用它看清 team 里哪些 device 在贡献 agent, 再拼对的 `name:device`.
- `get_inbox` 每条消息都带 `from_name` 和 `from_device`.  回复时如果 `from_device !== 自己 device`, 用 `from_name:from_device`; 同 device 用裸名即可.  `send_message_by_id({to_agent_id: from_agent_id, ...})` 是 device 无关的安全兜底.
- 安全提醒: bearer token 在能连到 daemon 的所有人之间共享, 把 LAN 暴露当作可信团队边界处理 — 本模式没有 per-agent 鉴权, 没有 device 白名单, 也没有 TLS.
- 升级说明: 引入 `device` 轴之后首次启动会自动迁移存储 schema, 把身份从 `(team, name)` 改为 `(device, team, name)`, 并用 daemon 本机的 `--device` 标签回填旧数据.  如果已经注册了多个 device 上相同 `(team, name)` 的 agent 再回滚, 可能违反旧版本的唯一性假设.

### 5. 跨设备场景下 Codex 特有的坑

`--token` + Codex `--remote` 模式下会暴露三个本地单设备 setup 看不到的问题:

- **app-server 的 env 在启动时固化**.  `codex app-server --listen ...` 继承启动它那个 shell 的环境.  你在另一个 shell `export XATS_TOKEN=…` 之后, 已经在跑的 app-server 看不到 —— codex MCP 握手时报 `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` (codex 把 daemon 返回的 401 body 当 JSON-RPC 帧解析失败).  解决: 在已经 `export` 好 `XATS_TOKEN` 的 shell 里重启 app-server.

- **`--remote` 会劫持工作目录**.  `codex --remote …` 下 session 的 cwd 是 **app-server 进程的 cwd**, 不是 TUI 的, 所以 launcher 无论在哪个目录跑都会落回 app-server 启动时的目录.  在 `codex` 命令上加 `-C "$PWD"` 覆盖 (上面 launcher 已经带了).

- **项目级 `.codex/config.toml` 会覆盖全局**.  陈旧的 per-project 配置块 —— 尤其在 iCloud / Dropbox 之类跨机同步的目录里 —— 会盖掉你的全局鉴权设置, 报错形如某个 `codex mcp list` (只反映全局) 里看不到的 server 名启动失败.  审计: `find ~ -path '*/.codex/config.toml' -print`, 删掉或更新陈旧条目.

## 更多

- 完整工具列表和参数: 启动 daemon 后调 MCP endpoint 的 `tools/list`.
- 各 agent 详细配置: `docs/configs/`.
- 源码: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).
