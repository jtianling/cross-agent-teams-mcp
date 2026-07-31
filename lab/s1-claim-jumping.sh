#!/usr/bin/env bash
# S1 / S1b — claim jumping (the 2026-07-31 production incident, minimised).
#
#   lab/s1-claim-jumping.sh            # S1:  A already holds a DIFFERENT key
#   lab/s1-claim-jumping.sh --keyless  # S1b: A holds NO key (live-holder path)
#
# Shape: two lab panes, each hosting a codex-shaped foreground carrier.
#   pane A — its own pre-reg row is ABSENT (expired in production)
#   pane B — valid pre-reg row carrying key K_B
# A registers first.  It must NOT claim B's row: B's row stays pending with
# its key, A's identity row gets no pane/pid from B, and the refusal is
# logged with the identity-key reason.  B registers afterwards and must get
# its own key and its own pane.
#
# Stub fast path (no model quota): the carrier is an idle `node` process whose
# argv carries the `codex --remote ... -c xats.agent_id="<uuid>"` shape the
# daemon probes for — same shape jt's npm shim produces.  Per the joint spec
# every scenario still needs one real-codex confirmation run; this script is
# the high-frequency regression, not the whole verdict.
#
# The carrier is started WITHOUT `exec`, so codex runs as a CHILD of the pane
# shell and ui_pid != pane_pid — the production shape (aoe sample: pane_pid
# 75561 is the shell, codex is child 83254, and the agents row records 83254).
# An `exec`-ed carrier replaces the shell and makes pane_pid == ui_pid, an
# equality that holds ONLY in the lab.  Fixtures shaped that way are how a
# whole family of gaps got in: the fixture is a little simpler than production
# and the simplification lands exactly where the decision is made.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

KEYLESS=0
[ "${1:-}" = "--keyless" ] && KEYLESS=1

SESSION="s1"
KEY_A="AAAAAAAA-0000-4000-8000-00000000000A"
KEY_B="BBBBBBBB-0000-4000-8000-00000000000B"
UUID_A="11111111-1111-4111-8111-11111111111A"
UUID_B="22222222-2222-4222-8222-22222222222B"
THREAD_A="019fb000-0000-7000-a000-00000000000a"
THREAD_B="019fb000-0000-7000-a000-00000000000b"
TEAM="lab"

fail() { echo "S1 FAIL: $*" >&2; exit 1; }
note() { echo "S1: $*"; }

# A registration that silently errors would leave the DB untouched and make
# every "did not steal" assertion pass for the wrong reason — check the tool
# envelope, never discard it.
reg() {
  local out
  out="$(node "$LAB_REPO/lab/lab-mcp.mjs" register_agent "$1" 2>&1)"
  case "$out" in
    *'"error"'*) fail "register_agent failed: $out" ;;
  esac
}

cleanup() {
  [ -n "${HOLD_A:-}" ] && kill "$HOLD_A" 2>/dev/null || true
  [ -n "${HOLD_B:-}" ] && kill "$HOLD_B" 2>/dev/null || true
  lab_tmux_kill_server 2>/dev/null || true
}
trap cleanup EXIT

curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1 \
  || fail "lab daemon is not up; run lab/start-lab-daemon.sh --fresh first"

# --- seed identities BEFORE any pane exists ---------------------------------
# Order matters: a registration with no pending pre-reg row falls through to
# the detect_tmux_pane fallback, so seeding while the lab panes already host
# carriers would bind A to a pane during FIXTURE setup and make the scenario
# assert on damage it caused itself.  In production A's row likewise predates
# today's panes.  A's own pre-reg row is deliberately never created — that is
# the incident's precondition ("caller's own row expired").
if [ "$KEYLESS" = 0 ]; then
  reg "{\"agent_type\":\"codex\",\"name\":\"agent-a\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"},\"identity_key\":\"$KEY_A\"}"
  note "seeded agent-a holding its own key"
else
  reg "{\"agent_type\":\"codex\",\"name\":\"agent-a\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"}}"
  # S1b: the row B's key belongs to must be a LIVE other identity, otherwise
  # there is no evidence at all (the honest residual documented in design.md).
  node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent \
    "{\"agent_type\":\"codex\",\"name\":\"agent-b\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"},\"identity_key\":\"$KEY_B\",\"ui_pid\":$$}" \
    >/dev/null &
  HOLD_B=$!
  sleep 0.6
  note "seeded keyless agent-a; agent-b holds K_B with a live pid"
