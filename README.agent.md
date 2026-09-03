# README.agent.md — xats device setup guide (for code agents)

> Audience: a code agent configuring the xats (cross-agent-teams-mcp) launch
> environment on a new device.  Follow this document in order; when done, the
> device can launch codex / opencode / claude-code agents with xats
> communication wired up, using a single set of shell commands.

Target UX after setup:

1. Device-resident services are managed with `start-xats` / `stop-xats`
   (one daemon + an isolated CLI app-server, plus an isolated App app-server
   only when the user explicitly opts in);
2. Each project needs at most one
   `npx mcpsmgr add jtianling/cross-agent-teams-mcp -a <agent>` run per
   agent — and none at all for agents installed globally (see section 3);
3. Running `free-xats-codex` / `xats-codex` / optional `xats-codex-app` /
   `free-xats-opencode` / `xats-opencode` launches the corresponding agent
   with xats transport poke etc. working out of the box.
   `free-` prefix = yolo mode (skip approvals/sandbox), no prefix = normal
   approval mode.

## 0. Before you start: prerequisites and five things to align with the user

Prerequisites (check before anything else): macOS with zsh; Node.js >= 20
(ships `npx`).  Per agent, only needed if the device will run it:
codex >= 0.124.0 (the Codex/ChatGPT macOS app bundles a compatible CLI),
opencode, Claude Code.  tmux is optional but required for codex tmux-pane
poke delivery.

1. **daemon token**: once the daemon runs with `--token`, every agent-side
   config must carry the same token; any mismatch is a 401.  You do **not**
   need to ask the user for a token: the first `start-xats` run auto-generates
   one, format `<hostname>-<6 random digits>`, **unique per device — never
   reuse another device's value**.  It is printed for the user and persisted
   to `~/.config/xats/token`; every new shell exports it via zshrc.  Wherever
   this document says `<TOKEN>`, it means the current value of
   `$CROSS_AGENT_TEAMS_MCP_TOKEN`.  The daemon listens on `0.0.0.0` (so this
   device can act as a cross-device hub, see section 2.4), so a token is
   mandatory.
2. **device label**: one short, unique label per device (e.g. `jt`,
   `jtianling-mac-mini`), used as the `name:device` suffix for cross-device
   addressing.  Ask the user to pick one.
3. **consent to edit the shell config**: this repo never silently modifies the
   user's shell config.  Show the section 2.1 snippet to the user and write it
   only after approval.
4. **Codex App xats support — explicit opt-in**: before planning Codex
   runtimes, ask the user this question verbatim:

   > Do you also want to use xats in Codex App and support poke wake-ups?  If
   > enabled, the App must be launched through `xats-codex-app` and cannot
   > currently use the ChatGPT in Chrome plugin.  If disabled, launch the App
   > natively from its macOS icon to keep the Chrome plugin, and use xats only
   > with Codex CLI.

   Do not infer the answer from the presence of a Codex/ChatGPT App bundle.
   Record the answer in the zshrc snippet as
   `XATS_CODEX_APP_ENABLED=1` for yes or `0` for no.

   - **Yes**: use the current isolated split — CLI on 8799 with the standard
     `~/.codex`, App on 8800 with `~/.codex-app`, and install/configure
     `xats-codex-app`.  xats registration and poke work in both surfaces, but
     ChatGPT in Chrome does not work in the externally managed App runtime.
   - **No**: preserve the CLI-only flow — start only the CLI app-server on
     8799, do not start or stop port 8800, do not install xats into the App
     home, and omit `xats-codex-app` from setup and hand-off commands.  The
     user launches Codex App normally from its macOS icon; that native App is
     outside the xats poke path.
5. **install scope — global vs per-project**: ask the user which they want
   before running any section 3 install.  Global = configure once, every
   project on the device can use xats afterwards — much simpler to operate.
   Per-project = the config lives inside each project, and **every new
   project needs the same install command again** — more hassle, but nothing
   is written outside the project.  All three agents support both levels.
   Caveats: the claude-code push-wake channel only exists project-level, and
   codex project-level additionally requires the repo to be trusted by Codex
   (details in section 3).  Whatever the user picks, the section 8 hand-off
   must explain the matching usage.

## 1. Architecture in one minute (why these steps)

- **daemon** (port 9100): the hub for all agent communication; resident
  process, one per device.
- **codex CLI**: the TUI connects with `--remote` to a resident CLI
  app-server on port 8799.  That process clears `CODEX_HOME` and therefore
  uses the standard `~/.codex`, making CLI config, instructions, auth, and
  sessions the primary Codex state.
  Config resolution under `--remote` (verified on codex 0.144.x): the CLI
  app-server resolves configuration **per thread from that thread's cwd**,
  merging layers CLI override > project
  `<repo>/.codex/config.toml` (trusted repos only) > user
  `~/.codex/config.toml` > system.  This is why the launcher passes
  `-C "$PWD"`.  The CLI xats MCP config can live at either level:
  global `~/.codex/config.toml` (section 2.2) or project
  `.codex/config.toml` (section 3.2).  `CODEX_HOME` is NOT needed for
  project-level installs — exporting it only for the remote TUI does
  nothing; if used at all (full state isolation: config + auth + sessions),
  it must be set on the app-server process.
