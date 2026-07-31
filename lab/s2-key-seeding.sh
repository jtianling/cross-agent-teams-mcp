#!/usr/bin/env bash
# S2 — key seeding: a brand-new identity_key nobody holds must attach to the
# registering caller, and that caller must bind its OWN pane/pid.
#
#   lab/s2-key-seeding.sh
#
# This is S1's B-half with the adversary removed.  Asserted on its own so a
# S1 failure can be told apart from a broken baseline: if S2 is red, the clean
# seeding path is broken and S1's verdict says nothing about claim jumping.
#
# What makes this the PRE-REG path and not the detect fallback (which would
# false-green "bound its own pane"): the row must be CONSUMED and the key must
# be ATTACHED.  The fallback consumes nothing, attaches nothing, and in fact
# refuses a pane that still carries a pending row (reason=pane_has_pending_prereg).
#
# Stub fast path, same shape as S1: the carrier is an idle `node` whose argv
# carries the `codex --remote ... -c xats.agent_id="<uuid>"` form the daemon
# probes for.  Per the joint spec every scenario still needs one real-codex
# confirmation run; this is the high-frequency regression, not the whole verdict.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

SESSION="s2"
KEY="CCCCCCCC-0000-4000-8000-00000000000C"
UUID="33333333-3333-4333-8333-33333333333C"
TEAM="lab"
NAME="agent-s2"

fail() { echo "S2 FAIL: $*" >&2; exit 1; }
note() { echo "S2: $*"; }

# A registration that silently errors would leave the DB untouched and make
# every "did not attach" assertion fail for the wrong reason — check the tool
# envelope, never discard it.
reg_hold() {
  node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent "$1" >"$2" 2>&1 &
  echo $!
}

cleanup() {
  [ -n "${HOLD:-}" ] && kill "$HOLD" 2>/dev/null || true
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

# --- lab pane with a codex-shaped foreground carrier ------------------------
lab_tmux kill-session -t "$SESSION" 2>/dev/null || true
lab_tmux new-session -d -s "$SESSION" -x 200 -y 50
sleep 0.3

read -r PANE TTY PANE_PID < <(
  lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty} #{pane_pid}'
)
[ -n "$PANE" ] || fail "no lab pane created"
# The daemon stores tty with the /dev/ prefix stripped (normalizeTty), so the
# expectation must be normalised too or the assertion fails on formatting.
TTY_NORM="${TTY#/dev/}"
note "pane: $PANE ($TTY) pane_pid=$PANE_PID"

# CARRIER SHAPE: no `exec`, so codex runs as a CHILD of the pane shell — the
# production shape, where ui_pid != pane_pid (aoe sample: pane_pid=75561 shell,
# codex child 83254, and the agents row records 83254).  An `exec`-ed carrier
# replaces the shell and makes pane_pid == ui_pid, an equality that holds ONLY
# in the lab; a fixture shaped that way lets pane_pid masquerade as the
# expected ui_pid and quietly stops covering how production actually runs.
lab_tmux send-keys -t "$PANE" \
  "node -e 'setInterval(()=>{},1e9)' -- codex --remote ws://127.0.0.1:8799 -C /lab -c 'xats.agent_id=\"$UUID\"'" Enter
sleep 1

# --- the launcher pre-registers this pane WITH a fresh key (key only via env)
XATS_IDENTITY_KEY="$KEY" node "$LAB_REPO/dist/cli.js" pre-register-codex-pane \
  --pane "$PANE" --agent-id "$UUID" --identity-key-env XATS_IDENTITY_KEY \
  --ttl 600 --port "$LAB_PORT" --token "$LAB_TOKEN" >/dev/null \
  || fail "pre-register failed"
note "pre-registered: pane=$PANE uuid=$UUID key=<env>"

db="file:$(lab_db)?mode=ro"
holders="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE identity_key='$KEY';")"
[ "$holders" = "0" ] || fail "precondition broken: key already held by $holders row(s)"

# --- act: the codex registers ----------------------------------------------
HOLD="$(reg_hold "{\"agent_type\":\"codex\",\"name\":\"$NAME\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"}}" "$OUT")"
sleep 1.5
grep -q '"error"' "$OUT" && fail "register_agent failed: $(cat "$OUT")"

rows="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE team='$TEAM' AND name='$NAME';")"
[ "$rows" = "1" ] || fail "caller never registered (rows=$rows)"