fi

# --- lab panes (private socket, $TMUX cleared by the wrapper) ---------------
lab_tmux kill-session -t "$SESSION" 2>/dev/null || true
lab_tmux new-session -d -s "$SESSION" -x 200 -y 50
lab_tmux split-window -t "$SESSION"
sleep 0.3

mapfile -t PANES < <(lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty}')
[ "${#PANES[@]}" -ge 2 ] || fail "expected 2 lab panes, got ${#PANES[@]}"
PANE_A="${PANES[0]%% *}"; TTY_A="${PANES[0]##* }"
PANE_B="${PANES[1]%% *}"; TTY_B="${PANES[1]##* }"
note "panes: A=$PANE_A ($TTY_A)  B=$PANE_B ($TTY_B)"

# Foreground carrier per pane: argv mimics the launcher's codex invocation.
carrier() {
  local pane="$1" uuid="$2"
  lab_tmux send-keys -t "$pane" \
    "node -e 'setInterval(()=>{},1e9)' -- codex --remote ws://127.0.0.1:8799 -C /lab -c 'xats.agent_id=\"$uuid\"'" Enter
}
carrier "$PANE_A" "$UUID_A"
carrier "$PANE_B" "$UUID_B"
sleep 1

# B's launcher pre-registers its pane WITH the key (key only via env).
XATS_IDENTITY_KEY="$KEY_B" node "$LAB_REPO/dist/cli.js" pre-register-codex-pane \
  --pane "$PANE_B" --agent-id "$UUID_B" --identity-key-env XATS_IDENTITY_KEY \
  --ttl 600 --port "$LAB_PORT" --token "$LAB_TOKEN" >/dev/null \
  || fail "pre-register for pane B failed"
note "pre-registered B: pane=$PANE_B uuid=$UUID_B key=<env>"

# --- act: A registers with a NEW thread and no pre-reg row of its own ------
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent \
  "{\"agent_type\":\"codex\",\"name\":\"agent-a\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"}}" \
  >/dev/null &
HOLD_A=$!
sleep 1.5

db="file:$(lab_db)?mode=ro"
row_b="$(sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM codex_pane_pre_registrations WHERE pane_id='$PANE_B';")"
a_pane="$(sqlite3 "$db" "SELECT COALESCE(tmux_pane_id,'-') FROM agents WHERE team='$TEAM' AND name='agent-a';")"

a_rows="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE team='$TEAM' AND name='agent-a';")"
[ "$a_rows" = "1" ] || fail "A never registered (would false-green every theft assertion)"
[ "$row_b" = "$KEY_B" ] || fail "B's pre-reg row was consumed or altered by A (key column: $row_b)"
[ "$a_pane" != "$PANE_B" ] || fail "A claimed B's pane $PANE_B"
grep -qE 'reason=identity_key_(contradiction|live_holder_conflict|holder_liveness_unknown)' "$LAB_DAEMON_LOG" \
  || fail "no identity-key refusal logged for A's scan"
note "PASS(A): B's row intact, A did not take pane B — $(grep -oE 'reason=identity_key_[a-z_]+' "$LAB_DAEMON_LOG" | tail -1)"

# --- B registers and must get its own key and pane -------------------------
if [ "$KEYLESS" = 1 ]; then kill "$HOLD_B" 2>/dev/null || true; sleep 0.3; fi
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent \
  "{\"agent_type\":\"codex\",\"name\":\"agent-b\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"}}" \
  >/dev/null &
HOLD_B=$!
sleep 1.5

b_key="$(sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM agents WHERE team='$TEAM' AND name='agent-b';")"
b_pane="$(sqlite3 "$db" "SELECT COALESCE(tmux_pane_id,'-') FROM agents WHERE team='$TEAM' AND name='agent-b';")"
b_row_left="$(sqlite3 "$db" "SELECT COUNT(*) FROM codex_pane_pre_registrations WHERE pane_id='$PANE_B';")"

[ "$b_key" = "$KEY_B" ] || fail "B did not receive its own key (got: $b_key)"
[ "$b_pane" = "$PANE_B" ] || fail "B did not bind its own pane (got: $b_pane)"
[ "$b_row_left" = "0" ] || fail "B's pre-reg row was not consumed by B"
note "PASS(B): key attached, pane $PANE_B bound, row consumed"

echo "S1$([ "$KEYLESS" = 1 ] && echo b) PASS"
