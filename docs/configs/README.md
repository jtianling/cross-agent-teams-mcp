# Multi-agent Phase 2 walkthrough

Prerequisites:
1. Start the daemon: `npx cross-agent-teams-mcp daemon --port 9100`.
2. Confirm `curl http://127.0.0.1:9100/health` returns `{ "ok": true, ... }`.
3. Configure each agent per `opencode.md`, `claude-code.md`, `codex-cli.md` (MCP server name: `cross-agent-teams-mcp`).
4. Optional: if running inside tmux, bind runtime identity after `register_agent` to enable cross-agent interrupt targeting.

Manual scenario (broadcast replaces human relay):
1. In each of opencode, Claude Code, Codex CLI, call `register_agent` with a distinct `role`.
2. From opencode, call `broadcast({ body: "shared context X" })`.
3. In Claude Code and Codex CLI, call `get_inbox({ since_event_id: 0 })`; both receive X.

Record stdout transcripts per agent as evidence.

## Cross-agent poke scenario (Change `add-poke-mcp-tool`)

After both agents have registered with `tmux_pane_id`:

1. Agent A calls `poke({ target_agent_id: "<B>", prompt: "new events waiting, please check" })`
2. Daemon captures B's pane tail, injects the prompt via bracketed paste, sends Enter, captures again
3. A receives `{ ok, pane_id, pane_tail_before, pane_tail_after }` and inspects the diff to decide whether B acknowledged
4. If no visible change, A may call `poke` again (soft limit: 3 times per short window)
5. If still silent, fall back to `send_message` (mailbox persistence) or escalate to the human

## Auto-poke on send

Since `add-auto-poke-on-send`, `send_message` **defaults to auto-poke** for both single-recipient (`to_agent_id`) and role-fanout (`to_role`) cases.  The daemon runs a quiet-guard against the recipient's tmux pane before firing poke:

1. Capture the recipient's `tmux capture-pane` tail.
2. Wait `POKE_QUIET_MS` milliseconds (default `2000`, positive-integer env override).
3. Re-capture and compare; only fire poke when the two captures match (pane has been idle).

When the guard fails (pane is active), has no pane registered, tmux is unavailable, or the target is the caller itself, the message is **still persisted** to the mailbox and the skip is reported in the response.

Auto-poke injects **only a SHORT wake-up hint** into the recipient's pane, never the message body.  The hint format is fixed: `新邮件 from {display_name}@{sender_team} ({agent_id}) → {target_name}@{target_team}, 请调 get_inbox 查看`.  Both ends name their team because agent names repeat across teams.  When the sender has no `display_name`, the sender part falls back to `{agent_id[:8]}`.  Recipients always retrieve full bodies via `get_inbox`; no body byte ever reaches a pane through auto-poke.

`broadcast` is **opt-out**: it auto-pokes every eligible recipient by default (per-pane parallel quiet-guard).  Pass `auto_poke: false` to suppress the tmux side-effect and deliver pure mailbox.

### Fan-out online filter

Role-based routing (`send_message` with `to_role`) and `broadcast` skip agents whose `last_seen_at` is > 5 min old.  Offline recipients are excluded from both the mailbox fan-out and auto-poke; when every candidate is offline the call returns `{ error: 'unknown_recipient' }`.  Direct `to_agent_id` sends are **not** filtered — the single-recipient mailbox row is always written so Mailbox offline delivery picks it up on the recipient's next `get_inbox`.  The 5-min threshold is the same `ONLINE_MS` constant that `list_agents` uses for the `online` flag; offline ghosts therefore remain visible to `list_agents` for diagnosis.

Response fields:

- `poked: boolean` — `true` iff at least one recipient received a successful poke.
- `poke_skip_reasons?: Array<{ agent_id, reason }>` — entries for recipients that were not poked.  `reason` is one of `no_pane`, `guard_failed`, `tmux_unavailable`, `self`.  Absent when the caller passed `auto_poke: false`.
- `retry_scheduled: boolean` — `true` iff the daemon scheduled at least one background retry for a `guard_failed` recipient (see "Retry on guard_failed" below).
- `retry_delays_s?: number[]` — the backoff sequence used when `retry_scheduled` is `true`.  Fixed to `[30, 180, 600]` (seconds); absent when no retries were scheduled.

### Retry on guard_failed

When the initial quiet-guard reports `guard_failed` for a recipient that has a registered `tmux_pane_id`, the daemon schedules up to three background retries with fixed backoff: **30 seconds, 3 minutes, 10 minutes** (total window ≈ 13.5 min).  Each retry tick:

1. Looks up the recipient's current `tmux_pane_id` and `last_seen_at`.
2. Stops silently if the recipient no longer exists, has no pane id, or the recipient's `last_seen_at` is newer than the original message's `sent_at` (i.e. the recipient came online on their own).
3. Otherwise re-runs the quiet-guard; on pass, fires a poke with the same sender-identifying hint (see "Auto-poke on send" — the body is never injected) and stops remaining retries; on fail, schedules the next retry in the sequence.

Notes:

- Retry state lives in daemon memory only — no DB persistence.  Daemon restart drops pending retries (acceptable: the message is still in the mailbox).
- Only `guard_failed` triggers retries.  `no_pane`, `self`, and `tmux_unavailable` skip reasons are terminal and do **not** schedule retries.
- Successful retries are silent side effects: the sender's `send_message` / `broadcast` response has already returned, and no additional event or mailbox row is written on retry-poke success.
- On Fastify `app.close()` the daemon clears all pending retry timers.

Tuning the guard window:

```
POKE_QUIET_MS=500 node dist/cli.js daemon   # shorter window for fast-moving teams
POKE_QUIET_MS=4000 node dist/cli.js daemon  # longer window to reduce interrupts
```

Invalid / non-positive values are ignored and fall back to the 2000ms default.

### Relationship to the old send + poke idiom (obsolete)

Earlier docs recommended chaining `send_message` + `poke` manually.  That pattern is obsolete: single-recipient and role-fanout `send_message` now auto-poke by default, and the `poke` tool itself remains as an **explicit** escape hatch (no guard, always fires) for the rare case where you know the target is busy but want to interrupt anyway.  You typically only need explicit `poke` when:

- You hit a `guard_failed` in `poke_skip_reasons` but need to interrupt regardless.
- You are sending a `broadcast` with `auto_poke: false` but want to poke one specific recipient.

## Agent 身份幂等 (agent_id reuse by identity)

`register_agent` 按 `(team, name, role)` 三元组查重复用 `agent_id`:

- 同 `(team, name, role)` 再次调用 (同 session 或跨 session 重连) 会**复用**已有 `agent_id`, 并更新 `tmux_pane_id`/`model`/`last_seen_at`.  Pane 迁移后 poke 路由自动跟随.
- **`name` required**: 新 schema 中 `name` 字段必填, 空串/纯空白会被 zod 校验拒绝.  `role` 和 `team` 可省略, 默认均为 `"default"`.
- `tmux_pane_id` reuse 时: 提供非空值 → 覆盖; 省略 → 保留旧值.
- `role` 或 `team` 变更会产生新 `agent_id` (语义上是新身份, 不是 reuse).

**Legacy migration**: 本项目 MVP 阶段按 fresh-boot 假设, 不提供 schema 迁移脚本.  已有旧 `daemon.db` (含 `display_name` 列或缺 `name NOT NULL` 约束) 需手工删除后由 daemon 重建.

## Daemon keep-alive tuning

The daemon ships with two idle-tolerance knobs:

- `KEEP_ALIVE_TIMEOUT_MS` (default `120000`, 120s) — HTTP short-connection keep-alive window.  Applies to streamable-http POST clients like codex rmcp.
- `HEARTBEAT_INTERVAL_MS` (default `30000`, 30s) — application-level `notifications/heartbeat` emitted to every attached SSE sink.  Keeps long-lived subscription streams TCP-active through NAT / firewall idle timers.

To override (e.g. for ops tuning or for tests):

```
KEEP_ALIVE_TIMEOUT_MS=60000 HEARTBEAT_INTERVAL_MS=15000 node dist/cli.js daemon
```

**Honest limitation**: these mitigations widen the window but do NOT fully fix the codex rmcp idle-transport collapse ("error decoding response body").  The root cause is in codex's HTTP connection pool lacking retry-on-decode-error; it's outside this daemon's control.  If codex still crashes after `KEEP_ALIVE_TIMEOUT_MS` seconds of idle, restart codex and re-register.

## Daemon shutdown drain deadline

`SIGTERM` / `SIGINT` triggers a graceful drain bounded by a deadline:

- `XATS_SHUTDOWN_GRACE_MS` (default `5000`, 5s) — maximum time the daemon will wait for in-flight requests (including long-lived SSE / channel-proxy streams) to drain before force-closing remaining sockets via `server.closeAllConnections()` and exiting `0`.  Negative values clamp to `0`.  `0` skips the drain entirely (useful for restart scripts that hold a long-lived client and accept abrupt disconnect).
- A second `SIGTERM` / `SIGINT` received before the first drain completes skips the remaining wait, removes the pid file, and exits `0` within ~200 ms.  Useful when an operator gets impatient.

The pid file at `~/.cross-agent-teams-mcp/daemon.pid` is removed on every exit path (clean drain, deadline timeout, second-signal fast-exit).