- **codex App, opt-in only**: when the user chose App xats support, the macOS
  App connects through
  `CODEX_APP_SERVER_WS_URL=ws://127.0.0.1:8800` to a second app-server.  That
  process uses the isolated `~/.codex-app` state and MUST use the codex binary
  inside the currently installed Codex/ChatGPT App bundle.  Keeping this
  binary aligned with the App preserves App/app-server protocol compatibility,
  but does not make ChatGPT in Chrome available.  Never fall back to a PATH
  codex binary for this App runtime.  When the user chose no, skip port 8800
  entirely and leave the natively launched App untouched.
- **opencode**: every instance ships its own HTTP server.  The launcher
  allocates a random loopback port and exports `OPENCODE_XATS_BASE_URL`;
  the daemon push-wakes it through `prompt_async` — no tmux dependency.
  Its MCP config is **project-level** `opencode.json`, written by mcpsmgr.
- **claude-code**: MCP + channel server config is project-level `.mcp.json`,
  written by mcpsmgr; launch with `--dangerously-load-development-channels`
  to attach the channel.
- **pre-register-codex-pane**: before exec'ing codex, the launcher announces
  "pane X is about to run agent UUID Y" to the daemon, so a later
  `register_agent` from inside codex auto-binds the tmux pane — no manual
  `bind_runtime_identity` needed.

## 2. Device-level one-time setup

### 2.1 ~/.xats.sh snippet

The xats block is large and keeps growing, so it lives in its own file,
`~/.xats.sh`, sourced from `~/.zshrc`.  Everything below — aliases, launcher
functions, `XATS_*` variables, and the service-management functions — goes in
that one file.

Check for old versions first: `grep -n 'xats' ~/.zshrc ~/.xats.sh`.  Older
setups put the whole block directly in `~/.zshrc`.  If old definitions of
`free-xats-codex` / `xats-codex-app` / `free-xats-opencode` / `start-xats` /
`XATS_TOKEN` etc. exist there, confirm with the user, **move them into
`~/.xats.sh` and remove the old inline block** (zsh lets later definitions
win, but stale aliases interfere with functions and stale variable names
mislead debugging).

Write the whole block to `~/.xats.sh` (replace `<DEVICE>` and change
`XATS_CODEX_APP_ENABLED` to `1` only when the user opted in), then make sure
`~/.zshrc` sources it exactly once:

```zsh
# xats (cross-agent-teams-mcp) launchers and service management
[[ -f ~/.xats.sh ]] && source ~/.xats.sh
```

That two-line stanza is all that stays in `~/.zshrc`.  `source ~/.zshrc`
elsewhere in this document still works — it picks up `~/.xats.sh` through it.

Full `~/.xats.sh` contents:

