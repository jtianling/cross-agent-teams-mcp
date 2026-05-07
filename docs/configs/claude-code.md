# Claude Code MCP config for cross-agent-teams-mcp

Run once to register the MCP server:

```bash
claude mcp add --scope user cross-agent-teams-mcp http://127.0.0.1:9100/mcp --transport http
```

Or edit `~/.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "cross-agent-teams-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:9100/mcp"
    }
  }
}
```

With `--token`:

```json
{
  "mcpServers": {
    "cross-agent-teams-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Tmux delivery notes

`register_agent` now best-effort attempts runtime binding after the identity row is created, so tmux-based poke delivery can often come up without a second tool call.  Callers SHOULD NOT pass `tmux_pane_id` to `register_agent`.

## Claude self-registration

Claude Code 推荐在当前会话里调用 `register_agent({ agent_type: "claude-code", ... })`.  这会把注册写到 Claude host 当前正在使用的 MCP session 上.  这样后续 `get_inbox`, `send_message`, `poke` 都会立刻沿用同一个身份, 不会出现 "刚注册完, 下一次又 unknown_agent" 的错位.

当用户没有显式指定 `team` 时, 推荐传 `project_dir` 为当前工作目录.  daemon 会用该目录 basename 派生默认 team, 两者都不传时仍回落到 `"default"`.

如果你是在 Claude Code 里替别的 runtime 注册, 让 `agent_type` 匹配 `ui_pid` 背后的真实进程类型.  例如, `ui_pid` 指向某个外部编辑器进程时, 传 `agent_type: "custom"` + `agent_type_name: "<editor>"`, 不是 `"claude-code"`.

### Channel auto-bind (推荐)

只要在 Claude Code 里加载了 `cross-agent-teams-channel` proxy, **只需要传 `ui_pid` (就是 `$PPID`), 不需要显式传 `channel_session_id`**.  daemon 会根据 `ui_pid` 匹配 proxy 进程 (它的 `process.ppid` 与 host 的 `ui_pid` 相同), 自动把 host 的 `delivery.kind` 绑到 `claude-channel` + proxy 当前的 csid.  这省掉了 LLM 手动读 `notifications/claude/channel` 启动提示的一步.

```text
register_agent({
  agent_type: "claude-code",
  name: "lead",
  role: "worker",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  ui_pid: 25424  // $PPID, 也即 Claude Code CLI 的进程 id
})
```

成功时响应里会带 `channel_session_id: "csid-..."` 字段.  如果当前没有匹配的 proxy row (例如 plugin 没加载), 该字段缺席, delivery 保持 `'none'`, 注册本身仍然成功, 还能走 tmux fallback.

`model` 对 `agent_type="claude-code"` 是可选的.  省略时会回退到根据 MCP session client info 嗅探的 Claude 专用默认值.

### 显式传 channel_session_id (向后兼容)

如果你仍然想显式指定 csid (例如从 proxy 启动提示里读出来了), 也可以继续传.  当 `ui_pid` 与 `channel_session_id` 同时给出时, daemon 会做一致性校验, 如果 proxy 持久化的 csid 与传入的 `channel_session_id` 不一致, 注册会被拒绝并返回 `channel_session_id_ui_pid_mismatch`:

```text
register_agent({
  agent_type: "claude-code",
  name: "lead",
  ui_pid: 25424,
  channel_session_id: "csid-abc"
})
```

## Session boundary

- `cross-agent-teams-channel` proxy 自己也会连接 daemon, 但它注册的是单独的 `__channel_proxy__` session, 不是你的 owner Claude session.
- `curl` 或别的外部 HTTP client 会创建新的 MCP session.  它们可以注册 daemon 里的 row, 但不会把 Claude 当前工具会话自动变成已注册.
- 如果你的目标是让当前 Claude 会话立刻能继续调 `get_inbox` 等工具, 不要用外部 `curl` 去做 Claude 注册.  请直接在 Claude 当前会话里调用 `register_agent({ agent_type: "claude-code", ... })`.
- `bind_channel(...)` 现在主要用于已注册 Claude host 在 proxy 换了新 `channel_session_id` 之后做低层重绑.

如果注册响应里仍然带 `hint`, 说明自动 runtime binding 还没有收敛, 当前还没有可用的 `tmux_pane_id` 作为 tmux fallback.  这时调用 `bind_runtime_identity(...)`.  `detect_tmux_pane(...)` 只建议用于调试.
