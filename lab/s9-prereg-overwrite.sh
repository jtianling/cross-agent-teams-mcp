#!/usr/bin/env bash
# S9 — a stranger's pre-registration overwrites a pending row on someone
# else's pane, and takes the launcher-minted identity_key with it.
#
#   lab/s9-prereg-overwrite.sh            # attack order:  launcher first, stranger second
#   lab/s9-prereg-overwrite.sh --reverse  # healing order: stranger first, launcher second
#   lab/s9-prereg-overwrite.sh --keep-key # the state a COALESCE fix would leave
#   lab/s9-prereg-overwrite.sh --drop-key # same sequence under TODAY's behaviour
#
# Why this scenario exists.  S8 measured that a `--remote` codex reads its
# $TMUX_PANE from the app-server's environment, so the value it reads is a
# real pane id that belongs to somebody else, and that calling
# `pre_register_codex_pane` with it is NOT refused.  What S8 could not reach is
# what that unrefused call does to the row already sitting on that pane: by the
# time the stranger called, the victim had already registered and its row was
# consumed.  The dangerous window is the other one — the victim's launcher has
# pre-registered but its codex has not come up yet, which is exactly the state
# every restart passes through.
#
# The storage shape that makes this sharp: `pane_id` is the PRIMARY KEY and the
# upsert assigns `identity_key = excluded.identity_key` unconditionally (not
# COALESCE), so a call that omits the key does not leave the old one in place —
# it writes NULL over it.  And that row is the only carrier of the key.
#
# Accident and attack are the same action here: the tool description tells the
# caller to pass `$TMUX_PANE`, and the value a `--remote` codex reads there
# points at another pane.  A perfectly obedient codex walks this path by itself.
#
# The assertions below encode what MUST hold for the victim, so a red here is a
# product finding, not a broken fixture.  Do not weaken them to make it green.
#
# All stubs: the question is entirely daemon-side, so no real codex is needed.
# Stub carrier shape and the "key only via env, never argv" rule are S1's.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

MODE="${1:-attack}"
case "$MODE" in
  attack|--reverse|--keep-key|--drop-key) ;;
  *) echo "S9: unknown mode $MODE" >&2; exit 2 ;;
esac
REVERSE=0
[ "$MODE" = "--reverse" ] && REVERSE=1

SESSION="s9"
KEY_B="99999999-0000-4000-8000-0000000000B9"
UUID_B="9B9B9B9B-9999-4999-8999-99999999999B"
UUID_A="9A9A9A9A-9999-4999-8999-99999999999A"
TEAM="lab"
NAME_B="agent-victim"

fail() { echo "S9 FAIL: $*" >&2; exit 1; }
note() { echo "S9: $*"; }

cleanup() {
  [ -n "${HOLD_B:-}" ] && kill "$HOLD_B" 2>/dev/null || true
  lab_tmux_kill_server 2>/dev/null || true
  rm -f "$OUT"
}
trap cleanup EXIT

OUT="$(mktemp)"

curl -fsS "http://127.0.0.1:$LAB_PORT/health" >/dev/null 2>&1 \
  || fail "lab daemon is not up; run lab/start-lab-daemon.sh --fresh first"

