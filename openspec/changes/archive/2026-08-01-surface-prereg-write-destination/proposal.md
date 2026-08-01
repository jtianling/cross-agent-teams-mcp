# Proposal: surface-prereg-write-destination

## Why

A pre-registration can be authenticated, succeed, and have gone to a daemon nobody
intended.  Measured 2026-08-01: the e2e lab runs its panes under a private tmux socket
(`tmux -L <label>`, with `TMUX` and `TMUX_PANE` cleared) and its pre-registrations
landed in the **production** database.

A private tmux socket isolates **tmux**, not **xats**.  With no `--port` and no
`--token`, `pre-register-codex-pane` resolves the endpoint from
`defaultHome()/daemon.pid` — and `CROSS_AGENT_TEAMS_MCP_HOME` was unset, so that is
`~/.cross-agent-teams-mcp` — then authenticates with the inherited
`CROSS_AGENT_TEAMS_MCP_TOKEN`.  Given those three inputs the destination is not
probabilistic; it is the only branch (`src/cli.ts:90-103`, `:184`).

The call returned `{"ok":true}`.  Nothing in the output named the endpoint, so nothing
on either side had a signal.  The rows were found days later, from the other end, while
investigating an unrelated identity-recovery failure.

The rows also collided: a private server reissues pane ids from `%0`, and
`codex_pane_pre_registrations.pane_id` is a bare `TEXT PRIMARY KEY`, so the lab's `%0`
and `%1` shared rows with the operator's own claude pane and the reviewer pane on the
default server.  That hazard is **recorded here and not fixed** — see below for why the
obvious fix is wrong.

## What Changes

- **The CLI prints the endpoint it resolved.**  `host:port`, so a misrouted call is
  visible at the call site instead of in someone else's recovery failure a week later.
- **The response echoes the field names the daemon received.**  Endpoint echo alone
  cannot show an argument that was dropped in transit; this can.
- **The response reports whether the named `pane_id` is visible to the daemon on its
  own tmux server** — reported, never enforced.  The lab call would have come back
  `pane_visible:false` against endpoint `127.0.0.1:9100` and been diagnosed at once.

Deliberately NOT in scope:

- **No scoping of `pane_id`.**  Only the launcher knows the tmux socket, so a scoped
  key means a new required flag, an aoe bootstrap change, and an npx cache refresh on
  every machine; rows from older launchers would carry a NULL scope and keep colliding
  throughout the transition.  A socket path is also insufficient on its own — a
  destroyed and recreated server reuses the path and restarts ids at `%0`, so it would
  have to be socket **plus** a server generation.  Revisit criterion in design.md.

- **No rejection of writes for panes the daemon cannot see.**  It would make the write
  depend on the daemon's own tmux resolution, which is exactly what is misconfigured in
  the case being detected.  A diagnostic that can misfire must not be load-bearing.

- **No change to `paneHasPendingPreReg`.**  An earlier draft of this change made that
  predicate evidence-based — a row would block a pane only when the row's uuid was on
  that pane's carrier — to stop a foreign server's row refusing an unrelated pane's
  fallback bind.  **That is wrong, and the draft is recorded here so it is not
  re-proposed.**  The existing rule protects the window in which a launcher has
  announced a pane whose codex *has not started yet*; the spec says so in as many
  words ("a pending row means some launcher announced that pane for a codex that has
  not registered yet").  In that window the uuid is legitimately absent from the pane,
  so requiring it would void the protection precisely where it is meant to apply.  A
  foreign row and a not-yet-exec'd launch are indistinguishable by that test.

  It is also worth being exact about the evidence: the cross-server rows were observed,
  but **no instance of a foreign row blocking an unrelated pane was observed**.  The
  `%0` / `%1` log lines are `no_match` from the candidate scan, which is the read side
  handling the collision safely.  The blocking harm is inferred from the code, and
  inferring a harm from a mechanism one happens to be holding is the error this
  investigation already made twice.

## Capabilities

### Modified Capabilities

- `agent-registry`: `pre_register_codex_pane` reports what it received and whether the
  named pane is visible to the daemon; the CLI reports the endpoint it resolved.

## Impact

- `src/mcp/pre-register-codex-pane.ts` — success result gains the echoed fields and the
  visibility flag.
- `src/cli.ts` — `runPreRegisterCodexPane` prints the resolved endpoint.
- Schema unchanged.  No behavioural change to binding, scanning or refusal.
- **Token discipline**: the endpoint report carries host and port only — no token, no
  length, no hash.  The archived handover item 6.1 records that
  `CROSS_AGENT_TEAMS_MCP_TOKEN` is already readable by anything that can read the
  app-server environment; this must not add a second exposure.
- **Left open**: the cross-server `pane_id` collision, and with it the pre-`exec`
  window in which a foreign write can overwrite a legitimate row and take its
  `identity_key`.  The existing write-side arbitration (`refuseReason`) already covers
  the case where the incumbent row's own carrier is running, so the exposure is the gap
  before `exec codex`.