```zsh
# ===== xats (cross-agent-teams-mcp) =====
# Single token variable: referenced by both daemon --token and codex
# bearer_token_env_var.  Auto-generated and persisted by the first start-xats
# run; do not hand-write the value.
XATS_TOKEN_FILE="$HOME/.config/xats/token"
[[ -f "$XATS_TOKEN_FILE" ]] && export CROSS_AGENT_TEAMS_MCP_TOKEN="$(<"$XATS_TOKEN_FILE")"
XATS_DEVICE="<DEVICE>"
# Safe default: CLI only.  Change to 1 only when the user opted in.
XATS_CODEX_APP_ENABLED=0

# Locate a CLI binary.  CLI prefers PATH but may use the App bundle binary.
_xats-codex-cli-bin() {
    local path_bin
    path_bin="$(command -v codex 2>/dev/null)"
    if [[ -n "$path_bin" ]]; then
        echo "$path_bin"
        return 0
    fi
    _xats-codex-app-bin
}

# Locate the current desktop App bundle binary.  No PATH fallback is allowed.
_xats-codex-app-bin() {
    local app
    for app in /Applications/Codex.app /Applications/ChatGPT.app; do
        if [[ -x "$app/Contents/Resources/codex" ]]; then
            echo "$app/Contents/Resources/codex"
            return 0
        fi
    done
    return 1
}

_xats-wait-port() {
    local port="$1" i
    for i in {1..20}; do
        nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && return 0
        sleep 0.5
    done
    return 1
}

start-xats() {
    mkdir -p "${XATS_TOKEN_FILE:h}"
    if [[ -z "$CROSS_AGENT_TEAMS_MCP_TOKEN" ]]; then
        printf '%s-%06d' "$(hostname -s)" \
            "$(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 ))" \
            > "$XATS_TOKEN_FILE"
        chmod 600 "$XATS_TOKEN_FILE"
        export CROSS_AGENT_TEAMS_MCP_TOKEN="$(<"$XATS_TOKEN_FILE")"
        echo "[xats] generated daemon token: $CROSS_AGENT_TEAMS_MCP_TOKEN"
        echo "[xats] saved to $XATS_TOKEN_FILE (remove the file to regenerate)"
    elif [[ ! -f "$XATS_TOKEN_FILE" ]]; then
        printf '%s' "$CROSS_AGENT_TEAMS_MCP_TOKEN" > "$XATS_TOKEN_FILE"
        chmod 600 "$XATS_TOKEN_FILE"
        echo "[xats] token file was missing; persisted env token to $XATS_TOKEN_FILE"
    fi

    local cli_bin app_bin candidates='[]'
    cli_bin="$(_xats-codex-cli-bin)"
    if [[ -n "$cli_bin" ]]; then
        env -u CODEX_HOME "$cli_bin" \
          app-server \
          --analytics-default-enabled \
          --listen ws://127.0.0.1:8799 \
          >>"${XATS_TOKEN_FILE:h}/codex-cli-app-server.log" 2>&1 &!
        if _xats-wait-port 8799; then
            candidates='["ws://127.0.0.1:8799"]'
        else
            echo "[xats] CLI app-server failed; see" \
              "${XATS_TOKEN_FILE:h}/codex-cli-app-server.log" >&2
        fi
    else
        echo "[xats] codex CLI runtime skipped: no codex binary found" >&2
    fi

    if [[ "$XATS_CODEX_APP_ENABLED" == 1 ]]; then
        app_bin="$(_xats-codex-app-bin)"
        if [[ -n "$app_bin" ]]; then
            env CODEX_HOME="$HOME/.codex-app" "$app_bin" \
              -c features.code_mode_host=true \
              app-server \
              --analytics-default-enabled \
              --listen ws://127.0.0.1:8800 \
              >>"${XATS_TOKEN_FILE:h}/codex-app-app-server.log" 2>&1 &!
            if _xats-wait-port 8800; then
                if [[ "$candidates" == '[]' ]]; then
                    candidates='["ws://127.0.0.1:8800"]'
                else
                    candidates='["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]'
                fi
            else
                echo "[xats] App app-server failed; see" \
                  "${XATS_TOKEN_FILE:h}/codex-app-app-server.log" >&2
            fi
        else
            echo "[xats] App runtime skipped: no Codex/ChatGPT bundle binary" >&2
        fi
    fi

    if [[ "$candidates" == '[]' ]]; then
        env -u CROSS_AGENT_TEAMS_CODEX_WS_URL \
          -u CROSS_AGENT_TEAMS_CODEX_WS_URLS \
          npx -y cross-agent-teams-mcp@latest daemon \
          --host 0.0.0.0 --port 9100 \
          --token "$CROSS_AGENT_TEAMS_MCP_TOKEN" --device "$XATS_DEVICE" \
          >>"${XATS_TOKEN_FILE:h}/daemon.log" 2>&1 &!
    else
        env -u CROSS_AGENT_TEAMS_CODEX_WS_URL \
          CROSS_AGENT_TEAMS_CODEX_WS_URLS="$candidates" \
          npx -y cross-agent-teams-mcp@latest daemon \
          --host 0.0.0.0 --port 9100 \
          --token "$CROSS_AGENT_TEAMS_MCP_TOKEN" --device "$XATS_DEVICE" \
          >>"${XATS_TOKEN_FILE:h}/daemon.log" 2>&1 &!
    fi
}

stop-xats() {
    local label port spec found=0
    local -a pids specs ports
    specs=("xats daemon:9100" "codex CLI app-server:8799")
    ports=(9100 8799)
    if [[ "$XATS_CODEX_APP_ENABLED" == 1 ]]; then
        specs+=("codex App app-server:8800")
        ports+=(8800)
    fi
    for spec in "${specs[@]}"; do
        label="${spec%%:*}"; port="${spec##*:}"
        pids=("${(@f)$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null)}")
        if [[ -n "${pids[1]}" ]]; then
            echo "[xats] stopping ${label} (port ${port}, pid ${pids[*]})"
            kill "${pids[@]}" 2>/dev/null
            found=1
        else
            echo "[xats] ${label} not running (port ${port})"
        fi
    done
    (( found )) || { echo "[xats] nothing to stop"; return; }
    sleep 1
    for port in "${ports[@]}"; do
        pids=("${(@f)$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null)}")
        if [[ -n "${pids[1]}" ]]; then
            echo "[xats] force-killing survivors on port ${port} (pid ${pids[*]})"
            kill -KILL "${pids[@]}" 2>/dev/null
        fi
    done
}

xats-codex-app() {
    if [[ "$XATS_CODEX_APP_ENABLED" != 1 ]]; then
        echo "[xats] Codex App xats support is disabled;" \
          "launch the App from its macOS icon" >&2
        return 1
    fi
    local app_bundle="/Applications/Codex.app"
    [[ -d "$app_bundle" ]] || app_bundle="/Applications/ChatGPT.app"
    if [[ ! -d "$app_bundle" ]]; then
        echo "[xats] Codex app not found" >&2
        return 1
    fi
    local app_executable app_bin app_pid port
    local log_dir="$HOME/.config/xats"
    if ! app_executable="$(/usr/libexec/PlistBuddy \
      -c 'Print :CFBundleExecutable' \
      "$app_bundle/Contents/Info.plist" 2>/dev/null)"; then
        echo "[xats] failed to read Codex app executable" >&2
        return 1
    fi
    app_bin="$app_bundle/Contents/MacOS/$app_executable"
    if [[ ! -x "$app_bin" ]]; then
        echo "[xats] Codex app executable not found: $app_bin" >&2
        return 1
    fi

    for port in 9100 8800; do
        if ! nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then
            echo "[xats] service is not listening on port $port;" \
              "run start-xats first" >&2
            return 1
        fi
    done

    if pgrep -x "$app_executable" >/dev/null 2>&1; then
        echo "[xats] Codex app is already running; quit it before retrying" >&2
        return 1
    fi
    if ! mkdir -p "$log_dir"; then
        echo "[xats] failed to create log directory: $log_dir" >&2
        return 1
    fi

    CODEX_HOME="$HOME/.codex-app" \
      CODEX_APP_SERVER_WS_URL="ws://127.0.0.1:8800" \
      "$app_bin" >>"$log_dir/codex-app.log" 2>&1 &!
    app_pid=$!
    sleep 1
    if ! kill -0 "$app_pid" 2>/dev/null; then
        echo "[xats] Codex app exited during startup;" \
          "see $log_dir/codex-app.log" >&2
        return 1
    fi
    echo "[xats] started Codex app with isolated App runtime on port 8800"
}

_xats-codex() {
    local xats_agent_id ws_url
    xats_agent_id="$(uuidgen)"
    ws_url="ws://127.0.0.1:8799"

    if ! nc -z 127.0.0.1 8799 >/dev/null 2>&1; then
        echo "[xats] codex app-server not running, starting it" >&2
        mkdir -p "${XATS_TOKEN_FILE:h}"
        local codex_bin
        codex_bin="$(_xats-codex-cli-bin)"
        if [[ -z "$codex_bin" ]]; then
            echo "[xats] codex CLI not found (no Codex/ChatGPT app, not on PATH)" >&2
            return 1
        fi
        env -u CODEX_HOME "$codex_bin" \
            app-server \
            --analytics-default-enabled \
            --listen "$ws_url" \
            >>"${XATS_TOKEN_FILE:h}/codex-cli-app-server.log" 2>&1 &!
        if ! _xats-wait-port 8799; then
            echo "[xats] failed to start codex app-server on $ws_url" >&2
            return 1
        fi
    fi

    if [[ -n "$TMUX_PANE" ]]; then
        npx -y cross-agent-teams-mcp pre-register-codex-pane \
            --pane "$TMUX_PANE" \
            --agent-id "$xats_agent_id" \
            >/dev/null 2>&1 \
            || echo "[xats] pre-register failed (continuing without pane claim)" >&2
    fi

    local codex_bin
    codex_bin="$(_xats-codex-cli-bin)"
    "$codex_bin" "$@" \
        --remote "$ws_url" \
        -C "$PWD" \
        -c xats.agent_id="\"$xats_agent_id\""
}

free-xats-codex() { _xats-codex --dangerously-bypass-approvals-and-sandbox "$@"; }
xats-codex()      { _xats-codex "$@"; }

_xats-opencode() {
    local port
    port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    OPENCODE_XATS_BASE_URL="http://127.0.0.1:${port}" \
        exec opencode --port "${port}" --hostname 127.0.0.1 "$@"
}

free-xats-opencode() { _xats-opencode --auto "$@"; }
xats-opencode()      { _xats-opencode "$@"; }


alias free-xats-claude="claude --dangerously-skip-permissions --dangerously-load-development-channels server:cross-agent-teams-channel"
alias xats-claude="claude --dangerously-load-development-channels server:cross-agent-teams-channel"
# ===== end xats =====
```

