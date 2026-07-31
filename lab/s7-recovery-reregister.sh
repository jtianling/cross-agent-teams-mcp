#!/usr/bin/env bash
# S7 — the OTHER half of recovery: after the poke, does the pane actually get
#      back on its feet?
#
#   lab/s7-recovery-reregister.sh            # restart keeps pane id AND pty
#   lab/s7-recovery-reregister.sh --respawn  # aoe shift+C shape: new pty
#
# Both restart shapes are run because both exist in production (see S3's header
# for the source-level confirmation that shift+C is `respawn-pane -k`).  If the
# chain breaks in the same place for both, the defect is independent of restart
# shape and a fix only has to be found once.
#
# S3 and S4 both stop at `codex-recovery delivered`.  That proves the WAKE-UP
# is correct — right pane, right identity, right wording, right timing.  It
# proves nothing about what happens next.  The point of recovery is not to send
# a message; it is to get the restarted codex bound to its identity again.
#
# This scenario runs the chain to the end:
#
#   1. seed -> the pane holds key K and is bound to carrier #1
#   2. restart -> carrier #1 dies, carrier #2 comes up in the same pane
#   3. the launcher pre-registers again WITH THE SAME KEY
#   4. recovery schedules / detects / delivers the notice   (S3 covers this)
#   5. the codex obeys the notice and re-registers          <- NEW
#   6. the identity row must now point at carrier #2, and the pre-reg row
#      must be consumed                                     <- NEW
#
# Steps 5 and 6 are the gap.  "The wake-up was correct" and "the agent stood
# back up" are different claims, and only the first has ever been tested.
#
# KEY STABILITY IS A FIXTURE GUARANTEE, ASSERTED EXPLICITLY.  Production could
# not exercise this chain because the launcher's identity_key changed across
# the restart, so the flow died before reaching step 5.  Here the same K is
# re-registered by construction, and step 3 asserts the identity row still
# carries it — otherwise a future change to key handling would surface as a
# confusing red somewhere in step 6 instead of as "the precondition broke".
#
# EXPECTED TO FAIL AT STEP 6 AS WRITTEN.  Same-thread evidence collapses onto
# the caller's own pre-restart row, whose recorded pid is now dead; the bind
# against that dead pid fails closed and the flow does not fall back to the
# pre-reg scan, so the new row is never consumed.  The assertions below state
# what recovery is FOR, not what the code currently does — a red here is a
# product finding, not a broken fixture.  Do not weaken them to make it green.
#
# Carrier shape and the "key only via env, never argv" rule are S1's.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

RESPAWN=0
[ "${1:-}" = "--respawn" ] && RESPAWN=1
SHAPE="$([ "$RESPAWN" = 1 ] && echo 'respawn: new pty' || echo 'in-pane: pty kept')"

SESSION="s7"
KEY="AAAAAAAA-1111-4000-8000-00000000000A"
UUID="88888888-8888-4888-8888-88888888888A"
THREAD="019fb000-0000-7000-a000-00000000000e"
WS="ws://127.0.0.1:$LAB_APPSERVER_PORT"
TEAM="lab"
NAME="agent-r"

fail() { echo "S7 FAIL: $*" >&2; exit 1; }
note() { echo "S7: $*"; }

cleanup() {
  [ -n "${HOLD_1:-}" ] && kill "$HOLD_1" 2>/dev/null || true
  [ -n "${HOLD_2:-}" ] && kill "$HOLD_2" 2>/dev/null || true
  lab_tmux_kill_server 2>/dev/null || true
  rm -f "$OUT_1" "$OUT_2"
}
trap cleanup EXIT

OUT_1="$(mktemp)"; OUT_2="$(mktemp)"

curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1 \
  || fail "lab daemon is not up; run lab/start-lab-daemon.sh --fresh first"
# A healthy port only proves some daemon is there.  On 2026-07-31 a second
# lab took this port and every call in this scenario went to its daemon.
lab_guard_port_owner

