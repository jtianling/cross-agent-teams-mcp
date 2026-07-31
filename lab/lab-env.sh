#!/usr/bin/env bash
# Shared lab environment + isolation guards.  Source this, never execute it.
#
#   source lab/lab-env.sh
#
# Every boundary here is a HARD requirement: a lab script that talks to the
# production daemon (9100 / ~/.cross-agent-teams-mcp) or the shared tmux
# server produces worthless results at best and kills jt's live sessions at
# worst.

set -euo pipefail

LAB="${XATS_LAB_HOME:-$HOME/.xats-lab}"
LAB_PORT="${XATS_LAB_PORT:-9199}"
# codex app-server the LAB daemon may resume threads against.  The daemon's
# built-in default is the production 8799, so the lab must always override it.
LAB_APPSERVER_PORT="${XATS_LAB_APPSERVER_PORT:-8899}"
LAB_DEVICE="${XATS_LAB_DEVICE:-jtlab}"
LAB_HOME_DIR="$LAB/xats-home"
LAB_CODEX_HOME="$LAB/codex-home"
# The daemon shells out to BARE `tmux` (no -S flag available), so the lab
# server must be reachable through TMUX_TMPDIR resolution, not only through
# an explicit socket path — otherwise the lab daemon probes the SHARED tmux
# server and matches production panes.  Clients additionally pass -S with the
# resolved path so the "kill only by absolute socket path" rule still holds.
LAB_TMUX_TMPDIR="$LAB/tmuxtmp"
LAB_TMUX_SOCK="$LAB_TMUX_TMPDIR/tmux-$(id -u)/default"
LAB_DAEMON_LOG="$LAB/daemon.log"
LAB_TOKEN_FILE="$LAB/token"
LAB_REPO="${XATS_LAB_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

PROD_HOME_DIR="$HOME/.cross-agent-teams-mcp"
PROD_PORT=9100

mkdir -p "$LAB" "$LAB_HOME_DIR" "$LAB_CODEX_HOME" "$LAB_TMUX_TMPDIR/tmux-$(id -u)"
chmod 700 "$LAB_TMUX_TMPDIR" "$LAB_TMUX_TMPDIR/tmux-$(id -u)"

if [ ! -f "$LAB_TOKEN_FILE" ]; then
  # Lab-only token: distinct from production by construction.
  printf 'lab-%s\n' "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
    > "$LAB_TOKEN_FILE"
  chmod 600 "$LAB_TOKEN_FILE"
fi
LAB_TOKEN="$(cat "$LAB_TOKEN_FILE")"

lab_die() { echo "lab: $*" >&2; exit 1; }

# Refuse to run against production values, whatever the caller passed.
lab_guard_isolation() {
  [ "$LAB_PORT" != "$PROD_PORT" ] || lab_die "LAB_PORT must not be $PROD_PORT (production)"
  [ "$LAB_HOME_DIR" != "$PROD_HOME_DIR" ] || lab_die "LAB home must not be the production home"
  case "$LAB_HOME_DIR" in
    "$PROD_HOME_DIR"/*) lab_die "LAB home must not live under the production home" ;;
  esac
  [ "$LAB_TOKEN" != "xats" ] || lab_die "LAB token must not be the production token"
  [ "$LAB_DEVICE" != "jt" ] || lab_die "LAB device must not be the production device label"
  [ "$LAB_APPSERVER_PORT" != "8799" ] || lab_die "LAB app-server port must not be 8799 (production codex app-server)"
}

# tmux inside the lab: private socket AND a cleared $TMUX/$TMUX_PANE.  Setting
# TMUX_TMPDIR alone is NOT isolation — with $TMUX set the client talks to the
# CURRENT server and ignores it, which is how jt's live sessions got killed
# twice before.  Use this wrapper for every tmux call; never call tmux bare.
lab_tmux() {
  env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$LAB_TMUX_TMPDIR" \
    tmux -S "$LAB_TMUX_SOCK" "$@"
}

# Only ever tears down the lab's own private server (absolute socket path).
lab_tmux_kill_server() {
  [ -S "$LAB_TMUX_SOCK" ] || return 0
  env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$LAB_TMUX_TMPDIR" \
    tmux -S "$LAB_TMUX_SOCK" kill-server
}

lab_db() { echo "$LAB_HOME_DIR/data.db"; }

# A healthy $LAB_PORT is NOT proof that OUR daemon owns it.  `lab_guard_isolation`
# only keeps a lab off PRODUCTION; nothing stops a second lab from choosing the
# same port, and every client here dials $LAB_PORT directly.  When that happens
# the scenario talks to someone else's daemon — 2026-07-31 it did, and the only
# thing that made it loud was the two labs' tokens happening to differ.  Compare
# the LISTENING pid against the pid file our own start script wrote.
lab_guard_port_owner() {
  local listening owned
  listening="$(lsof -nP -iTCP:"$LAB_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  [ -n "$listening" ] || lab_die "nothing is listening on $LAB_PORT; start the lab daemon"
  owned="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))}catch{}' \
    "$LAB_HOME_DIR/daemon.pid" 2>/dev/null || true)"
  [ -n "$owned" ] || lab_die "no lab daemon pid file; something else owns $LAB_PORT"
  [ "$listening" = "$owned" ] || lab_die \
    "port $LAB_PORT is held by pid $listening, but our daemon is pid $owned — another lab took the port; pick a different XATS_LAB_PORT"
}

lab_env_summary() {
  cat <<EOF
lab root   : $LAB
xats home  : $LAB_HOME_DIR
codex home : $LAB_CODEX_HOME
port       : $LAB_PORT
device     : $LAB_DEVICE
token file : $LAB_TOKEN_FILE
tmux sock  : $LAB_TMUX_SOCK
repo       : $LAB_REPO
EOF
}