Key points (understand before changing anything):

- `-C "$PWD"` in `_xats-codex` must stay: `codex --remote` defaults to the
  app-server's cwd; without it the session lands in whatever directory the
  app-server was started from.
- `-c xats.agent_id="\"$uuid\""` puts the uuid into codex's argv; the daemon
  verifies the pre-registered pane against it.  Do not remove.
- `_xats-opencode` uses `exec`: the shell/pane ends together with opencode.
  This is intended behavior (the launcher is the session).
- pre-register failing, or not being inside tmux, never blocks the launch —
  it only degrades to "no automatic pane binding".
- `start-xats` always generates/persists the token, starts the CLI runtime
  when available, starts the App runtime only when
  `XATS_CODEX_APP_ENABLED=1`, then starts one daemon with
  `CROSS_AGENT_TEAMS_CODEX_WS_URLS` containing only listeners that came up.
  It clears the legacy single endpoint env for that daemon process because
  the compatibility precedence would otherwise mask the candidate list.
  A claude-code/opencode-only device still gets a fully working daemon.
- When App xats support is enabled, CLI and App logs are separate:
  `~/.config/xats/codex-cli-app-server.log` and
  `~/.config/xats/codex-app-app-server.log`.  The desktop App process log is
  still `~/.config/xats/codex-app.log`.
- The optional App runtime always comes from the current App bundle and sets
  `CODEX_HOME=~/.codex-app`; this keeps App state isolated but does not enable
  ChatGPT in Chrome.  The CLI runtime clears `CODEX_HOME` and uses `~/.codex`.
- If the env already carries a token but `~/.config/xats/token` is missing
  (e.g. the file was deleted while a shell kept the export), `start-xats`
  writes the env value back to the file so new shells pick it up again.
- `_xats-codex` auto-starts the app-server (disowned via `&!`) when it is not
  running.  The current shell has the token env exported already, so there is
  no env-freeze problem; it errors out only if the startup itself fails.
- npx tags differ on purpose: the resident daemon uses `@latest` (rare
  restarts, picks up upgrades), while `pre-register-codex-pane` in the
  launcher uses the bare package name so every codex launch hits the npx
  cache instead of a registry round-trip.
- **`start-xats` restarts the codex app-server too, which ends every `--remote`
  conversation on the machine.**  Measured 2026-08-01: the daemon (9100) and the
  codex app-server (8799) start 45s apart from the SAME parent shell.  Under
  `--remote` a codex session lives inside the app-server, so restarting drops
  them all — each pane reports `WebSocket protocol error: Connection reset
  without closing handshake` and the user must `codex resume <id>` by hand.
  **MCP sessions self-heal; conversations do not.**  So "restart the daemon"
  is never just an agent-plumbing cost, and it must not be proposed as one.
