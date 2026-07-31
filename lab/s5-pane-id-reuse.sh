#!/usr/bin/env bash
# S5 — pane id reuse strands the key handle; it must NOT hand it to a stranger.
#
#   lab/s5-pane-id-reuse.sh
#
# tmux pane ids come from a per-SERVER counter, so they are unique only for as
# long as that server lives.  Restart the server and allocation begins at %0
# again (verified as a precondition below, not assumed).  A pre-reg row is
# keyed on the pane id, so after a tmux restart a row still pointing at "%0"
# can line up with a pane that has nothing to do with the codex it was minted
# for.  The row carries the launcher-minted identity_key — the only handle to
# that identity — so the question this scenario settles is what happens to that
# handle when its pane id is recycled under it.
#
# Required behaviour: the key goes to NOBODY.  The stranger now sitting on %0
# must not consume the row, must not receive the key, and must not even bind
# the pane (a pane carrying a live pre-reg row is off limits to the detect
# fallback).  The row stays pending with its key intact — orphaned until it
# expires, which is the safe end state: an orphaned handle costs one stranded
# identity, a mis-handed one gives a stranger another agent's identity.
#
# The uuid is what keeps them apart: the row records the agent id the launcher
# minted, and a carrier only matches when that uuid is in its argv.  The
# stranger's argv carries a different one.
#
# Deliberately NOT covered here: that the rightful owner can still claim the
# row afterwards.  That is exactly S2 (matching uuid -> row consumed, key
# attached, own pane bound) and duplicating it here would add no coverage.
#
# Stub carrier shape and the "key only via env, never argv" rule are S1's.
#
# ============================================================================
# READ THIS BEFORE EDITING: this is the ONLY lab scenario that kills a tmux
# server in its main body (every other script only does it in cleanup).
#
#   WHY it must:      pane ids come from a per-server counter, so recycling an
#                     id REQUIRES restarting the server.  There is no other way
#                     to reproduce the condition this scenario exists for.
#   WHAT gets killed: only the lab's private server, reached through
#                     lab_tmux_kill_server -> `tmux -S $LAB/tmuxtmp/.../default`
#                     with $TMUX and $TMUX_PANE cleared.
#   WHAT MUST NOT:    never a bare `tmux kill-server`, never the shared server.
#                     jt runs dozens of live sessions on the shared server and
#                     it has been wiped twice by exactly this mistake.  Setting
#                     TMUX_TMPDIR alone is NOT isolation: with $TMUX set the
#                     client talks to the CURRENT server and ignores it.
#
# If you are changing this file, keep every teardown going through
# lab_tmux_kill_server / lab_tmux.  Do not "simplify" it to a bare tmux call.
# ============================================================================

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

KEY="FFFFFFFF-0000-4000-8000-00000000000F"
UUID_OWNER="66666666-6666-4666-8666-66666666666F"
UUID_STRANGER="77777777-7777-4777-8777-777777777770"
TEAM="lab"
NAME="agent-stranger"

fail() { echo "S5 FAIL: $*" >&2; exit 1; }
note() { echo "S5: $*"; }

cleanup() {
  [ -n "${HOLD:-}" ] && kill "$HOLD" 2>/dev/null || true
  lab_tmux_kill_server 2>/dev/null || true
  rm -f "$OUT"
}
trap cleanup EXIT

OUT="$(mktemp)"

curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1 \
  || fail "lab daemon is not up; run lab/start-lab-daemon.sh --fresh first"

# No `exec`: codex runs as a CHILD of the pane shell, the production shape
# (ui_pid != pane_pid).  See s2-key-seeding.sh for why the exec form is unsafe
# to standardise on.
carrier() {  # $1 = pane, $2 = uuid
  lab_tmux send-keys -t "$1" \
    "node -e 'setInterval(()=>{},1e9)' -- codex --remote ws://127.0.0.1:8799 -C /lab -c 'xats.agent_id=\"$2\"'" Enter
}

db="file:$(lab_db)?mode=ro"

# --- tmux server #1: the pane the key was minted for ------------------------
lab_tmux kill-server 2>/dev/null || true
sleep 0.3
lab_tmux new-session -d -s s5a -x 200 -y 50
sleep 0.3
PANE_1="$(lab_tmux list-panes -t s5a -F '#{pane_id}' | head -1)"
[ -n "$PANE_1" ] || fail "no pane on tmux server #1"
carrier "$PANE_1" "$UUID_OWNER"
sleep 1

