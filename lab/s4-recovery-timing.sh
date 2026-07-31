#!/usr/bin/env bash
# S4 — recovery segment timing: the launcher pre-registers BEFORE codex is up.
#
#   lab/s4-recovery-timing.sh [carrier-delay-seconds]   # default 12
#
# S3 already covers scheduled -> detected -> delivered, but its carrier is
# already running when the row lands, so the whole chain collapses into ~3.6s
# (detected at +62ms) and no segment is separable.  S4 is the PRODUCTION shape:
# the launcher pre-registers the pane and codex boots afterwards, so the
# schedule has to poll across a real gap.  That makes three things measurable
# that S3 cannot measure at all:
#
#   1. scheduled -> detected  spans the whole boot gap (proves the schedule
#      actually waited for the carrier instead of matching something already
#      there).
#   2. detected -> delivered  is floored by the 2s quiet guard.
#   3. the gap itself stays SILENT.  "codex not up yet" polling deliberately
#      logs nothing (only infrastructure errors log, once per stage per
#      generation).  A regression that logs per interval would flood a daemon
#      log every 5s for the whole boot of every codex, so the absence of lines
#      is a real property, asserted here rather than assumed.
#
# The holder is seeded WITHOUT a runtime: a pid-less holder is exactly the
# "liveness unknown" state that must still schedule recovery (a missing pid
# never proves the identity is alive elsewhere).  Seeding happens before the
# pane exists so the seed cannot bind a pane through the detect fallback and
# assert on damage it caused itself — same ordering rule as S1.
#
# Stub carrier shape and the "key only via env, never argv" rule are S1's.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

SESSION="s4"
KEY="EEEEEEEE-0000-4000-8000-00000000000E"
UUID="55555555-5555-4555-8555-55555555555E"
TEAM="lab"
NAME="agent-s4"
# >= 2 probe intervals (RECOVERY_PROBE_INTERVAL_MS = 5s), so the gap cannot be
# mistaken for a single scheduling hiccup.
DELAY="${1:-12}"
QUIET_GUARD_MS=2000

fail() { echo "S4 FAIL: $*" >&2; exit 1; }
note() { echo "S4: $*"; }

cleanup() {
  lab_tmux_kill_server 2>/dev/null || true
  rm -f "$OUT"
}
trap cleanup EXIT

OUT="$(mktemp)"

curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1 \
  || fail "lab daemon is not up; run lab/start-lab-daemon.sh --fresh first"
# A healthy port only proves some daemon is there.  On 2026-07-31 a second
# lab took this port and every call in this scenario went to its daemon.
lab_guard_port_owner

rec_count() { grep -c 'codex-recovery' "$LAB_DAEMON_LOG" || true; }

# Epoch ms of the first recovery line matching $1.  Every recovery line carries
# an ISO timestamp emitted by the daemon itself, so the timing measured here is
# the daemon's, not this script's polling resolution.
ts_of() {
  local line
  line="$(grep -m1 -F "$1" "$LAB_DAEMON_LOG")" || return 1
  node -e 'const m=process.argv[1].match(/^\[([^\]]+)\]/);if(!m)process.exit(1);
           const t=Date.parse(m[1]);if(!Number.isFinite(t))process.exit(1);
           process.stdout.write(String(t))' "$line"
}

# --- seed the holder BEFORE any pane exists ---------------------------------
out="$(node "$LAB_REPO/lab/lab-mcp.mjs" register_agent \
  "{\"agent_type\":\"codex\",\"name\":\"$NAME\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"},\"identity_key\":\"$KEY\"}" 2>&1)"
case "$out" in *'"error"'*) fail "seed register_agent failed: $out" ;; esac

db="file:$(lab_db)?mode=ro"
seed_pid="$(sqlite3 "$db" "SELECT COALESCE(runtime_ui_pid,'-') FROM agents WHERE team='$TEAM' AND name='$NAME';")"
[ "$seed_pid" = "-" ] \
  || fail "seed bound a runtime pid ($seed_pid); it must stay pid-less or recovery would skip as holder_alive"
note "seeded pid-less holder ($TEAM, $NAME) holding K"

# --- pane with NO codex carrier yet -----------------------------------------
lab_tmux kill-session -t "$SESSION" 2>/dev/null || true
lab_tmux new-session -d -s "$SESSION" -x 200 -y 50
sleep 0.3
read -r PANE TTY < <(lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty}')
[ -n "$PANE" ] || fail "no lab pane created"
note "pane $PANE ($TTY) up, running only a shell"

# --- the launcher pre-registers while codex is still booting ----------------
XATS_IDENTITY_KEY="$KEY" node "$LAB_REPO/dist/cli.js" pre-register-codex-pane \
  --pane "$PANE" --agent-id "$UUID" --identity-key-env XATS_IDENTITY_KEY \
  --ttl 600 --port "$LAB_PORT" --token "$LAB_TOKEN" >/dev/null \
  || fail "pre-register failed"

