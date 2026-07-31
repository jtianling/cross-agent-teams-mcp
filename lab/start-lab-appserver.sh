#!/usr/bin/env bash
# Start the LAB codex app-server on the lab port (never 8799).
#
#   lab/start-lab-appserver.sh
#
# The lab daemon resumes codex threads over this endpoint
# (CROSS_AGENT_TEAMS_CODEX_WS_URL), so real-codex scenarios need it up.  Shape
# is copied from the production launcher (README.agent.md), with two lab
# differences: the port, and CODEX_HOME kept pointed at the lab home instead
# of being cleared — production clears it so the shared app-server uses the
# real ~/.codex; the lab must NOT read or write that state.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

[ "$LAB_APPSERVER_PORT" != "8799" ] || lab_die "refusing to touch the production app-server port"

codex_bin="${XATS_LAB_CODEX_BIN:-$(command -v codex || true)}"
[ -n "$codex_bin" ] || lab_die "codex binary not found; set XATS_LAB_CODEX_BIN"

log="$LAB/appserver.log"
if lsof -nP -iTCP:"$LAB_APPSERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "lab app-server already listening on $LAB_APPSERVER_PORT"
  exit 0
fi

CODEX_HOME="$LAB_CODEX_HOME" nohup "$codex_bin" \
  app-server \
  --listen "ws://127.0.0.1:$LAB_APPSERVER_PORT" \
  >>"$log" 2>&1 &

for _ in $(seq 1 50); do
  lsof -nP -iTCP:"$LAB_APPSERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  sleep 0.2
done
lsof -nP -iTCP:"$LAB_APPSERVER_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
  || lab_die "lab app-server did not come up; see $log"

echo "lab app-server up on ws://127.0.0.1:$LAB_APPSERVER_PORT (CODEX_HOME=$LAB_CODEX_HOME, log=$log)"