- **Publishing a release breaks every `--no-install` consumer of `@latest`
  until the npx cache is warmed.**  `npm` resolves `latest` against the
  REGISTRY, so the moment a new version is published the spec points at a
  version the cache does not have, and `npx --no-install` refuses rather than
  fetching it.  Measured on the 0.8.0 release: agent-of-empires' codex
  bootstrap, which runs `npx --no-install cross-agent-teams-mcp@latest
  pre-register-codex-pane`, began failing with `npx canceled due to missing
  packages and no YES option: ["cross-agent-teams-mcp@0.8.0"]`.  Its
  degrade-and-retry branch reruns the SAME npx invocation, so the retry failed
  identically and the pane exited 1 — i.e. **from the moment of publish, every
  newly started or restarted codex pane fails to come up**.  Already-running
  panes are untouched, so it surfaces as "the next Shift+C is broken", with
  nothing in the failure pointing at a release having happened.
  **After publishing, warm the cache: `npx --yes cross-agent-teams-mcp@latest`.**
- **The daemon and the codex launcher share ONE npx cache entry**, so whoever
  warms it also decides which version the daemon loads on its next restart.
  On 2026-08-01 the daemon started from
  `~/.npm/_npx/<hash>/node_modules/.bin/cross-agent-teams-mcp` — the same
  directory the launcher resolves — and picked up 0.8.0 only because the cache
  had been warmed shortly before.  Two consequences: `--no-install` callers
  depend on somebody else having warmed the entry (they never create it), and
  warming it to an OLDER version would silently downgrade the daemon at its
  next restart.  Never conclude which build is live from a directory listing —
  read the running process's argv (see the daemon-restart notes above).
- `start-xats` redirects the daemon and enabled runtimes to their separate
  log files and disowns them (`&!`): no terminal spam, and they survive
  the launching terminal closing (plain `&` jobs get SIGHUP).  The token
  echoes stay on the terminal on purpose.  Trade-off: if the user runs
  everything inside tmux and prefers live logs in the pane, plain `&` without
  redirection is a valid local variation.

### 2.2 Initialize Codex homes and MCP config

The primary CLI keeps its existing standard `~/.codex` login, configuration,
instructions, and sessions.  When App xats support is enabled, create
`~/.codex-app` as the App's isolation boundary.  Do not copy `auth.json`,
sessions, or the complete CLI home; authenticate the App home independently
when first needed.

For the **global** branch, always install xats MCP into the standard CLI home.
Install it into the isolated App home only when
`XATS_CODEX_APP_ENABLED=1`:

```zsh
source ~/.zshrc && start-xats   # first run: generates the token into env (see 2.3)
env -u CODEX_HOME \
  npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a codex --global -y
if [[ "$XATS_CODEX_APP_ENABLED" == 1 ]]; then
  mkdir -p "$HOME/.codex-app"
  CODEX_HOME="$HOME/.codex-app" \
    npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a codex --global -y
fi
stop-xats && start-xats
```

This always writes the MCP block to `~/.codex/config.toml`.  With App xats
enabled, it also writes the same block to `~/.codex-app/config.toml`; otherwise
leave the App home untouched.  If mcpsmgr is not usable, merge the block below
into the same selected file or files rather than duplicating an existing key:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
bearer_token_env_var = "CROSS_AGENT_TEAMS_MCP_TOKEN"
```

- `experimental_use_rmcp_client = true` must be **top-level**; without it,
  codex does not load streamable-http MCP servers at all.
- Do not use the legacy `[mcp_servers.X.headers]` form: codex 0.130+ silently
  ignores it and the daemon returns 401.  The env var name referenced by
  `bearer_token_env_var` must match the one exported in section 2.1.
- Version requirement: codex 0.124.0+ (exports `CODEX_THREAD_ID` to MCP tool
  processes, required for registration).
- If the user chose project-level Codex config, skip the global MCP install
  commands and follow 3.2.  The App home still needs independent authentication
  when App xats support is enabled.
- SSH users run `xats-codex` normally.  It reconnects to the resident CLI
  endpoint on 8799.  When App xats is enabled, its endpoint and session list
  remain separate; otherwise the natively launched App remains outside this
  runtime entirely.

### 2.3 Start resident services and verify

```bash
source ~/.zshrc
start-xats
# wait a few seconds, then verify:
nc -z 127.0.0.1 9100 && echo daemon-ok
nc -z 127.0.0.1 8799 && echo cli-appserver-ok
if [[ "$XATS_CODEX_APP_ENABLED" == 1 ]]; then
  nc -z 127.0.0.1 8800 && echo app-appserver-ok
fi
```

The first run prints the auto-generated token — **relay it to the user**.

Note: an app-server's environment is frozen at launch time.  Token generation
and export happen inside `start-xats` before either service starts, so the
normal flow is safe.  Rotating the token later (delete the token file)
requires `stop-xats` then `start-xats`, and **already-open shells** need a
fresh `source ~/.zshrc` to pick up the new env.

### 2.4 Device role: standalone hub vs joining another device's daemon

Everything in this document configures the device as its **own hub**: a
local daemon on port 9100, a device-unique token, and every agent config
pointing at `127.0.0.1:9100`.  Two devices set up this way can NOT talk to
each other — cross-device teams share **one** daemon.

To make this device's agents join **another device's** daemon instead, the
agent-side configs change (the launchers stay the same):

- URL: `http://<hub-ip>:9100/mcp` (LAN / tailscale IP of the hub device);
- token: the **hub's** token, not this device's — the "never reuse another
  device's token" rule in section 0 applies to running your own daemon, not
  to authenticating against the hub;