XATS_IDENTITY_KEY="$KEY" node "$LAB_REPO/dist/cli.js" pre-register-codex-pane \
  --pane "$PANE_1" --agent-id "$UUID_OWNER" --identity-key-env XATS_IDENTITY_KEY \
  --ttl 600 --port "$LAB_PORT" --token "$LAB_TOKEN" >/dev/null \
  || fail "pre-register failed"
note "server #1: pane $PANE_1 holds the row for the owner uuid, key <env>"

# --- the tmux server dies; the row outlives the pane it names ---------------
lab_tmux_kill_server 2>/dev/null || true
sleep 0.5

row_key="$(sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM codex_pane_pre_registrations WHERE pane_id='$PANE_1';")"
[ "$row_key" = "$KEY" ] \
  || fail "the row did not survive the tmux restart (key column: $row_key); nothing left to orphan"

# --- tmux server #2: a DIFFERENT codex lands on the recycled id ------------
lab_tmux new-session -d -s s5b -x 200 -y 50
sleep 0.3
PANE_2="$(lab_tmux list-panes -t s5b -F '#{pane_id}' | head -1)"
# The whole scenario rests on the id actually being recycled.  If tmux ever
# stops restarting the counter, every assertion below would pass while testing
# nothing at all — so this is a hard precondition, not an observation.
[ "$PANE_2" = "$PANE_1" ] \
  || fail "pane id was NOT recycled ($PANE_1 -> $PANE_2); the scenario's precondition does not hold"
carrier "$PANE_2" "$UUID_STRANGER"
sleep 1
note "server #2: pane id $PANE_2 recycled, now hosting an UNRELATED codex"

# --- act: the stranger registers -------------------------------------------
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent \
  "{\"agent_type\":\"codex\",\"name\":\"$NAME\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"}}" \
  >"$OUT" 2>&1 &
HOLD=$!
sleep 2
grep -q '"error"' "$OUT" && fail "stranger register_agent failed: $(cat "$OUT")"

rows="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE team='$TEAM' AND name='$NAME';")"
[ "$rows" = "1" ] \
  || fail "the stranger never registered (rows=$rows); every 'did not take it' assertion below would pass for the wrong reason"

s_key="$(sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM agents WHERE team='$TEAM' AND name='$NAME';")"
s_pane="$(sqlite3 "$db" "SELECT COALESCE(tmux_pane_id,'-') FROM agents WHERE team='$TEAM' AND name='$NAME';")"
[ "$s_key" = "-" ]  || fail "the stranger received the recycled pane's key (got: $s_key)"
[ "$s_pane" = "-" ] || fail "the stranger bound pane $s_pane, which still carries a live pre-reg row"

# --- the handle is orphaned, not transferred and not destroyed --------------
left="$(sqlite3 "$db" "SELECT COUNT(*) FROM codex_pane_pre_registrations WHERE pane_id='$PANE_1';")"
row_key_after="$(sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM codex_pane_pre_registrations WHERE pane_id='$PANE_1';")"
row_uuid_after="$(sqlite3 "$db" "SELECT COALESCE(xats_agent_id,'-') FROM codex_pane_pre_registrations WHERE pane_id='$PANE_1';")"
holders="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE identity_key='$KEY';")"

[ "$left" = "1" ]                     || fail "the row was consumed by the stranger"
[ "$row_key_after" = "$KEY" ]         || fail "the row's key changed (got: $row_key_after)"
[ "$row_uuid_after" = "$UUID_OWNER" ] || fail "the row's uuid was rewritten to $row_uuid_after"
[ "$holders" = "0" ]                  || fail "somebody ended up holding the orphaned key ($holders holder(s))"

# Both refusal stages, because the outcome alone cannot tell "the scan ran and
# rejected the row on its uuid" apart from "the scan never looked".  The first
# line proves the row WAS considered and the uuid is what kept them apart; the
# second proves the fallback then refused the pane for carrying a live row.
grep -q "reason=no_match" "$LAB_DAEMON_LOG" \
  || fail "no uuid-mismatch refusal logged; the pre-reg scan may not have considered the row at all"
grep -q 'reason=pane_has_pending_prereg' "$LAB_DAEMON_LOG" \
  || fail "the fallback did not refuse the pane on its live pre-reg row"

note "PASS: key went to nobody — stranger keyless and unbound, row still pending with the owner's uuid+key"
echo "S5 PASS"
