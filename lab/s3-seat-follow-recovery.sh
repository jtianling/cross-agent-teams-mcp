#!/usr/bin/env bash
# S3 — seat follow across a rename, then recovery must poke the NEW name.
#
#   lab/s3-seat-follow-recovery.sh
#
# Shape (one pane, one physical seat, one codex thread T):
#   1. pane P seeded from a pre-reg row carrying key K  -> registers as X
#   2. the SAME running pane re-registers as Y on the SAME thread T
#      -> seat-follow must MIGRATE K from X to Y (X left keyless)
#   3. the pane restarts (carrier respawned, old pid dies)
#   4. the launcher pre-registers P again with K
#      -> recovery must resolve the holder as Y and its wording must name Y
# Without the seat-follow hook the key would stay on the abandoned X row and
# the recovery notice would tell the pane to re-register under the OLD name.
#
# Two deliberate lab boundaries, both stated so the verdict is not read wider
# than it is:
#
# a) The registrations pass `delivery` EXPLICITLY as codex-appserver.
#    register_agent only routes through RegisterCodexSelfService (which resumes
#    the thread over a real codex app-server) when `delivery` is undefined; an
#    explicit delivery goes straight to registerSvc.register.  Seat-follow and
#    same-thread arbitration both read the STORED row, so the logic under test
#    is unchanged — only the resume RPC is skipped, which would otherwise need
#    a real codex plus a genuinely resumable thread id.  A real-codex run still
#    has to confirm the resume leg separately.
#
# b) The restart kills the CARRIER, not the pane, and deliberately does NOT use
#    `respawn-pane -k`.
#
#    respawn-pane looks like the obvious tool and reads as harmless, which is
#    why this note is here rather than only at the call site: it keeps the pane
#    id but ALLOCATES A NEW PTY.  Measured on this fixture:
#
#        before respawn:  %0  /dev/ttys035  pid 82236
#        after  respawn:  %0  /dev/ttys040  pid 84114
#
#    A production codex restart happens INSIDE the pane — the shell stays, the
#    pty stays, only the codex process is replaced.  So a respawn-based fixture
#    reproduces a restart shape that never actually occurs, and any green it
#    produces is green for "pane-internal restart PLUS a pty swap", not for the
#    thing this scenario claims to cover.  (It did pass that way; the recovery
#    path re-reads the tty live via listPanes(), which absorbs the difference.
#    Passing for a reason the scenario is not asserting is exactly the failure
#    mode to avoid.)
#
#    Killing the codex child leaves the shell owning the pane, so the pane id
#    AND the tty survive.  The tty is then asserted unchanged, so a future edit
#    that reintroduces a pty swap fails loudly instead of silently weakening
#    the scenario.
#
# Stub carrier shape and the "key only via env, never argv" rule are S1's.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

SESSION="s3"
KEY="DDDDDDDD-0000-4000-8000-00000000000D"
UUID="44444444-4444-4444-8444-44444444444D"
THREAD="019fb000-0000-7000-a000-00000000000d"
WS="ws://127.0.0.1:$LAB_APPSERVER_PORT"
TEAM="lab"
NAME_X="agent-x"
NAME_Y="agent-y"

fail() { echo "S3 FAIL: $*" >&2; exit 1; }
note() { echo "S3: $*"; }

cleanup() {
  [ -n "${HOLD_X:-}" ] && kill "$HOLD_X" 2>/dev/null || true
  [ -n "${HOLD_Y:-}" ] && kill "$HOLD_Y" 2>/dev/null || true
  lab_tmux_kill_server 2>/dev/null || true
  rm -f "$OUT_X" "$OUT_Y"
}
trap cleanup EXIT

OUT_X="$(mktemp)"; OUT_Y="$(mktemp)"

curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1 \
  || fail "lab daemon is not up; run lab/start-lab-daemon.sh --fresh first"

# No `exec`: codex runs as a CHILD of the pane shell, the production shape
# (ui_pid != pane_pid).  It also makes the restart below faithful — killing the
# child leaves the shell, the pane AND its pty in place, which is what a codex
# restart looks like in production.
carrier_cmd() {
  echo "node -e 'setInterval(()=>{},1e9)' -- codex --remote $WS -C /lab -c 'xats.agent_id=\"$UUID\"'"
}