- the claude-code channel proxy needs explicit `--token` and `--device`
  args in `.mcp.json`; codex / opencode registrations must self-declare
  `device` (the daemon rejects remote registers without it).

Follow README.md section 4 ("Cross-host / cross-device collaboration") for
the exact peer-side configs, and section 5 there for codex-specific gotchas.
One extra codex caveat: the daemon pokes codex by dialing the registered
delivery `ws_url` itself, so a joining device must register a `ws_url`
reachable **from the hub** — the loopback `ws://127.0.0.1:8799` default only
works when daemon and app-server share a machine.  A joining-only device
does not need its own daemon — skip `start-xats` or keep it only for
local-only teams.

## 3. Project-level vs global install (ask the user first)

Before running any install command in this section, **ask the user which
level they want** (the section 0 item 5 alignment should already have
settled this — do not re-ask if it did), then follow the matching branch:

- **Project-level** — the config lives inside the project
  (`opencode.json` / `.mcp.json`); only that project can use xats, and
  **every new project needs the same command again**.
- **Global** — configured once, all projects on the device covered, no
  per-project action afterwards.

What actually exists per agent (do not offer branches that do not work):

| Agent | Project-level | Global |
| --- | --- | --- |
| codex | `mcpsmgr add` into the project `.codex/config.toml`, repo must be Codex-trusted (3.2) | always install into `~/.codex`; also install into `~/.codex-app` only when App xats is enabled (2.2) |
| opencode | `mcpsmgr add` into `opencode.json` (3.1) | `mcpsmgr add --global` into `~/.config/opencode/opencode.json` (3.1) |
| claude-code | `mcpsmgr add` into `.mcp.json` (3.3) | tools-only via `claude mcp add --scope user`; push-wake channel stays project-level (3.3) |

**Mandatory reminder**: whenever you finish a **project-level** install, tell
the user explicitly that it only covers the current project — each new
project needs the same one-liner again (repeat this in the section 8
hand-off).  Global installs need no such reminder.

### 3.1 opencode

**Project-level** — if the user chose per-project; run in the project root:

```bash
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a opencode -y
```

- With mcpsmgr >= 0.4.8, `-y` is non-interactive: the token is read from the
  env var `CROSS_AGENT_TEAMS_MCP_TOKEN` (present under this document's token
  policy; `start-xats` must have run at least once), or pass it explicitly
  with `--var CROSS_AGENT_TEAMS_MCP_TOKEN=<TOKEN>`.
- Without `-y`, the interactive prompt asks for
  `CROSS_AGENT_TEAMS_MCP_TOKEN` (masked input); pressing enter = skip = 401
  later.  To view the token: `echo $CROSS_AGENT_TEAMS_MCP_TOKEN` (or
  `cat ~/.config/xats/token`).
- **Old versions (<= 0.4.7) silently skip the token under `-y` — do not use
  them.**
- If neither env nor `--var` supplied a token — the one remaining way this
  happens is running `-y` from a shell opened before this setup (it lacks the
  new env; see section 8) — the generated config carries no auth header and
  gets 401 at runtime.  Re-run from a shell with the env, or hand-edit
  `opencode.json`:

```json
{
  "mcp": {
    "cross-agent-teams": {
      "type": "remote",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" },
      "enabled": true
    }
  }
}
```

- `opencode.json` contains the plaintext token; make sure it is in
  `.gitignore` or the user accepts committing it.

**Global** — if the user chose global (requires mcpsmgr >= 0.4.9):

```bash
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a opencode --global -y
```

Writes the same `mcp` block into `~/.config/opencode/opencode.json`
(opencode reads this device-wide config; see `docs/configs/opencode.md`).
The token rules above apply unchanged.  A side benefit: the plaintext token
stays in the home directory instead of a committable project file.

### 3.2 codex

**Global** — already done in section 2.2 for the CLI home and, when App xats
is enabled, the App home; nothing more per project.

**Project-level** — if the user chose per-project; run in the project root:

```bash
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a codex -y
```

Writes the project `<repo>/.codex/config.toml`.  For it to take effect:

- the repo must be **trusted** by Codex, otherwise the project config layer
  is ignored;
- the CLI app-server, plus the App app-server only when enabled, keeps running
  per section 2 (`start-xats`) with
  `CROSS_AGENT_TEAMS_MCP_TOKEN` in its environment — the project config
  only names the env var, it does not carry the token value;
- launch from the project root with `free-xats-codex` / `xats-codex`: the
  launcher's `-C "$PWD"` is what routes the thread to this project's config
  layer.

Do not set `CODEX_HOME` for this — see section 1.  (Historical note: this
runbook used to claim `--remote` ignores project MCP config; that does not
hold on current codex, verified on 0.144.x.)

### 3.3 claude-code

**Project-level** — if the user chose per-project (also the right pick when
they chose global but want push wake, see below); run in the project root:

```bash
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a claude-code
```

