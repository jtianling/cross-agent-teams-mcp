# Design: fix-seat-follow-tty-seat-key

## What the dead-holder branch actually needs

Its premise, stated in the code: *this is the same pane, restarted; the old process is
gone, so the key should follow.*  For that to be safe, "same pane" must be provable.

Three identifiers are in play, and only one means what the branch needs:

| identifier | reused? | proves |
|---|---|---|
| `runtime_ui_pid` | on pid wraparound | the same **process** |
| `runtime_tty` | **yes, routinely** | nothing durable |
| `tmux_pane_id` | never within a server | the same **pane** |

The branch wants the third and is given the second.

And it is given only the second: matching on pid means the holder's pid equals the
caller's own live carrier pid, so the liveness re-check returns ALIVE and the
thread-authorized branch handles it.  The dead branch is, in practice, the tty branch.

## Why the pane id is not already used

It is available at bind time and then deliberately destroyed.  Pane binding is
exclusive per device: whenever a runtime-binding path writes `tmux_pane_id = P` for
agent A on device D, the same transaction clears `tmux_pane_id` on every other row
holding `(D, P)`.  So by the time seat-follow runs, the incumbent's pane is already
NULL — which is precisely why the query fell back to "the fields that survive it".

The information is not unavailable.  It is discarded one statement earlier, by code
that knows exactly which pane it is clearing.

## Options

### A — Drop the tty leg, match on pid only

Smallest diff.  Also removes seat-follow for every bind that records no pid (the
tty-verified shape), and — per the reachability argument above — removes the
dead-holder branch entirely rather than fixing it.  That branch exists for a real case
(same-pane restart with no pre-reg row); deleting it silently is not a fix.

### B — Require thread equality on the dead branch too

Closes the hole and closes the branch: a restarted codex carries a **new** thread, so
thread equality can never hold there.  That is the whole reason the branch skips the
check.  This is A with extra steps.

### C — Bound the dead branch by recency

Only migrate when the holder was seen within the last N seconds.  Would have blocked
this incident (26 hours apart).  Rejected: it is an elimination rule wearing a
correlation's clothes — the same species this project has twice removed
(`candidate_count`, and the withdrawn carrier-evidence predicate).  It converts
"provably the same pane" into "probably, if you were quick", and its failure mode is
silent and timing-dependent.

### D — Preserve the pane id at the moment it is cleared

Add a nullable `prev_tmux_pane_id`.  The last-writer-wins clear, which already knows
`(device, P)`, writes `P` there as it nulls `tmux_pane_id`.  Seat-follow's dead branch
then matches `h.prev_tmux_pane_id = c.tmux_pane_id`: the holder's pane was taken over
by the caller, which is exactly the branch's premise, expressed in an identifier that
is never recycled.

**Chosen.**  It restores the intended semantics instead of narrowing around them, it
keeps the dead-holder branch alive for the case it was written for, and the value is
written by the one piece of code that is already authoritative about the takeover.

## Consequences of D

- **The tty leg goes.**  With `prev_tmux_pane_id` covering pane takeover — including
  pid-less binds, since pane clearing does not depend on a pid — tty adds only false
  candidates.  A false candidate is not harmless even where thread equality still
  gates the move: two candidates make `holders.length !== 1` and the whole follow is
  skipped, so a recycled tty can suppress a legitimate migration.  Removing it is a
  correctness gain on both branches, not only a safety one.
- **One nullable column.**  Rejected alternatives: deriving the previous pane from
  history (there is no history table), and keeping the pane on both rows (it would
  break the exclusivity invariant the clear exists to maintain).
- **Pane ids are per tmux server.**  Two servers can present `%88`.  That is the open
  cross-server item recorded in `2026-08-01-surface-prereg-write-destination`, whose
  revisit criterion is unchanged and is NOT claimed to be closed here.  The comparison
  that matters is against what is there today: a tty is reused within one server, by
  design, on the timescale of closing a pane.

## What this does not fix

- Rows already corrupted by the old rule keep their state.  Nothing here reverses a
  migration that already happened.
- A pane id colliding across tmux servers remains possible.
- `identity_key` presence still is not, on its own, evidence that a seeding round
  succeeded — the key has to be the one the launcher issued for that pane.  That is an
  acceptance-criterion lesson from this incident, recorded here because the criterion
  that missed it was written by this project.