for _ in $(seq 1 30); do
  grep -q "codex-recovery scheduled: pane=$PANE" "$LAB_DAEMON_LOG" && break
  sleep 0.2
done
grep -q "codex-recovery scheduled: pane=$PANE identity=($TEAM, $NAME)" "$LAB_DAEMON_LOG" \
  || fail "recovery was not scheduled for the pid-less holder; last: $(grep 'codex-recovery' "$LAB_DAEMON_LOG" | tail -1)"
note "scheduled; now polling across a ${DELAY}s boot gap with no carrier"

# --- the gap: polling must find nothing and stay silent ---------------------
sleep "$DELAY"

grep -q "codex-recovery detected: pane=$PANE" "$LAB_DAEMON_LOG" \
  && fail "detected a carrier during the gap, but none was started"
grep -q "codex-recovery delivered: pane=$PANE" "$LAB_DAEMON_LOG" \
  && fail "delivered a poke with no codex running — it would have landed in the shell"

gap_lines="$(rec_count)"
[ "$gap_lines" = "1" ] \
  || fail "polling logged $gap_lines recovery lines across ${DELAY}s; expected exactly 1 (the schedule). \
Per-interval logging would flood the daemon log for the whole boot of every codex: $(grep 'codex-recovery' "$LAB_DAEMON_LOG" | tail -3)"
note "PASS(gap): ${DELAY}s of polling produced no detection and exactly 1 log line"

# --- codex finally boots ----------------------------------------------------
carrier_start="$(node -e 'process.stdout.write(String(Date.now()))')"
# CARRIER SHAPE — this is the HAND-LAUNCHED class, not aoe's.  An interactive
# shell plus `send-keys` leaves the shell in place with codex as its CHILD
# (ui_pid != pane_pid); that is how a human, or a `resume`, starts one.  aoe's
# production bootstrap is a NON-INTERACTIVE `sh -c ... exec codex`: the shell is
# replaced, so codex itself is the process-group leader (pid === pgid) and there
# is no shell in between.  Carrier collapse requires one of the matches to BE
# that leader, and an interactive shell hands every job its own process group —
# so this fixture always has a leader, whatever it launches.  The production
# bootstrap is therefore KNOWN-UNCOVERED here, not verified-equivalent.
lab_tmux send-keys -t "$PANE" \
  "node -e 'setInterval(()=>{},1e9)' -- codex --remote ws://127.0.0.1:8799 -C /lab -c 'xats.agent_id=\"$UUID\"'" Enter

deadline=$((SECONDS + 60))
while [ $SECONDS -lt $deadline ]; do
  grep -q "codex-recovery delivered: pane=$PANE" "$LAB_DAEMON_LOG" && break
  sleep 1
done
grep -q "codex-recovery delivered: pane=$PANE identity=($TEAM, $NAME)" "$LAB_DAEMON_LOG" \
  || fail "no delivery within 60s of the carrier starting; last: $(grep 'codex-recovery' "$LAB_DAEMON_LOG" | tail -1)"

# --- segment timing ---------------------------------------------------------
t_sched="$(ts_of "codex-recovery scheduled: pane=$PANE")"   || fail "cannot parse scheduled timestamp"
t_det="$(ts_of "codex-recovery detected: pane=$PANE")"      || fail "cannot parse detected timestamp"
t_del="$(ts_of "codex-recovery delivered: pane=$PANE")"     || fail "cannot parse delivered timestamp"

seg_boot=$((t_det - t_sched))
seg_guard=$((t_del - t_det))
after_start=$((t_det - carrier_start))

# The whole point of the scenario: detection happened because the carrier
# appeared, not because something was already matching.
[ "$seg_boot" -ge $((DELAY * 1000)) ] \
  || fail "scheduled -> detected was ${seg_boot}ms, shorter than the ${DELAY}s gap; detection did not wait for the carrier"
[ "$after_start" -ge 0 ] \
  || fail "detected ${after_start}ms BEFORE the carrier was started; the detection is not of this carrier"
# Nothing may be written before the quiet window has actually elapsed.
[ "$seg_guard" -ge "$QUIET_GUARD_MS" ] \
  || fail "detected -> delivered was ${seg_guard}ms, under the ${QUIET_GUARD_MS}ms quiet guard; the guard was skipped"

# One schedule, one delivery: a duplicate poke would paste the notice twice.
[ "$(grep -c "codex-recovery scheduled: pane=$PANE" "$LAB_DAEMON_LOG")" = "1" ] \
  || fail "more than one schedule for $PANE"
[ "$(grep -c "codex-recovery delivered: pane=$PANE" "$LAB_DAEMON_LOG")" = "1" ] \
  || fail "poke delivered more than once"

note "PASS(timing): scheduled -> detected ${seg_boot}ms (gap ${DELAY}s), detected -> delivered ${seg_guard}ms (guard floor ${QUIET_GUARD_MS}ms)"
note "detected ${after_start}ms after the carrier started"
echo "S4 PASS"
