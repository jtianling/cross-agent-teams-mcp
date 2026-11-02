# 本机 pane 身份只读查询 v1

`POST /api/runtime/pane/lookup` 是可选只读接口.  它不依赖 AoE 或 managed token, 不改变独立注册流程, 不更新绑定、owner、last_seen_at 或消息状态.  不 capture 屏幕、不发送按键、不触发恢复、不访问运行时远端.  

接口沿用 daemon 鉴权, 仅接受 loopback 请求.  调用方从明确 tmux server 的 inventory 获取以下坐标, 不得用 title、cwd 或裸 pane 编号推断身份.  

```json
{
  "protocol_version": 1,
  "tmux": {
    "socket_path": "/absolute/path/tmux.sock",
    "server_pid": 1234,
    "server_started_at": 1793000000,
    "pane_id": "%1"
  }
}
```

socket_path 必须为无控制字符的绝对路径.  server_pid 和 server_started_at 为正安全整数, 后者对应 tmux `#{start_time}` 的 Unix 秒数.  对应格式还包括 `#{socket_path}`、`#{pid}`、`#{pane_id}`、`#{pane_pid}` 和 `#{pane_tty}`.  对象拒绝未知字段.  

成功响应 HTTP 200, 以下字段均固定存在:

```json
{
  "ok": true,
  "protocol_version": 1,
  "tmux": {
    "socket_path": "/absolute/path/tmux.sock",
    "server_pid": 1234,
    "server_started_at": 1793000000,
    "pane_id": "%1"
  },
  "checked_at": "2026-10-27T01:00:00.000Z",
  "identity": {
    "status": "verified",
    "agent": {
      "agent_id": "<登记 UUID>",
      "device": "<本机 device>",
      "name": "worker",
      "team": "project",
      "agent_type": "codex"
    },
    "reason": "pid_tty_generation_match"
  },
  "runtime": {
    "status": "unknown",
    "reason": "delivery_not_probed"
  }
}
```

tmux 原样回显请求坐标, checked_at 是 RFC3339 查询完成时间.  agent 仅在 verified 时非 null, 仅返回示例中的五个字段.  不返回 token、identity_key、环境变量、完整 argv 或聊天内容.  

identity.status 为 verified、unbound、unverifiable、ambiguous、stale.  runtime.status 为 ready、not_ready、unknown.  身份未核实一律返回 runtime unknown.  reason 是机器可读原因, 客户端应允许未知 reason 并按 status 展示.  

验证过程显式使用 `tmux -S <socket>` 查询元数据, 清除子进程的 TMUX/TMUX_PANE, 不连接默认 server.  socket 必须是本用户的 Unix socket; 前后核对实际路径、文件身份及 server PID/启动代次.  既有登记必须有 verified_pid_tty_pane 模式、明确 UI PID/TTY/绑定时间, 且当前进程为同一 pane 的前台 carrier.  用 ps 的进程启动时间排除 PID 复用; 因 ps 精度为秒, 启动时间区间与绑定时间重叠时保守返回 unverifiable.  最后复核进程及登记快照, 不把探测期间变化的数据当作稳定绑定.  

当前可验证范围:

- Codex CLI: 上述 PID/TTY/时间证据满足时支持.  有 codex_pane_bindings 行时还必须匹配 agent、thread、UI PID、TTY 和 live launch argv.  没有该行时仅接受明确的原生 Codex remote carrier.
- Claude Code、OpenCode: 具备上述绑定证据且原生 carrier 命令可核实时支持.  只有 tty 绑定、未识别的 wrapper 或历史信息不足时不猜测.
- custom、HTTP-only Kimi 和未保存 pane 绑定的 managed 实例不推断身份.  unbound 只表示没有此 pane 的登记绑定, 不代表进程一定未注册到 xats.

身份 verified 不等于运行时 ready.  无投递通道返回 not_ready.  Claude 的当前 channel 订阅 owner 与对应 proxy/UI PID 一致时可返回 ready.  Codex/OpenCode 没有远端通信实测, 返回 unknown, 不能使用 loaded/list 或进程存活替代就绪证据.  

查询是对多份系统状态的保守快照, 不是进程锁或未来状态保证.  调用方必须结合 checked_at 展示时效, 不得据此执行所有权转移.  

错误格式:

```json
{"ok":false,"error":"probe_failed","detail":"tmux_query_failed"}
```

invalid_request 返回 400, remote_forbidden 返回 403, probe_failed 返回 503, internal_error 返回 500.  请求正文解析错误也使用该格式.  daemon 全局鉴权的 401 沿用原接口行为.  socket 不可访问或 ps/tmux 执行失败不是 unbound; server 代次改变或 pane 消失则返回 HTTP 200 和 identity stale.  底层具体错误记录在 daemon 日志, 响应 detail 不包含探针原始输出.  

部署缺少接口或 daemon 离线时, 总览应显示 unavailable 并继续展示其它数据.  接入方不得回退到隐式注册或生产默认 socket.  