Writes two servers into the project `.mcp.json`: `cross-agent-teams` (http
tool surface) and `cross-agent-teams-channel` (stdio channel).  Launch with
`xats-claude` / `free-xats-claude` from section 2.1 (the `server:` suffix
must equal the channel server key).

**Global** — only the HTTP tool server can go device-wide
(`claude mcp add --scope user ...`, see `docs/configs/claude-code.md`); the
push-wake channel flow documented in this runbook is project-level.  Prefer
project-level unless the user explicitly accepts mailbox-only (no push wake)
for claude-code.

## 4. Daily launch and agent-side registration

| Command | Effect |
| --- | --- |
| `free-xats-codex` | yolo codex, connects to app-server, tmux pane pre-registered |
| `xats-codex` | same, normal approval mode |
| `xats-codex-app` | opt-in only: macOS Codex App on isolated port 8800 with xats poke; ChatGPT in Chrome is unavailable |
| `free-xats-opencode` | yolo opencode, random port + push wake |
| `xats-opencode` | same, normal approval mode |
| `free-xats-claude` / `xats-claude` | claude-code with the xats channel attached |

Extra arguments pass through, e.g. `xats-opencode --model glm-5.2`.

After launch, the agent session registers itself via `register_agent`; key
parameters per agent type:

- **codex**: `agent_type="codex"`, `thread_id=$CODEX_THREAD_ID` (required),
  **do not pass `ui_pid`** (it disables the pre-register pane auto-bind
  path).
- **opencode**: `agent_type="opencode"`,
  `base_url=$OPENCODE_XATS_BASE_URL`, omit `session_id` (the daemon
  auto-resolves it).
- **claude-code**: `agent_type="claude-code"`, `ui_pid=$PPID`.
- Common: when no explicit `team`, pass `project_dir=$PWD`; the daemon
  derives the team from the directory basename.

Identity recovery: when a session lost its context (context clear) and no
longer remembers its own (team, name), call `reconnect` instead of
registering a new identity — claude-code: `reconnect({ui_pid: $PPID})`;
codex: `reconnect({thread_id: $CODEX_THREAD_ID})` (the daemon verifies the
thread via `thread/resume` on the app-server before reusing the identity).
Pass exactly one identity key.  If the session still remembers its (team,
name), call `register_agent` with them directly — the same agent_id is
reused, with no duplicate row.  The `unknown_agent` → re-register (or
reconnect) rule stays valid for every runtime.

## 5. Verification checklist

1. `nc -z 127.0.0.1 9100` and CLI port 8799 succeed.  Only when App xats is
   enabled, port 8800 must also succeed.
2. Launch `free-xats-codex` inside tmux; `register_agent` from within the
   session succeeds and the response carries **no `hint`** (a hint means pane
   auto-binding did not converge).
3. Launch `free-xats-opencode`; inside the session
   `printenv OPENCODE_XATS_BASE_URL` is non-empty and `register_agent`
   returns an `agent_id`.
4. When App xats is enabled, launch `xats-codex-app`, register an App task,
   and confirm CLI/App registration responses persist 8799 and 8800
   respectively.  Send a test message and confirm the App wakes and reads it
   through `get_inbox`.
5. When App xats is disabled, confirm port 8800 is not managed by these
   functions and launch the App natively from its macOS icon.  Do not expect
   xats poke in that App.
6. From another registered agent, `send_message` to each xats-enabled Codex
   agent returns `poked: true`, and each wakes up and reads it via
   `get_inbox`.

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `[xats] failed to start codex app-server` | codex binary missing, port 8799 is taken, or enabled App port 8800 is taken.  Check `~/.config/xats/codex-cli-app-server.log` and, when enabled, `codex-app-app-server.log` |
| Need daemon / app-server logs (startup errors, noise) | `tail -f ~/.config/xats/daemon.log` plus the CLI runtime log and, when enabled, the App runtime log.  App-server noise like `failed to refresh available models: timeout` is non-fatal |
| daemon vanished after its terminal was closed | It was started with a plain `&` (job gets SIGHUP with the terminal).  The current snippet's `&!` (disown) prevents this; restart with `start-xats` |
| `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` | Actually a daemon 401: the app-server cannot see the token env.  Restart from a shell that has it exported (`stop-xats` + `start-xats`) |
| xats MCP tools invisible inside codex | Global install: config missing from the active runtime home (`~/.codex` for CLI, or `~/.codex-app` for an xats-enabled App), or top-level `experimental_use_rmcp_client = true` missing.  Project-level install: repo not trusted by Codex, or the thread cwd misses the project (launcher lost `-C "$PWD"`) |
| Chrome plugin unavailable through `xats-codex-app` | Expected limitation of the external app-server mode.  `features.code_mode_host=true` and the App bundle binary do not restore it.  If Chrome is required, disable App xats, quit this App instance, and launch the App natively from its macOS icon |
| App shows or takes over CLI sessions | Both surfaces still point at one endpoint or one `CODEX_HOME`.  Verify CLI uses 8799 + `~/.codex`, App uses 8800 + `~/.codex-app` |
| 401 despite a configured token | Legacy `[mcp_servers.X.headers]` form (silently ignored on 0.130+); or a stale project-level `.codex/config.toml` overriding global auth.  Audit: `find ~ -path '*/.codex/config.toml' -print` |
| `mcpsmgr add` succeeded but the written config lacks `bearer_token_env_var` / has wrong servers (codex 401 / -32601) | Stale bundle cache on a device that installed xats before — only with mcpsmgr <= 0.4.9 (fixed in 0.4.10, see section 7).  Re-run with `mcpsmgr@latest`, or on old versions `npx -y mcpsmgr@latest uninstall cross-agent-teams` then re-add |
| codex session lands in the wrong directory | Launcher lost `-C "$PWD"` |
| `register_agent` response carries `hint` | Not inside tmux, or pre-register failed/expired (120s TTL).  Still functional, just no pane auto-bind; call `bind_runtime_identity` to bind manually if needed |
| opencode gets no push wake | Not launched via the launcher (missing `OPENCODE_XATS_BASE_URL`), or `base_url` not passed at registration |
| All tools return `unknown_session` / `unknown_agent` after a daemon restart | Reconnect the MCP server, then `reconnect` (claude-code: `ui_pid=$PPID`; codex: `thread_id=$CODEX_THREAD_ID`) or, if the session still remembers its (team, name), `register_agent` with them |
| Everything points at 9100 but connections fail or hit a foreign process | Port 9100 was taken at daemon startup, so it fell back to 9101/9102 (it tries the next two ports).  Check the `listening on` line in `~/.config/xats/daemon.log`, free port 9100 (`lsof -i tcp:9100`), then restart.  Note `stop-xats` sweeps 9100/8799 plus 8800 only when App xats is enabled — kill a fallback-port daemon by pid |