# CARRIER SHAPE — this is the HAND-LAUNCHED class, not aoe's.  An interactive
# shell plus `send-keys` leaves the shell in place with codex as its CHILD
# (ui_pid != pane_pid); that is how a human, or a `resume`, starts one.  aoe's
# production bootstrap is a NON-INTERACTIVE `sh -c ... exec codex`: the shell is
# replaced, so codex itself is the process-group leader (pid === pgid) and there
# is no shell in between.  Carrier collapse requires one of the matches to BE
# that leader, and an interactive shell hands every job its own process group —
# so this fixture always has a leader, whatever it launches.  The production
# bootstrap is therefore KNOWN-UNCOVERED here, not verified-equivalent.
# Keeping the shell also lets the carrier be replaced without disturbing the
# pane, which the restart below relies on.
carrier_cmd() {
  echo "node -e 'setInterval(()=>{},1e9)' -- codex --remote $WS -C /lab -c 'xats.agent_id=\"$UUID\"'"
}

reg_json() {
  cat <<EOF
{"agent_type":"codex","name":"$NAME","team":"$TEAM",
 "delivery":{"kind":"codex-appserver","thread_id":"$THREAD","ws_url":"$WS"}}
EOF
}

pre_register() {
  XATS_IDENTITY_KEY="$KEY" node "$LAB_REPO/dist/cli.js" pre-register-codex-pane \
    --pane "$PANE" --agent-id "$UUID" --identity-key-env XATS_IDENTITY_KEY \
    --ttl 600 --port "$LAB_PORT" --token "$LAB_TOKEN" >/dev/null \
    || fail "pre-register failed ($1)"
}

db_one() { sqlite3 "file:$(lab_db)?mode=ro" "$1"; }
row_of() { db_one "SELECT COALESCE($1,'-') FROM agents WHERE team='$TEAM' AND name='$NAME';"; }

# `|| true`: under `set -e -o pipefail` a no-match grep would abort with no
# message, which reads as "never ran" instead of "assertion found nothing".
carrier_pid() {
  ps -t "$TTY_NORM" -o pid=,command= 2>/dev/null \
    | grep -F "xats.agent_id=\"$UUID\"" | grep -- '--remote' \
    | awk '{print $1}' | head -1 || true
}

# --- 1. seed ----------------------------------------------------------------
lab_tmux kill-session -t "$SESSION" 2>/dev/null || true
lab_tmux new-session -d -s "$SESSION" -x 200 -y 50
sleep 0.3
read -r PANE TTY < <(lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty}')
[ -n "$PANE" ] || fail "no lab pane created"
TTY_NORM="${TTY#/dev/}"

lab_tmux send-keys -t "$PANE" "$(carrier_cmd)" Enter
sleep 1.5
PID_1="$(carrier_pid)"
[ -n "$PID_1" ] || fail "carrier #1 never started on tty $TTY_NORM"

pre_register "seed"
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent "$(reg_json)" >"$OUT_1" 2>&1 &
HOLD_1=$!
sleep 1.5
grep -q '"error"' "$OUT_1" && fail "seed register_agent failed: $(cat "$OUT_1")"

[ "$(row_of identity_key)" = "$KEY" ]  || fail "seed: key not attached (got: $(row_of identity_key))"
[ "$(row_of tmux_pane_id)" = "$PANE" ] || fail "seed: pane not bound (got: $(row_of tmux_pane_id))"
[ "$(row_of runtime_ui_pid)" = "$PID_1" ] \
  || fail "seed: bound pid $(row_of runtime_ui_pid), expected carrier #1 $PID_1"
[ "$(db_one "SELECT COUNT(*) FROM codex_pane_pre_registrations WHERE pane_id='$PANE';")" = "0" ] \
  || fail "seed: pre-reg row not consumed"
note "PASS(seed): ($TEAM, $NAME) holds K, bound to carrier #1 pid $PID_1 on $PANE"

# --- 2. restart: carrier #1 dies, carrier #2 takes the pane -----------------
# The MCP session dies with the process in production, so drop the hold too.
kill "$HOLD_1" 2>/dev/null || true; HOLD_1=""
if [ "$RESPAWN" = 1 ]; then
  lab_tmux respawn-pane -k -t "$PANE" "$(carrier_cmd)"
else
  kill "$PID_1" 2>/dev/null || true
  for _ in $(seq 1 40); do kill -0 "$PID_1" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$PID_1" 2>/dev/null && fail "carrier #1 ($PID_1) did not die"
  lab_tmux send-keys -t "$PANE" "$(carrier_cmd)" Enter
fi
sleep 1.5