db="file:$(lab_db)?mode=ro"
row_uuid() { sqlite3 "$db" "SELECT COALESCE(xats_agent_id,'-') FROM codex_pane_pre_registrations WHERE pane_id='$PANE';"; }
row_key()  { sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM codex_pane_pre_registrations WHERE pane_id='$PANE';"; }

# The victim's launcher call: key travels in the environment, never in argv.
launcher_prereg() {
  XATS_IDENTITY_KEY="$KEY_B" node "$LAB_REPO/dist/cli.js" pre-register-codex-pane \
    --pane "$PANE" --agent-id "$UUID_B" --identity-key-env XATS_IDENTITY_KEY \
    --ttl 600 --port "$LAB_PORT" --token "$LAB_TOKEN" >/dev/null \
    || fail "victim's launcher pre-registration failed"
}

# The stranger's call: the MCP tool a model can reach, with the pane id it read
# and NO key — a model has no key to pass (that is the whole point of the
# pre-registration channel).
stranger_prereg() {
  node "$LAB_REPO/lab/lab-mcp.mjs" pre_register_codex_pane \
    "{\"pane_id\":\"$PANE\",\"xats_agent_id\":\"$UUID_A\",\"ttl_seconds\":600}" > "$OUT" 2>&1
  echo "stranger's call returned: $(cat "$OUT")"
}

# --- the victim's pane, carrier already up ---------------------------------
lab_tmux kill-session -t "$SESSION" 2>/dev/null || true
lab_tmux new-session -d -s "$SESSION" -x 200 -y 50
sleep 0.3
read -r PANE TTY < <(lab_tmux list-panes -t "$SESSION" -F '#{pane_id} #{pane_tty}')
[ -n "$PANE" ] || fail "no lab pane created"
# No `exec`: codex runs as a CHILD of the pane shell, the production shape.
lab_tmux send-keys -t "$PANE" \
  "node -e 'setInterval(()=>{},1e9)' -- codex --remote ws://127.0.0.1:8799 -C /lab -c 'xats.agent_id=\"$UUID_B\"'" Enter
sleep 1
note "victim pane $PANE ($TTY) hosting the victim's carrier"

# --- what a COALESCE fix would leave behind, and what today leaves behind ----
# The proposed fix ("a keyless upsert must not clear an existing key") turns the
# stranger's row into (stranger's uuid, VICTIM's key).  Nothing today produces
# that combination, so it has to be constructed: the stranger's call here passes
# the key explicitly.  That is NOT an attack a model could run — it has no way
# to learn the key — it is a stand-in for the row state the fix would create.
# --drop-key runs the identical sequence under today's behaviour, so the only
# difference between the two runs is whether the key survived on the row.
#
# The sequence continues past the overwrite: the pane is respawned hosting the
# STRANGER's carrier.  That is what makes the combination matter — a pane that
# changes hands is ordinary (aoe's shift+C, a launcher restarting a pane for a
# different agent), and it is the one condition under which the pre-reg scan
# will match the stranger's uuid and consume the row.  Whatever key is on that
# row at that moment is handed to whoever matched it.
if [ "$MODE" = "--keep-key" ] || [ "$MODE" = "--drop-key" ]; then
  launcher_prereg
  [ "$(row_key)" = "$KEY_B" ] || fail "precondition: victim's key not on the row (key: $(row_key))"

  if [ "$MODE" = "--keep-key" ]; then
    node "$LAB_REPO/lab/lab-mcp.mjs" pre_register_codex_pane \
      "{\"pane_id\":\"$PANE\",\"xats_agent_id\":\"$UUID_A\",\"identity_key\":\"$KEY_B\",\"ttl_seconds\":600}" \
      > "$OUT" 2>&1
    note "stranger's call (key preserved, simulating the COALESCE fix): $(cat "$OUT")"
    [ "$(row_key)" = "$KEY_B" ] \
      || fail "could not construct the post-fix state: key is $(row_key), wanted the victim's key"
  else
    note "$(stranger_prereg)"
    [ "$(row_key)" = "-" ] \
      || fail "expected today's behaviour to clear the key, but the row still carries $(row_key)"
  fi
  [ "$(row_uuid)" = "$UUID_A" ] || fail "the row does not carry the stranger's uuid (got: $(row_uuid))"
  note "row is now uuid=$(row_uuid) key=$(row_key)"

  # the pane changes hands: it now hosts the STRANGER's carrier
  lab_tmux respawn-pane -k -t "$PANE" \
    "node -e 'setInterval(()=>{},1e9)' -- codex --remote ws://127.0.0.1:8799 -C /lab -c 'xats.agent_id=\"$UUID_A\"'"
  sleep 1.5
  note "pane $PANE respawned; it now hosts the stranger's carrier ($UUID_A)"

  node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent \
    "{\"agent_type\":\"codex\",\"name\":\"agent-stranger\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"}}" \
    >/dev/null 2>&1 &
  HOLD_B=$!
  sleep 2

  rows="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE team='$TEAM' AND name='agent-stranger';")"
  [ "$rows" = "1" ] || fail "the stranger never registered (rows=$rows); the assertion below would pass for the wrong reason"
  s_key="$(sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM agents WHERE team='$TEAM' AND name='agent-stranger';")"
  s_pane="$(sqlite3 "$db" "SELECT COALESCE(tmux_pane_id,'-') FROM agents WHERE team='$TEAM' AND name='agent-stranger';")"
  left="$(sqlite3 "$db" "SELECT COUNT(*) FROM codex_pane_pre_registrations WHERE pane_id='$PANE';")"
  note "stranger ended with key=$s_key pane=$s_pane; row(s) left on the pane: $left"

  [ "$s_key" != "$KEY_B" ] \
    || fail "the stranger was handed the VICTIM's identity_key ($s_key) — \
the row carried the victim's key and the stranger's uuid, and the scan hands the row's key \
to whoever matches its uuid; the victim's restart-recovery handle now belongs to somebody else"
  note "PASS($MODE): the stranger did not receive the victim's key (it got: $s_key)"
  echo "S9 $MODE PASS"
  exit 0
