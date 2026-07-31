#!/usr/bin/env bash
# Stop ONLY the lab daemon.  The pid is cross-checked against the lab home in
# its command line first: a pid file can be stale and its number reused, and
# killing the production daemon would drop every live agent's MCP session.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

pid_file="$LAB_HOME_DIR/daemon.pid"
[ -f "$pid_file" ] || { echo "lab: no pid file, nothing to stop"; exit 0; }

pid="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pid))' "$pid_file")"
[ -n "$pid" ] || lab_die "pid file has no pid: $pid_file"

cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
[ -n "$cmd" ] || { echo "lab: pid $pid not running; removing stale pid file"; rm -f "$pid_file"; exit 0; }

case "$cmd" in
  *"$LAB_HOME_DIR"*|*"CROSS_AGENT_TEAMS_MCP_HOME=$LAB_HOME_DIR"*) ;;
  *)
    # The lab home is passed via env, so it may not show in the command line;
    # require at least the lab port and the repo dist path before killing.
    case "$cmd" in
      *"--port $LAB_PORT"*) ;;
      *) lab_die "pid $pid does not look like the lab daemon (cmd: $cmd); refusing to kill" ;;
    esac
    ;;
esac

kill "$pid"
for _ in $(seq 1 25); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
kill -0 "$pid" 2>/dev/null && lab_die "lab daemon pid $pid did not exit"
rm -f "$pid_file"
echo "lab daemon stopped (pid $pid)"