## 7. mcpsmgr version requirement

The mcpsmgr steps in this document require **mcpsmgr >= 0.4.8**
(`npx -y mcpsmgr@latest` satisfies this).  Key differences vs older versions
(<= 0.4.7):

1. `add -a codex` automatically ensures top-level
   `experimental_use_rmcp_client = true` in the target config.toml (recent
   codex defaults to the rmcp client; the key is a compatibility write for
   older codex and is left untouched if present).
2. The codex token is written as
   `bearer_token_env_var = "CROSS_AGENT_TEAMS_MCP_TOKEN"` (name taken from
   the xats manifest `envVars[].name`), never as a plaintext Authorization
   header; when the token is absent, empty `http_headers` / `headers` blocks
   are omitted entirely (opencode still gets a plaintext Bearer when a token
   exists — its config format has no env reference mechanism).
3. `--global` (codex only): writes the active Codex home's global
   `config.toml`.  Section 2.2 always runs it with
   the default `~/.codex`, and runs it with `CODEX_HOME=~/.codex-app` only when
   App xats is enabled.  Other agents reject `--global`.
4. Non-interactive token: repeatable `--var NAME=VALUE`; source priority is
   `--var` > `process.env` > interactive prompt; with a value in env, `-y` no
   longer silently skips it.

Old versions have none of the above (project-level codex config without the
rmcp toggle, plaintext / silently-skipped tokens) — do not run this document's
flow with them.

Known issue in <= 0.4.9, fixed in 0.4.10: if the device installed the xats
bundle before (`~/.mcps-manager/bundles.json` has an entry), `add
jtianling/cross-agent-teams-mcp` reused the stale central-store definition
without re-fetching the manifest, so `bearer_token_env_var` and per-agent
server filtering silently did not apply (symptom: codex 401 / -32601 right
after an apparently successful add).  Fresh devices were unaffected.  Since
0.4.10, `add` re-fetches the manifest on a bundle hit and asks to reinstall
when it changed (`-y` auto-agrees; offline falls back to the old behavior).
On <= 0.4.9 the workaround is
`npx -y mcpsmgr@latest uninstall cross-agent-teams`, then `add`.

## 8. Hand-off: what to tell the user when you are done

After the section 5 checklist passes, print a short hand-off message to the
user.  It must contain:

1. **The commands now available**:
   - `start-xats` / `stop-xats` — manage the resident daemon + codex
     app-server;
   - `free-xats-codex` / `xats-codex` — launch codex TUI (yolo / normal);
   - when App xats was enabled, `xats-codex-app` — launch the macOS Codex App
     against the isolated port 8800 runtime; also state that ChatGPT in Chrome
     is unavailable in this mode;
   - when App xats was disabled, tell the user to launch Codex App from its
     macOS icon and state that this native App does not receive xats pokes;
   - `free-xats-opencode` / `xats-opencode` — launch opencode (yolo /
     normal);
   - `free-xats-claude` / `xats-claude` — launch Claude Code with the xats
     channel.
2. **The daemon token value** and where it lives (`~/.config/xats/token`).
3. **The `source ~/.zshrc` reminder**: shells opened before this setup —
   including the very terminal the user is sitting in — do not have the new
   functions and env yet.  Run `source ~/.zshrc` there once, or open a new
   terminal.
4. **Scope-specific usage** (match what was chosen in section 0 item 5 /
   section 3):
   - **Global installs**: every project on the device is covered — `cd`
     into any project and launch with the point 1 commands, nothing else
     to configure.  Exception to state explicitly: if claude-code was set
     up global (tools-only), it has no push wake anywhere; a project that
     needs push wake must additionally run the project-level
     `-a claude-code` install.
   - **Project-level installs**: only projects already installed are
     covered.  Spell out the enable-a-new-project recipe: in each new
     project root run the same one-liner(s) again — codex (`-a codex -y`,
     repo must be Codex-trusted) / opencode (`-a opencode -y`) /
     claude-code (`-a claude-code`) — then launch with the point 1
     commands as usual.  Agents installed globally need no per-project
     step.
