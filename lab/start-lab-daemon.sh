#!/usr/bin/env bash
# Start the lab daemon: isolated home, port, token and device label.
#
#   lab/start-lab-daemon.sh [--rebuild] [--fresh]
#
# --rebuild  npm run build first (default: build only when dist is missing)
# --fresh    wipe the lab DB before starting (scenarios usually want this)

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

REBUILD=0
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --fresh) FRESH=1 ;;
    *) lab_die "unknown flag: $arg" ;;
  esac
done

if [ -f "$LAB_HOME_DIR/daemon.pid" ]; then
  pid="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))}catch{}' "$LAB_HOME_DIR/daemon.pid" || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    lab_die "lab daemon already running (pid $pid); stop it with lab/stop-lab-daemon.sh"
  fi
  rm -f "$LAB_HOME_DIR/daemon.pid"
fi

if [ "$REBUILD" = 1 ] || [ ! -f "$LAB_REPO/dist/cli.js" ]; then
  echo "lab: building $LAB_REPO/dist ..."
  (cd "$LAB_REPO" && npm run build >/dev/null)
fi

if [ "$FRESH" = 1 ]; then
  rm -f "$LAB_HOME_DIR"/data.db "$LAB_HOME_DIR"/data.db-shm "$LAB_HOME_DIR"/data.db-wal
  : > "$LAB_DAEMON_LOG"
fi

# Fifth boundary, found by actually running a lab registration: a codex
# registration makes the DAEMON resume the thread over the codex app-server,
# whose endpoint defaults to ws://127.0.0.1:8799 — the PRODUCTION app-server.
# Without this the lab silently reaches into production on every codex
# register.  Pointing it at the lab port makes a missing lab app-server fail
# loudly (codex_appserver_unreachable) instead.
# Sixth boundary, also found by running: the daemon shells out to BARE `tmux`
# for pane probing and poking, so without TMUX_TMPDIR it talks to the SHARED
# tmux server — it would probe (and paste into) jt's real panes.  TMUX_TMPDIR
# alone is not enough: $TMUX must be cleared too, or the client ignores it.
# Seventh boundary: a lab script launched from a production shell inherits
# production credentials.  The token is passed on the command line (which
# wins today), but any future env fallback would silently authenticate the lab
# against production — override rather than rely on precedence.
CROSS_AGENT_TEAMS_MCP_HOME="$LAB_HOME_DIR" \
CROSS_AGENT_TEAMS_CODEX_WS_URL="${XATS_LAB_CODEX_WS_URL:-ws://127.0.0.1:$LAB_APPSERVER_PORT}" \
  nohup env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$LAB_TMUX_TMPDIR" \
  CROSS_AGENT_TEAMS_MCP_TOKEN="$LAB_TOKEN" \
  CROSS_AGENT_TEAMS_MCP_HOST=127.0.0.1 \
  node "$LAB_REPO/dist/cli.js" daemon \
    --port "$LAB_PORT" \
    --token "$LAB_TOKEN" \
    --device "$LAB_DEVICE" \
    --host 127.0.0.1 \
    >> "$LAB_DAEMON_LOG" 2>&1 &

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1 \
  || lab_die "lab daemon did not become healthy; see $LAB_DAEMON_LOG"

# The daemon falls back to port+1/port+2 when the requested port is taken, so
# a healthy $LAB_PORT is not proof that THIS daemon owns it — read the pid
# file it wrote and fail loudly on a mismatch rather than let scenarios talk
# to whatever else is listening.
actual_port="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port))' "$LAB_HOME_DIR/daemon.pid")"
if [ "$actual_port" != "$LAB_PORT" ]; then
  # Aborting the SCRIPT is not enough: the daemon we just started is still
  # running on the fallback port, while every client keeps dialling $LAB_PORT
  # — which is now someone else's daemon.  Take our own process down first so
  # the failure cannot be worked around by simply running a scenario anyway.
  strays="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))}catch{}' \
    "$LAB_HOME_DIR/daemon.pid" 2>/dev/null || true)"
  [ -n "$strays" ] && kill "$strays" 2>/dev/null
  rm -f "$LAB_HOME_DIR/daemon.pid"
  lab_die "lab daemon fell back to port $actual_port (wanted $LAB_PORT); it has been stopped — another lab likely holds the port, pick a different XATS_LAB_PORT"
fi

# Everything above proves OUR daemon owns the port right now; the guard exists
# so scenarios can re-assert it later, when another lab may have appeared.
lab_guard_port_owner

echo "lab daemon up:"
lab_env_summary
echo "log        : $LAB_DAEMON_LOG"