now_tty="$(lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty}' | awk -v p="$PANE" '$1==p{print $2}')"
[ -n "$now_tty" ] || fail "pane $PANE vanished across the restart"
if [ "$RESPAWN" = 1 ]; then
  [ "$now_tty" != "$TTY" ] || fail "respawn kept the pty ($TTY); not reproducing aoe's shift+C shape"
else
  [ "$now_tty" = "$TTY" ] || fail "pty changed ($TTY -> $now_tty); not reproducing an in-pane restart"
fi
TTY_NORM="${now_tty#/dev/}"
PID_2="$(carrier_pid)"
[ -n "$PID_2" ] || fail "carrier #2 never started on tty $TTY_NORM"
[ "$PID_2" != "$PID_1" ] || fail "carrier pid unchanged ($PID_1); nothing restarted"
note "restarted ($SHAPE): carrier #1 $PID_1 -> #2 $PID_2, pane $PANE, tty $TTY -> $now_tty"

# --- 3. the launcher pre-registers again WITH THE SAME KEY ------------------
pre_register "restart"
[ "$(row_of identity_key)" = "$KEY" ] \
  || fail "PRECONDITION BROKEN: the identity row no longer carries K after the restart (got: $(row_of identity_key)). \
This fixture exists to test the chain WITH a stable key; a changed key breaks it before the interesting part."
note "PASS(key stable): the same K survives the restart on both the row and the new pre-reg"

# --- 4. recovery wakes the pane (S3 territory, re-asserted as a gate) -------
deadline=$((SECONDS + 60))
while [ $SECONDS -lt $deadline ]; do
  grep -q "codex-recovery delivered: pane=$PANE" "$LAB_DAEMON_LOG" && break
  sleep 1
done
grep -q "codex-recovery delivered: pane=$PANE identity=($TEAM, $NAME)" "$LAB_DAEMON_LOG" \
  || fail "recovery notice was never delivered; last: $(grep 'codex-recovery' "$LAB_DAEMON_LOG" | tail -1)"
note "PASS(wake-up): recovery delivered to ($TEAM, $NAME) on $PANE"

# --- 5. the codex obeys the notice and re-registers -------------------------
# This is what the notice literally instructs: same name, same team, same
# thread.  A fresh MCP session, because the old one died with carrier #1.
before_decisions="$(grep -c 'same-thread decision' "$LAB_DAEMON_LOG" || true)"
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent "$(reg_json)" >"$OUT_2" 2>&1 &
HOLD_2=$!
sleep 2.5
grep -q '"error"' "$OUT_2" && fail "re-registration failed outright: $(cat "$OUT_2")"

decision="$(grep 'same-thread decision' "$LAB_DAEMON_LOG" | tail -1)"
outcome="$(echo "$decision" | grep -oE 'outcome=[a-z_]+' | head -1 || true)"
[ "$(grep -c 'same-thread decision' "$LAB_DAEMON_LOG" || true)" -gt "$before_decisions" ] \
  || fail "the re-registration produced no same-thread decision at all; the flow did not reach arbitration"
note "re-registration decision: ${outcome:-<none>}"

# --- 6. did it actually stand back up? -------------------------------------
# What recovery is FOR.  Each fact reported with what was actually found, so a
# red says where the chain broke rather than just that it did.
got_pid="$(row_of runtime_ui_pid)"
got_pane="$(row_of tmux_pane_id)"
got_tty="$(row_of runtime_tty)"
left="$(db_one "SELECT COUNT(*) FROM codex_pane_pre_registrations WHERE pane_id='$PANE';")"

[ "$got_pid" = "$PID_2" ] \
  || fail "identity row still points at pid $got_pid, not the live carrier #2 $PID_2 \
(carrier #1 was $PID_1, now dead) — decision was ${outcome:-<none>}; the pane was woken but never rebound"
[ "$got_pane" = "$PANE" ] \
  || fail "identity row lost its pane (got: $got_pane) — decision was ${outcome:-<none>}"
[ "$got_tty" = "$TTY_NORM" ] \
  || fail "identity row tty is $got_tty, expected $TTY_NORM — decision was ${outcome:-<none>}"
[ "$left" = "0" ] \
  || fail "the restart's pre-reg row was never consumed ($left row(s) still pending) — \
decision was ${outcome:-<none>}; same-thread evidence skips the pre-reg scan, so the row has no other consumer"

note "PASS(stood back up): row rebound to carrier #2 pid $PID_2 on $PANE / $TTY_NORM, pre-reg row consumed"
echo "S7 PASS"
