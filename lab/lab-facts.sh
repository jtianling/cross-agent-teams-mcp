#!/usr/bin/env bash
# Read-only daemon-side facts: what every scenario asserts on.
#
#   lab/lab-facts.sh agents           # identity rows (seat + key + generation)
#   lab/lab-facts.sh preregs          # pending pre-reg rows
#   lab/lab-facts.sh decisions [n]    # last n auto-bind / same-thread / recovery lines
#   lab/lab-facts.sh all
#
# Never writes.  The DB is opened read-only so a scenario can run this while
# the lab daemon holds the database.

source "$(dirname "${BASH_SOURCE[0]}")/lab-env.sh"
lab_guard_isolation

db="$(lab_db)"
[ -f "$db" ] || lab_die "no lab DB yet at $db (start the lab daemon first)"

q() { sqlite3 "file:$db?mode=ro" "$@"; }

agents() {
  echo "== agents (name | key | pane | ui_pid | tty | verification | generation | thread) =="
  q -header -column "
    SELECT name,
           COALESCE(identity_key,'-')            AS identity_key,
           COALESCE(tmux_pane_id,'-')            AS pane,
           COALESCE(runtime_ui_pid,'-')          AS ui_pid,
           COALESCE(runtime_tty,'-')             AS tty,
           COALESCE(runtime_verification_mode,'-') AS verification,
           register_generation                   AS gen,
           COALESCE(json_extract(delivery_payload,'\$.thread_id'),'-') AS thread
    FROM agents
    ORDER BY team, name;"
}

preregs() {
  echo "== codex_pane_pre_registrations (pane | uuid | key | expires_at) =="
  q -header -column "
    SELECT pane_id,
           xats_agent_id,
           COALESCE(identity_key,'-') AS identity_key,
           expires_at
    FROM codex_pane_pre_registrations
    ORDER BY pane_id;"
}

decisions() {
  local n="${1:-40}"
  echo "== decision log (last $n matching lines) =="
  grep -E 'same-thread decision|auto-bind|seat-follow|codex-recovery|runtime bind stale|cas drift|register invariant' \
    "$LAB_DAEMON_LOG" 2>/dev/null | tail -"$n"
}

case "${1:-all}" in
  agents) agents ;;
  preregs) preregs ;;
  decisions) decisions "${2:-40}" ;;
  all) agents; echo; preregs; echo; decisions "${2:-40}" ;;
  *) lab_die "usage: lab-facts.sh [agents|preregs|decisions [n]|all]" ;;
esac
