# Design: surface-prereg-write-destination

## Why observability rather than a fix

The reported problem was "pane ids collide across tmux servers".  The confirmed
problem is narrower and different: **a write went somewhere nobody intended and said
nothing about it**.  The collision is downstream of that — had the lab reached its own
daemon, its `%0` would have been its own daemon's `%0` and no rows would have been
shared.

Fixing the collision without fixing the misrouting leaves the misrouting.  Fixing the
misrouting is, for the confirmed case, a fixture configuration
(`CROSS_AGENT_TEAMS_MCP_HOME`) — not something the daemon can impose.  What the daemon
*can* do is stop letting it happen silently.

## The predicate change that was drafted and withdrawn

`paneHasPendingPreReg(pane_id)` tests row existence under a bare pane id, so in
principle a foreign server's row refuses the fallback bind of the same-numbered pane on
this server.  The obvious repair is to require evidence: the row blocks only when its
`xats_agent_id` is on that pane's carrier.

It does not work, and the reason is in the requirement it would modify:

> A pending row means some launcher announced that pane for a codex that **has not
> registered yet**; had the caller been that codex, the scan above would have consumed
> the row under the uuid plus foreground-carrier proof.

The protected window is the one between the launcher's pre-registration and the
codex's own registration — and typically before `exec codex` has even replaced the
launcher shell.  In that window the pane's tty hosts the launcher's `sh`, not a codex,
so the row's uuid is **legitimately absent**.  Requiring the uuid would therefore
switch the protection off exactly when it is supposed to be on.

A foreign row and a not-yet-`exec`'d legitimate row present identically to that probe:
pane exists, no codex with that uuid.  No amount of care in the probe separates them,
because the difference is not on the pane — it is which tmux server the pane belongs
to, which is the dimension the key is missing.

So the predicate cannot be repaired without the scope key.  It stays as it is.

### On the strength of the evidence

The cross-server rows are observed.  A foreign row **blocking** an unrelated pane is
not: the `%0` / `%1` lines in the log are `no_match` from `collectCandidates`, which is
the read side declining to treat an unknown pane as a candidate — the safe outcome.

Writing a fix for the blocking harm would have meant treating "I can see a mechanism by
which this could happen" as "this happened".  That is the same error made twice already
in this investigation (a reversed inference from a zero observation, and an over-strong
attribution from an ambiguous one), and it is worth naming rather than repeating.

## What is added

Three signals, all on the write path, none load-bearing:

1. **Resolved endpoint, printed by the CLI.**  The value the CLI already computed and
   then discarded.  Host and port only — never the token, its length, or a hash of it;
   handover item 6.1 already records one way that token leaks and this must not add a
   second.
2. **Received field names, echoed by the daemon.**  Endpoint echo answers "which
   daemon"; this answers "did my arguments arrive".  The two failures are independent —
   a cached CLI build silently dropping `--identity-key-env` was a real incident, and
   `rejectUnknownPreRegisterFlags` (0.7.7) only closes the *unknown flag* form of it.
3. **Pane visibility on the daemon's own tmux server.**  The single most direct signal
   that the write and the pane are on different sides of an isolation boundary.

## Why visibility is reported and never enforced

Refusing an invisible pane would convert the lab's silent success into a loud failure at
the source, which is attractive.  It is rejected because it makes every pre-registration
depend on the daemon's own tmux resolution — and a daemon whose environment resolves a
different server is precisely the misconfiguration being detected.  Gating on the least
trustworthy input in the scenario would turn a diagnostic into an outage.

A launcher that wants strictness can read the flag and decide for itself.  That keeps
the policy on the side that has the context.

## Revisit criterion for the scope key

Adopt the socket-scoped key when a pre-`exec`-window overwrite is **observed** —
a legitimate row replaced by a foreign write, losing its `identity_key`.  At that point
scope it as socket **plus server generation** from the start: a recreated server reuses
the socket path and restarts ids at `%0`, and the repo has already been bitten by that
reissue behaviour (archived `add-codex-caller-row-correlation` task 4.3 exists to keep a
server restart from refusing a batch of legitimate relaunches).