reg_json() {
  # $1 = name
  cat <<EOF
{"agent_type":"codex","name":"$1","team":"$TEAM",
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

# --- pane + carrier ---------------------------------------------------------
lab_tmux kill-session -t "$SESSION" 2>/dev/null || true
lab_tmux new-session -d -s "$SESSION" -x 200 -y 50
sleep 0.3

read -r PANE TTY < <(
  lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty}'
)
[ -n "$PANE" ] || fail "no lab pane created"
TTY_NORM="${TTY#/dev/}"

# The carrier pid is resolved from the TTY, never from `#{pane_pid}`.  This
# fixture uses `exec`, so the two happen to be equal here — but that is a
# LAB-ONLY identity: in production the shell stays and codex runs as its CHILD,
# so ui_pid != pane_pid.  Expecting pane_pid would pass here and quietly stop
# covering the production shape.
# `|| true`: with `set -e -o pipefail` a no-match grep aborts the script with no
# message, which reads as a mysterious silent failure instead of the caller's
# assertion reporting what was actually missing.
carrier_pid() {
  ps -t "$TTY_NORM" -o pid=,command= 2>/dev/null \
    | grep -F "xats.agent_id=\"$UUID\"" | grep -- '--remote' \
    | awk '{print $1}' | head -1 || true
}

lab_tmux send-keys -t "$PANE" "$(carrier_cmd)" Enter
sleep 1
PID_1="$(carrier_pid)"
[ -n "$PID_1" ] || fail "no codex carrier found on tty $TTY_NORM; the fixture never started"
note "pane $PANE ($TTY) carrier pid=$PID_1"

# --- 1. seed X from a pre-reg row carrying K --------------------------------
pre_register "seed"
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent "$(reg_json "$NAME_X")" \
  >"$OUT_X" 2>&1 &
HOLD_X=$!
sleep 1.5
grep -q '"error"' "$OUT_X" && fail "X register_agent failed: $(cat "$OUT_X")"

x_key="$(db_one "SELECT COALESCE(identity_key,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_X';")"
x_pane="$(db_one "SELECT COALESCE(tmux_pane_id,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_X';")"
x_pid="$(db_one "SELECT COALESCE(runtime_ui_pid,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_X';")"
[ "$x_key" = "$KEY" ]   || fail "X did not receive the seeded key (got: $x_key)"
[ "$x_pane" = "$PANE" ] || fail "X did not bind the pane (got: $x_pane)"
[ "$x_pid" = "$PID_1" ] || fail "X bound pid $x_pid, expected carrier $PID_1"
note "PASS(seed): X holds K and sits on pane $PANE / pid $PID_1"

# --- 2. the SAME running pane re-registers under a new name -----------------
# Same thread T, no pre-reg row left (X consumed it), no identity_key of its
# own: the key can only reach Y through the seat-follow hook.
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent "$(reg_json "$NAME_Y")" \
  >"$OUT_Y" 2>&1 &
HOLD_Y=$!
sleep 2
grep -q '"error"' "$OUT_Y" && fail "Y register_agent failed: $(cat "$OUT_Y")"

y_key="$(db_one "SELECT COALESCE(identity_key,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_Y';")"
y_pid="$(db_one "SELECT COALESCE(runtime_ui_pid,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_Y';")"
y_tty="$(db_one "SELECT COALESCE(runtime_tty,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_Y';")"
x_key_after="$(db_one "SELECT COALESCE(identity_key,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_X';")"
holders="$(db_one "SELECT COUNT(*) FROM agents WHERE identity_key='$KEY';")"

[ "$y_key" = "$KEY" ]        || fail "key did not follow the seat to Y (got: $y_key)"
[ "$x_key_after" = "-" ]     || fail "X kept the key after migration (got: $x_key_after)"
[ "$holders" = "1" ]         || fail "expected exactly 1 key holder after migration, got $holders"
[ "$y_pid" = "$PID_1" ]      || fail "Y did not inherit the seat pid (got: $y_pid, expected $PID_1)"
[ "$y_tty" = "$TTY_NORM" ]   || fail "Y did not inherit the seat tty (got: $y_tty)"
grep -q 'seat-follow migrated' "$LAB_DAEMON_LOG" \
  || fail "no seat-follow migration logged"
note "PASS(rename): K moved X -> Y, X left keyless, seat inherited (pid $PID_1)"

# --- 3. restart the pane ----------------------------------------------------
# The MCP sessions die with the process in production, so drop both holds
# before respawning; the holder row keeps pointing at the now-dead PID_1.
kill "$HOLD_X" 2>/dev/null || true; HOLD_X=""
kill "$HOLD_Y" 2>/dev/null || true; HOLD_Y=""
sleep 0.5
# Restart the CARRIER, not the pane.  `respawn-pane -k` would be the obvious
# tool but it allocates a NEW pty (measured: /dev/ttys035 -> /dev/ttys040) while
# keeping the pane id — production keeps the pane's pty across a codex restart,
# so respawn would exercise a restart shape that never actually happens.
# Killing the child returns the pane to its shell with pane id AND tty intact.
kill "$PID_1" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$PID_1" 2>/dev/null || break; sleep 0.1; done
kill -0 "$PID_1" 2>/dev/null && fail "old carrier $PID_1 did not die; the restart precondition (dead holder pid) does not hold"
lab_tmux send-keys -t "$PANE" "$(carrier_cmd)" Enter
sleep 1.5

now_tty="$(lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty}' | awk -v p="$PANE" '$1==p{print $2}')"
[ -n "$now_tty" ] || fail "pane $PANE vanished across the restart"
[ "$now_tty" = "$TTY" ] \
  || fail "pane tty changed across the restart ($TTY -> $now_tty); the fixture is not reproducing a production codex restart"
PID_2="$(carrier_pid)"
[ -n "$PID_2" ] || fail "no codex carrier on tty $TTY_NORM after the restart"
[ "$PID_2" != "$PID_1" ] || fail "carrier pid unchanged ($PID_1); nothing actually restarted"
note "restarted: carrier pid $PID_1 -> $PID_2, pane $PANE and tty $TTY kept"

# --- 4. the launcher pre-registers again; recovery must name Y --------------
pre_register "recovery"

deadline=$((SECONDS + 60))
while [ $SECONDS -lt $deadline ]; do
  grep -q "codex-recovery delivered: pane=$PANE" "$LAB_DAEMON_LOG" && break
  sleep 1
done

grep -q "codex-recovery scheduled: pane=$PANE identity=($TEAM, $NAME_Y)" "$LAB_DAEMON_LOG" \
  || fail "recovery was not scheduled for Y; log: $(grep -c 'codex-recovery' "$LAB_DAEMON_LOG") recovery lines, last: $(grep 'codex-recovery' "$LAB_DAEMON_LOG" | tail -1)"
grep -q "codex-recovery delivered: pane=$PANE identity=($TEAM, $NAME_Y)" "$LAB_DAEMON_LOG" \
  || fail "recovery poke not delivered to Y within 60s; last: $(grep 'codex-recovery' "$LAB_DAEMON_LOG" | tail -1)"
! grep -q "identity=($TEAM, $NAME_X)" "$LAB_DAEMON_LOG" \
  || fail "recovery resolved the ABANDONED identity X: $(grep "identity=($TEAM, $NAME_X)" "$LAB_DAEMON_LOG" | tail -1)"

# The wording itself, observed in the pane rather than inferred from the log:
# the notice is what the restarted codex actually reads.  -J joins wrapped
# lines: the notice is one ~350-char line, so without it a narrow pane splits
# name="<id>" across a wrap and the match fails on layout, not on behaviour.
pane_text="$(lab_tmux capture-pane -pJ -t "$PANE")"
case "$pane_text" in
  *"name=\"$NAME_Y\""*) : ;;
  *) fail "recovery notice in the pane does not name $NAME_Y; pane tail: $(echo "$pane_text" | tr -s '\n' '|' | tail -c 300)" ;;
esac
case "$pane_text" in
  *"name=\"$NAME_X\""*) fail "recovery notice in the pane still names the OLD identity $NAME_X" ;;
esac
note "PASS(recovery): scheduled and delivered for ($TEAM, $NAME_Y); pane wording names $NAME_Y, not $NAME_X"

echo "S3 PASS"