fi

if [ "$REVERSE" = 1 ]; then
  # ---- healing order: stranger lands first, the launcher runs afterwards ---
  note "$(stranger_prereg)"
  [ "$(row_uuid)" = "$UUID_A" ] \
    || fail "the stranger's row is not on the pane (uuid: $(row_uuid)); nothing to heal from"
  launcher_prereg
  after_uuid="$(row_uuid)"; after_key="$(row_key)"
  [ "$after_uuid" = "$UUID_B" ] \
    || fail "the launcher did not reclaim the pane (uuid still $after_uuid) — the damage has no self-healing boundary"
  [ "$after_key" = "$KEY_B" ] \
    || fail "the launcher reclaimed the pane but the key is $after_key — the identity handle is still lost"
  note "PASS(reverse): a later launcher call overwrites the stranger's row back, key restored"
  echo "S9 --reverse PASS"
  exit 0
fi

# ---- attack order: the launcher has run, the victim's codex is not up yet --
launcher_prereg
[ "$(row_uuid)" = "$UUID_B" ] || fail "precondition: victim's row missing (uuid: $(row_uuid))"
[ "$(row_key)" = "$KEY_B" ]   || fail "precondition: victim's key not on the row (key: $(row_key))"
note "victim's launcher pre-registered $PANE with its key; victim's codex has NOT registered yet"

note "$(stranger_prereg)"

after_uuid="$(row_uuid)"; after_key="$(row_key)"
note "row after the stranger's call: uuid=$after_uuid key=$after_key"

# The identity_key is the only handle that survives a restart.  Losing it costs
# the victim its recovery path, and nothing else carries it.
[ "$after_key" = "$KEY_B" ] \
  || fail "the stranger's keyless call wiped the victim's identity_key (now: $after_key) — \
that row was the only carrier of the key, so the victim's restart-recovery handle is gone for good"
[ "$after_uuid" = "$UUID_B" ] \
  || fail "the stranger's call took over the victim's pending row (uuid now $after_uuid) — \
the victim's own registration will find a row carrying someone else's uuid"

# --- the victim's codex finally comes up and registers ---------------------
node "$LAB_REPO/lab/lab-mcp.mjs" --hold register_agent \
  "{\"agent_type\":\"codex\",\"name\":\"$NAME_B\",\"team\":\"$TEAM\",\"delivery\":{\"kind\":\"none\"}}" \
  >/dev/null 2>&1 &
HOLD_B=$!
sleep 2

rows="$(sqlite3 "$db" "SELECT COUNT(*) FROM agents WHERE team='$TEAM' AND name='$NAME_B';")"
[ "$rows" = "1" ] || fail "the victim never registered (rows=$rows); every assertion below would pass for the wrong reason"

got_key="$(sqlite3 "$db" "SELECT COALESCE(identity_key,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_B';")"
got_pane="$(sqlite3 "$db" "SELECT COALESCE(tmux_pane_id,'-') FROM agents WHERE team='$TEAM' AND name='$NAME_B';")"
left="$(sqlite3 "$db" "SELECT COUNT(*) FROM codex_pane_pre_registrations WHERE pane_id='$PANE';")"

[ "$got_key" = "$KEY_B" ] \
  || fail "the victim registered without its key (got: $got_key) — decision log: $(grep -oE 'reason=[a-z_]+' "$LAB_DAEMON_LOG" | tail -2 | tr '\n' ' ')"
[ "$got_pane" = "$PANE" ] \
  || fail "the victim did not bind its own pane (got: $got_pane) — decision log: $(grep -oE 'reason=[a-z_]+' "$LAB_DAEMON_LOG" | tail -2 | tr '\n' ' ')"
[ "$left" = "0" ] || fail "the victim's row was not consumed ($left left)"

note "PASS: the victim kept its key and its pane despite the stranger's call"
echo "S9 PASS"