read -r got_key got_pane got_pid got_tty got_mode < <(
  sqlite3 -separator ' ' "$db" \
    "SELECT COALESCE(identity_key,'-'), COALESCE(tmux_pane_id,'-'),
            COALESCE(runtime_ui_pid,'-'), COALESCE(runtime_tty,'-'),
            COALESCE(runtime_verification_mode,'-')
     FROM agents WHERE team='$TEAM' AND name='$NAME';"
)

[ "$got_key" = "$KEY" ]      || fail "key not attached to caller (got: $got_key)"
[ "$got_tty" = "$TTY_NORM" ] || fail "caller bound tty $got_tty, expected $TTY_NORM"

# The seat is checked as THREE independent facts about the stored row, the same
# criterion the daemon-side verdict uses.  Deliberately NOT "ui_pid ==
# pane_pid": that identity only holds for an exec-shaped carrier.
#   1. a pane is bound, and it is this one
#   2. the recorded pid is actually alive
#   3. that pid really is this pane's carrier (its argv carries this uuid)
[ "$got_pane" = "$PANE" ] || fail "caller did not bind its own pane (got: $got_pane)"
[ "$got_pid" != "-" ]     || fail "caller recorded no ui_pid"
kill -0 "$got_pid" 2>/dev/null \
  || fail "recorded ui_pid $got_pid is not alive"
got_cmd="$(ps -p "$got_pid" -o command= 2>/dev/null || true)"
case "$got_cmd" in
  *"xats.agent_id=\"$UUID\""*) : ;;
  *) fail "recorded ui_pid $got_pid is not this pane's carrier (argv lacks the uuid): $got_cmd" ;;
esac

# Cross-check against an INDEPENDENT tty scan: the daemon must have picked the
# same process a plain `ps -t` finds, in whichever shape the carrier runs.
# `|| true`: with `set -e -o pipefail` a no-match grep would abort the script
# with no message at all, which reads as a mysterious silent failure instead of
# the assertion below reporting what was actually missing.
tty_carrier="$(ps -t "$TTY_NORM" -o pid=,command= 2>/dev/null \
  | grep -F "xats.agent_id=\"$UUID\"" | grep -- '--remote' | awk '{print $1}' | head -1 || true)"
[ -n "$tty_carrier" ] || fail "no codex carrier found on tty $TTY_NORM; the fixture never started"
[ "$got_pid" = "$tty_carrier" ] \
  || fail "daemon recorded ui_pid $got_pid but the carrier on tty $TTY_NORM is $tty_carrier"

left="$(sqlite3 "$db" "SELECT COUNT(*) FROM codex_pane_pre_registrations WHERE pane_id='$PANE';")"
[ "$left" = "0" ] || fail "pre-reg row not consumed (this would be the detect fallback, not the seeding path)"

# The key is unique per (device, key): a clean seeding must leave exactly one
# holder, so a duplicate attach cannot hide behind the caller's own row.
holders="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE identity_key='$KEY';")"
[ "$holders" = "1" ] || fail "expected exactly 1 key holder after seeding, got $holders"

# Nobody held the key, so no arbitration should have refused anything and no
# commit should have been rolled back.  A refusal here means the clean path is
# reaching contention logic it has no business reaching.
#
# These are PREFIX FAMILIES on purpose, not full log lines.  A negative grep
# for an exact string that the source no longer emits is silently vacuous —
# it passes forever and proves nothing.  Families survive rewording of the
# tail: every identity-key skip carries `reason=identity_key_`, and every
# attach refusal (caller_row_missing / caller_holds_different_key /
# identity_key_live_holder_conflict) is thrown and re-logged wrapped in
# `auto-bind commit rolled back: ... error=identity_key attach refused: ...`,
# so the rollback prefix covers the refusal family too.
for bad in 'reason=identity_key_' 'stage=post_verify' 'auto-bind commit rolled back' \
           'auto-bind stale runtime bind'; do
  ! grep -qF "$bad" "$LAB_DAEMON_LOG" \
    || fail "unexpected refusal/rollback in a no-contention run: $(grep -F "$bad" "$LAB_DAEMON_LOG" | tail -1)"
done

note "key attached, pane $PANE / carrier pid $got_pid (alive, argv uuid matches) / tty $TTY_NORM, row consumed"
note "verification_mode=$got_mode (recorded, not asserted — derived from the bind input)"
echo "S2 PASS"
