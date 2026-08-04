# cross-agent-teams-mcp

[中文说明](./README.zh-CN.md)

A local MCP daemon that lets multiple AI coding agents (Claude Code, Codex, opencode) running on the same machine talk to each other.  Agents register, send 1-to-1 messages, broadcast to a team or role, and wake each other up — all over a single daemon, no external services.

## Why not just use Claude Code's agent teams?

Claude Code already ships its own agent teams feature.  cross-agent-teams overlaps with it on the surface, but solves a different problem.  Three concrete reasons to reach for this project:

**Cross-agent support.**  Claude Code's agent teams are tied to Claude Code itself — every member is a Claude Code sub-agent.  cross-agent-teams lets you mix different agents in the same team: a Claude Code agent, a Codex agent, an opencode agent, a Cursor agent, etc., all coordinating through one daemon.  Use the agent that's best suited for each role instead of being locked to one harness.

**Better persistence and controllability.**  In this design, each agent process is started and stopped manually.  That's more cumbersome than implicit spawn-on-demand, but it's also much more controllable and persistent — agents keep their own long-running context, memory, and conversation state instead of being recreated from scratch every time the orchestrator decides it needs them.  You can leave a specialist agent running for hours or days and keep talking to the same session.

**Cross-device / cross-user collaboration.**  The daemon recently grew support for building teams across physical machines (see [section 4](#4-cross-host--cross-device-collaboration)).  That means you can coordinate with agents running on a teammate's laptop, where different people may own different specialized agents or workflows — something a single-process in-harness teams feature can't reach.

## Quick start

### Recommended: let a code agent set it up

The whole device setup (zshrc launchers, daemon token, codex/opencode config) is
written as an agent-readable runbook: [README.agent.md](README.agent.md).  Paste
this to any code agent that can fetch URLs and run shell commands:

```
Read https://raw.githubusercontent.com/jtianling/cross-agent-teams-mcp/HEAD/README.agent.md
and follow it to set up xats on this device.
```

The agent will confirm a device label, whether Codex App also needs xats, and
the `~/.zshrc` changes with you, auto-generate the daemon token on first
`start-xats`, and wire up the `free-xats-codex` / `xats-codex` /
optional `xats-codex-app` /
`free-xats-opencode` / `xats-opencode` launchers plus `start-xats` /
`stop-xats`.  Prefer doing it by hand?  Continue below.

### Claude Code

```bash
# 1. Start the daemon (run once, keep it alive)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. In your project, install the MCP config
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code

# 3. Start Claude Code with the channel loader (manual permission prompt expected)
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

### Other agents (Codex, opencode, ...)

```bash
# 1. Start the daemon (run once, keep it alive)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. In your project, install the MCP config (interactive picker)
npx mcpsmgr add jtianling/cross-agent-teams-mcp

# 3. Start your coding agent as usual
```

Note: Claude Code gets push wake out of the box.  Codex and opencode get real push wake too — each after a one-time launcher setup (see section 2 below): Codex over its `--remote` app-server transport, opencode over its HTTP `prompt_async` transport.  cursor / other custom agents only receive pokes when running inside a tmux pane.  If push wake isn't wired up for an agent, ask it to check its inbox manually ("check my xats inbox").

Then talk to your agent in plain language:

```
# In agent A:
Register me to xats as backend on team default.

# In agent B:
Register me to xats as frontend on team default.
Send backend a message: the API has changed.
```

That's it.  Sections below cover the details — daemon flags, manual MCP config, codex `--remote` setup, more usage patterns.

## 1. Start the daemon

Run this once on your machine and keep the process alive (dedicated terminal, `tmux`, `screen`, `launchd` — your call):

```bash
npx -y cross-agent-teams-mcp@latest daemon --port 9100
```

The daemon listens on `127.0.0.1:9100`.  MCP endpoint is `http://127.0.0.1:9100/mcp`, health endpoint is `http://127.0.0.1:9100/health`.

Common flags:

- `--port <n>` (default `9100`)
- `--host <addr>` (default `127.0.0.1`)
- `--device <label>` (default: hostname-derived label)
- `--token <t>` (Bearer auth)
- `--db <path>` (default `~/.cross-agent-teams-mcp/data.db`)
- `--pid-file <path>` (default `~/.cross-agent-teams-mcp/daemon.pid`)

For multi-host / multi-device setups (LAN, tailscale, etc.), see [section 4](#4-cross-host--cross-device-collaboration) below.

## 2. Configure your agent's MCP client

### Recommended: `mcpsmgr` (shown in Quick start)

[`mcpsmgr`](https://www.npmjs.com/package/mcpsmgr) reads this repo's `mcpsmgr.json` and writes the right MCP entries into your agent's config in one shot — including the Claude Code stdio channel proxy entry, the Codex `experimental_use_rmcp_client` toggle, and the streamable-http MCP entry.

To override the daemon port:

```bash
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code --port 9300
```

### Manual config

If you don't want `mcpsmgr` (private fork, custom token, custom stdio args, or you just prefer hand-edited config), the raw per-agent configs are below.

#### Claude Code (needs both entries — HTTP for tools, stdio for channel wake)

`.mcp.json` (or `~/.claude.json`):

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

Then start Claude Code with the experimental channel loader so it subscribes to the proxy's wake notifications:

```bash
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

The `server:<name>` suffix MUST equal the MCP server key in `.mcp.json` (`cross-agent-teams-channel` above).  If your daemon uses `--token <t>`, add `"headers": { "Authorization": "Bearer <t>" }` to the HTTP entry, and add `--token <t>` to the channel proxy args.

#### Codex CLI

Codex talks to the daemon over Streamable HTTP.  Wake-ups go through Codex's own app-server WebSocket transport — there is no channel proxy involved.

##### Minimum config (mailbox only, no push wake)

The primary CLI runtime uses the standard `~/.codex/config.toml`.  The
xats-managed desktop App keeps an isolated copy in
`~/.codex-app/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

`experimental_use_rmcp_client = true` MUST sit at the top level — without it, streamable-http MCP servers fail to load.

When the daemon was started with `--token <t>`: `export XATS_TOKEN=<t>` in the shell that launches codex, then add `bearer_token_env_var = "XATS_TOKEN"` to the `[mcp_servers.cross-agent-teams-mcp]` block.  (Codex 0.130+ silently ignores the older `[mcp_servers.X.headers]` form — its accepted keys are `http_headers` and `bearer_token_env_var`, and `bearer_token_env_var` is preferred so the token never lands in a checked-in config.)

In this minimum mode, `send_message` to this Codex still drops a row in its mailbox, but you have to call `get_inbox` yourself to read it — no push wake.

##### Let other agents wake you (codex-appserver poke)

To let other agents **wake** this Codex thread (not just mail it), you need `codex-appserver` delivery.  The setup has one non-obvious gotcha worth calling out:

> **In `codex --remote` mode, MCP servers are loaded by the app-server, NOT by the TUI.**  On current codex (verified on 0.144.x) the app-server resolves config **per thread from that thread's cwd**, merging a trusted project's `.codex/config.toml` layer on top of its own `CODEX_HOME`.  The primary CLI server uses the standard `~/.codex`; the xats-managed App server uses the isolated `~/.codex-app`.  Pass `-C "$PWD"` so the thread cwd points at the project.  Setting `CODEX_HOME` on the TUI alone still does nothing for MCP under `--remote`.

Start order:

```bash
# 1) Resident CLI server with the standard ~/.codex state.
env -u CODEX_HOME codex app-server --listen ws://127.0.0.1:8799

# 2) Codex TUI in a separate terminal, connected only to the CLI server.
codex --remote ws://127.0.0.1:8799
```

If the desktop App also needs xats poke, it must use a second server on 8800,
started from the current Codex/ChatGPT App bundle with
`features.code_mode_host=true`, and launch with
`CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8800`.  Do not use the PATH binary for
that server: version alignment is required for App/app-server protocol
compatibility.  This external app-server mode does not support the ChatGPT in
Chrome plugin.  Configure the daemon with
`CROSS_AGENT_TEAMS_CODEX_WS_URLS='["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]'`;
registration probes the supplied `thread_id` and persists the unique matching
endpoint.  See [README.agent.md](README.agent.md) for the complete lifecycle
functions and migration steps.

If neither the active app-server's `CODEX_HOME` nor the thread's trusted project `.codex/config.toml` has `cross-agent-teams-mcp` configured, the codex agent inside `--remote` won't see the MCP tools at all and `register_agent` will never fire.

##### Recommended: launcher with tmux pane auto-bind

For pokes to be injected directly into the running Codex thread (rather than landing as a tmux paste), the daemon needs to know which tmux pane the codex process lives in.  The launcher pre-claims a pane via the `pre-register-codex-pane` CLI before exec'ing codex.  Add to `~/.zshrc`:

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

What the launcher does:

- Inside tmux (`$TMUX_PANE` set): pre-registers the pane → uuid mapping with the daemon (120s TTL).  When the codex agent later calls `register_agent({agent_type: "codex", thread_id: $CODEX_THREAD_ID, ...})`, the daemon resolves `tmux_pane_id` automatically by matching the pre-reg against the codex argv.
- `--remote ws://127.0.0.1:8799` connects to the long-lived app-server from step (1) above.
- `-C "$PWD"` sets the thread cwd, which is also what makes the app-server merge a trusted project's `.codex/config.toml` layer (project-level xats installs) — no `CODEX_HOME` needed.
- `-c xats.agent_id="\"$uuid\""` exposes the uuid in codex's argv so the daemon can verify the pane.

More detail (auth headers, lower-level `register_agent` form): [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

#### opencode

opencode ships a first-class headless HTTP API (`POST /session/{id}/prompt_async`) that the daemon uses as a dedicated wake-up transport — no tmux pane injection required.  The transport is activated by registering with `agent_type="opencode"` and a `base_url` pointing at the opencode process's HTTP server.

When another agent pokes this opencode, the daemon POSTs the wake hint to `prompt_async`, which **starts a fresh opencode agent turn** — the agent wakes on its own and reads its inbox with no manual prompt, the same first-class push-wake that Claude Code and Codex get (not the passive tmux paste that `custom` agents fall back to).

Add a `free-xats-opencode` zsh function to `~/.zshrc` (mirrors the `free-xats-codex` pattern):

```zsh
free-xats-opencode() {
    local port
    port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    OPENCODE_XATS_BASE_URL="http://127.0.0.1:${port}" exec opencode --port "${port}" --hostname 127.0.0.1 "$@"
}
```

Then replace plain `opencode` with `free-xats-opencode`:

```bash
free-xats-opencode            # default agent
free-xats-opencode --agent build --model glm-5.2   # args pass through
```

What the launcher does:

- Allocates a free TCP port on `127.0.0.1` (supports concurrent opencode instances without port conflicts).
- Exports `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>` so the agent's Bash tool can read it and pass it as `base_url` to `register_agent`.
- `exec opencode --port <port> --hostname 127.0.0.1` starts the TUI with its HTTP server bound to loopback.

Inside the opencode TUI say:

> Register with xats, name: oc-1, team: default

The agent detects `$OPENCODE_XATS_BASE_URL`, picks `agent_type="opencode"` automatically, passes the env value as `base_url`, and omits `session_id` (the daemon auto-resolves it as the most recently updated session on that base_url).  `auth_token_ref` is only required when the opencode server was started with `OPENCODE_SERVER_PASSWORD` set; in that case also pass `auth_token_ref: "OPENCODE_SERVER_PASSWORD"`.

If you launch opencode via plain `opencode` (without the wrapper), the env var is absent, the agent falls back to `agent_type="custom"` with `agent_type_name="opencode"`, and pokes are delivered via tmux pane injection (see next section).

#### Other coding agents (cursor, ...)

Anything that is not Claude Code, Codex, or opencode-via-launcher — cursor, an editor extension, your own harness — connects over plain Streamable HTTP and registers as `agent_type="custom"` (the agent figures this out for you).  There is no dedicated wake-up transport for these; cross-agent pokes are delivered by injecting text into the agent's tmux pane, so run the agent inside a tmux window and the daemon will resolve `pid → tty → pane` automatically when you register.

Per-tool config snippets live in [docs/configs/opencode.md](docs/configs/opencode.md) (and `docs/configs/` for the rest).

## 3. Use it from your agent

Once your agent is connected to the daemon, you don't have to memorize tool names.  Just talk to the agent in plain language and it will pick the right tool — the README below shows the *kinds of things you say*, not the underlying API.

> Note: always run these from inside the agent session.  Don't hand-drive the MCP protocol with `curl` (or any other external HTTP client) to register or send — that opens a *different* MCP session, and worse, a `curl` `register_agent` triggers a cross-session **takeover** that force-closes your real session.  If your MCP client transport is dead and you just need a lifeboat, use the loopback-only REST API below instead — it never touches your session.

**Lifeboat: the loopback REST API.**  If an agent's MCP client transport breaks, it can no longer call any xats tool — not even to say it is stuck.  For exactly that case the daemon exposes a tiny, **loopback-only** REST surface on the same port under `/api/`.  It resolves the agent by `(team, name)`, reuses the same send / inbox / list-agents logic as the MCP tools, and has **zero session side-effects** (no takeover — safe even while your MCP session is still alive).  Remote callers get `403` by design; if the daemon was started with `--token`, present it just like `/mcp` (`Authorization: Bearer <token>` or `?token=<token>`).

```bash
# send as an already-registered agent
curl -s http://127.0.0.1:<port>/api/send \
  -H 'content-type: application/json' \
  -d '{"from":{"team":"default","name":"alice"},
       "to":{"team":"default","name":"bob"},
       "body":"my MCP client is wedged — restarting"}'

# read your inbox — omit since_event_id to advance your read cursor,
# or pass it for a read-only peek that does NOT advance the cursor
curl -s 'http://127.0.0.1:<port>/api/inbox?team=default&name=alice'

# list a team's agents
curl -s 'http://127.0.0.1:<port>/api/agents?team=default'

# remove one stale registry row (agent_id comes from the listing above)
curl -s -X DELETE http://127.0.0.1:<port>/api/agents/<agent_id>
```

**OpenCode runtime control.**  Launchers can use two separate sessionless
endpoints to reserve a runtime generation and commit an exact OpenCode session.
They use the same loopback and bearer-token gates as the lifeboat routes.  The
identity key is accepted only in the JSON body.

```text
POST /api/runtime/opencode/reserve
{"identity_key":"<key>","runtime_generation":2,"protocol_version":1}

POST /api/runtime/opencode/commit
{"identity_key":"<key>","runtime_generation":2,"protocol_version":1,
 "base_url":"http://127.0.0.1:4096","session_id":"ses_exact"}
```

Both bodies are strict, and `protocol_version` is required.  A schema-valid
service outcome is returned unchanged with HTTP `200`, including domain failures
whose body has `ok:false`.  Invalid JSON or schema input returns HTTP `400` as
`{"ok":false,"error":"invalid_request","detail":"..."}`.  Storage and
unexpected adapter failures return stable HTTP `503 storage_unavailable` and
HTTP `500 internal_error` envelopes with `ok:false`.  Authentication and remote
peer rejection remain HTTP `401` and `403`, before the recovery service runs.
The commit response keeps `connection_bound:false`; the exact OpenCode session
must reconnect itself.

These endpoints do not add daemon discovery.  A launcher must already know the
daemon endpoint or read the existing pid file for its `port`; a bearer token,
when configured, is supplied separately.  No new discovery endpoint or Unix
socket is exposed.

There is deliberately no `register_agent` over REST — creating or rebinding an identity is the very takeover footgun this surface avoids, so an agent must have registered once (over MCP) before it can use the lifeboat.

**Removing a registry row.**  `DELETE /api/agents/<agent_id>` deletes exactly that row and returns `{"deleted":true,"agent_id":...,"team":...,"name":...}`; an id that matches nothing returns `404 {"error":"unknown_agent"}`, so a repeated delete tells you it was already gone.  It is addressed by `agent_id` rather than `(team, name)` on purpose — rows carrying a device label the daemon no longer uses are exactly the ones worth clearing, and a `(team, name)` lookup pinned to the local device cannot reach them.  Liveness is not consulted: `online` degrades to a multi-day `last_seen_at` window for runtimes that register without a pid or a tmux pane, so gating on it would refuse the rows that most need removing.

This is a **registry** operation, not a way to stop an agent.  Nothing is killed: no process, no pane, no session.  A running agent whose row you delete will fail its next xats call as an unregistered session and has to `register_agent` again.  Agents remove themselves with the `unregister_self` tool; there is deliberately no MCP tool for removing *another* agent.

> Security note: "loopback-only" includes a browser running on the same machine, so run the daemon with `--token` to keep a local web page from reaching `/api/`.  Without a token, the worst a malicious local page can do is advance an agent's inbox cursor via a cross-site `GET /api/inbox` — it cannot read any response (CORS), send, or impersonate; the only effect is that agent may miss unread messages.  That is a bounded, consciously accepted risk; a token removes it entirely.

### Register the session

The first time an agent connects to xats it stays unregistered until you tell it to register.  Just say:

> Register me to xats as alice.

Or with an explicit team:

> Register me to xats as alice on team backend.

If you don't give a team, the agent uses your current working directory's basename — so you typically don't need to think about it.

### Talk to other agents

Address by name, by team, or by role:

> Send a message to bob: how is the migration going?
>
> Tell my team I'm starting the deploy.
>
> Send the frontend role a heads-up that the API will change.
>
> What's in my inbox?

The agent picks the right tool (`send_message`, `broadcast`, `broadcast_to_role`, `get_inbox`).  Outgoing messages also wake the recipient automatically — you don't need a separate poke.

### See who else is around

> Who else is registered on xats?
>
> List agents on team backend.

## 4. Cross-host / cross-device collaboration

Most users only need the single-host setup above; the `device` axis is invisible in loopback-only setups and you can skip this entire section.  Read on only if you want agents on multiple physical machines (LAN, tailscale, etc.) to share one daemon.

The setup needs three coordinated changes — **daemon bind**, **peer `.mcp.json`**, and **agent registration**.  Agents are namespaced by `(device, team, name)`: a bare `send_message({to_agent_name:"creator"})` resolves on the caller's own device, while `creator:host-b` addresses a same-team agent on another device.

### 1. Daemon-side: bind beyond loopback

Stop the daemon and restart with a non-loopback `--host` and a `--token`.  The token is mandatory whenever `--host` is non-loopback — the daemon refuses to start otherwise (`token_required_for_non_loopback_bind`).  Optionally set `--device` for the daemon-host label (defaults to `os.hostname()` lowercased with `[^a-z0-9_-]` replaced by `-`):

```bash
npx -y cross-agent-teams-mcp@latest daemon \
  --host 0.0.0.0 \
  --port 9100 \
  --token "$XATS_TOKEN" \
  --device host-a
```

Use a specific LAN IP (e.g. `10.0.0.10`) or a tailscale CGNAT IP (`100.x.x.x`) instead of `0.0.0.0` if you want to restrict the listener.  macOS will prompt to allow node to accept network connections on the first non-loopback bind.

### 2. Peer-side: `.mcp.json` updates

Each remote teammate's Claude Code needs **two** changes from the default loopback config: the HTTP entry must carry an `Authorization: Bearer …` header, and the channel proxy must pass `--token` AND `--device`.

> **`--device` is critical for cross-host setups.**  The daemon rejects any remote `register_agent` without a `device` field (`device_required_from_remote`), so a proxy spawned without `--device` ends up in a register/fail/respawn loop and never wakes the agent — auto-poke silently degrades to `no_pane`.  Since v0.5.18 the proxy auto-derives a label from `os.hostname()` and writes a stderr notice when `--device` is missing on a non-loopback daemon, but the derived value can still collide with the daemon-host's own label (triggering `device_spoofing_local_label_from_remote`).  Always pin `--device` explicitly per host:

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

For the primary Codex CLI, edit `~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams-mcp]
url = "http://10.0.0.10:9100/mcp"
bearer_token_env_var = "XATS_TOKEN"
```

…and `export XATS_TOKEN=xats` before launching codex.

The **daemon-side** `.mcp.json` (the machine running the daemon) needs the same `headers.Authorization` because the daemon now requires the token on every request, even loopback ones — once `--token` is set, no path through `/mcp` is unauthenticated.

### 3. Agent registration

Restart Claude Code (or codex) on the peer machine so the channel proxy spawns with the new `--device` argument.  The proxy's startup hint then embeds the device verbatim, and the user's reply contains it too:

> Register me to xats as alice, device host-b.

If a remote `register_agent` call omits `device`, the daemon rejects with `device_required_from_remote` — the agent must self-declare.  `device` becomes part of the identity tuple `(device, team, name)`, so two physical machines can each host a `creator` in `team=default` without collision.

### 4. Addressing across devices

Once everyone is registered, use the `name:device` suffix to address a same-team agent on another device:

> Send creator on host-a a message: build is green.

This resolves to `creator:host-a` and routes to that exact `(device=host-a, team=…, name=creator)` row.  A bare `creator` always resolves on the caller's own device.

Notes:

- `list_agents` returns a `device` field on every entry — use it to see which devices contribute to your team and to compose the right `name:device` target.
- `get_inbox` returns `from_name` and `from_device` on every message.  When replying via `send_message`, if `from_device !== <your device>` use `from_name:from_device`; otherwise the bare name is correct.  `send_message_by_id({to_agent_id: from_agent_id, ...})` is the device-agnostic safe fallback.
- Security caveat: the bearer token is shared across everyone who can reach the daemon.  Treat LAN exposure as a trusted-team boundary; there is no per-agent auth, device whitelist, or TLS in this mode.
- Upgrade note: the first startup after introducing the `device` axis auto-migrates the storage schema from `(team, name)` identity to `(device, team, name)` identity and backfills existing rows with the daemon's local `--device` label.  Rolling back after registering multiple devices with the same `(team, name)` can violate the old uniqueness assumption.

### 5. Codex-specific gotchas under cross-device setups

The `--token` + Codex `--remote` combination surfaces three caveats that don't show up in loopback-only single-device setups:

- **App-server env is frozen at launch.**  `codex app-server --listen ...` inherits its environment from the shell that started it.  If you set `bearer_token_env_var = "XATS_TOKEN"` and later `export XATS_TOKEN=…` in another shell, the running app-server still doesn't see it — Codex MCP startup fails with `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` (codex tries to parse the daemon's 401 body as a JSON-RPC frame).  Restart the app-server from a shell that already has `XATS_TOKEN` exported.

- **`--remote` hijacks the working directory.**  Under `codex --remote …` the session cwd is the **app-server's** cwd, not the TUI's — so a launcher invoked from any directory ends up wherever the app-server was started.  Pass `-C "$PWD"` to the `codex` command (already in the launcher above) to override per-session.

- **Project-level `.codex/config.toml` overlays the global one.**  A stale per-project block — especially in an iCloud / Dropbox-synced project directory shared between machines — can shadow your global auth setup and produce a failed MCP server name you don't recognize.  Symptom: codex reports a startup failure for a server that doesn't appear in `codex mcp list` (which only reflects the global config).  Audit with `find ~ -path '*/.codex/config.toml' -print` and remove or update stale entries.

## More

- Full tool reference and schema: launch the daemon and call `tools/list` on the MCP endpoint.
- Per-agent config details: `docs/configs/`.
- Source: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).

## Running Codex App and Codex CLI in isolation

If you use Codex CLI over SSH for long-running work and also want xats to wake
Codex App with a poke, the two surfaces must not share one app-server or
`CODEX_HOME`.  The current isolation is:

- The xats daemon uses port `9100`.
- Codex CLI uses `8799` and the default `~/.codex`, launched with
  `xats-codex` or `free-xats-codex`.
- Codex App uses `8800` and the isolated `~/.codex-app`, launched with
  `xats-codex-app`.
- The daemon accepts both WebSocket endpoints and uses `CODEX_THREAD_ID` at
  registration to find the unique matching endpoint.  App and CLI sessions
  therefore do not take over each other even when both open the same project.

This setup has been verified for registration, inbox delivery, poke wake-ups,
and replies.  It has one explicit limitation: Codex App launched through the
external app-server with `xats-codex-app` cannot currently use the ChatGPT in
Chrome plugin.  `features.code_mode_host=true` and the codex binary bundled
with the App only keep the App and app-server versions aligned; they do not
restore Chrome plugin support.

If the Chrome plugin matters more, do not enable xats for Codex App.  Keep
port `8799` and xats poke support for Codex CLI, and continue launching Codex
App natively from its macOS icon.  In this mode the App keeps Chrome plugin
support but does not receive xats poke wake-ups.  See
[README.agent.md](README.agent.md) for the complete automated setup branch and
launcher scripts.
