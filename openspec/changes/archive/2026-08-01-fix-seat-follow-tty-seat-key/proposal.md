# Proposal: fix-seat-follow-tty-seat-key

## Why

Seat-follow moved a live identity key to a pane that had never been issued one.

Measured 2026-08-01 on the production daemon, during the first double-codex session
after 0.8.2:

```
10:52:31.898  seat-follow migrated: identity key moved to (aoe, aoe-codex-test-2)
```

```
name              pane  runtime_ui_pid  runtime_tty  identity_key
aoe-codex-test-2  %88   79678           ttys037      4DF60D6C…   ← brand new pane
aoe-codex-shell   %74   9739            ttys037      (now null)  ← rightful holder
```

Different pane, different pid — **only `runtime_tty` matched**.  The aoe side proved
it never supplied that key to `%88`: not in the process environment, not in its
`agent_slot` table, not in `sessions.json`, not in the codex app-server environment.
The key can only have arrived through this migration.

`findKeyHoldersBySeat` (`src/storage/agents-repo.ts:259`) treats a row as occupying
the caller's seat when `runtime_ui_pid` matches **or** `runtime_tty` matches.  A tmux
pane id is monotonic and never reused; a **tty number is drawn from a pool and is
reused** once the old pane releases it.  `runtime_tty` is therefore not a seat
identity.  The data proves the reuse without probing anything: two live panes cannot
share one tty, and `%74`'s last contact was 26 hours before `%88`'s.

**The defect is structural, not a loose end.**  The DEAD-holder branch migrates with
no thread check at all, justified by "same seat, holder dead — the pane restarted".
But that branch is reachable *essentially only through the tty leg*: a match on
`runtime_ui_pid` means the holder's pid equals the caller's own live carrier pid, so
the liveness re-check classifies it ALIVE and routes to the thread-authorized branch
instead.  The one branch that skips identity verification takes its entire input from
the one leg that does not identify anything.  Its safety argument is circular.

It is not a rare race.  In the same two-pane startup the other pane (`%87`, tty
`ttys035`) also matched three unrelated rows — `aoe-codex-r2`, `reviewer`,
`worktree-user` — and was saved only because none of them held a key.  Two panes, two
hits, one blank.

Consequences, in severity order:

1. **An identity can be acquired without ever being issued.**  The taker does nothing
   but happen to be assigned a recycled tty number.
2. **The rightful holder loses its key**, so it can no longer be recovered by key.
   Here the holder was already dead; against a live one this is identity theft.
3. **`identity_key` presence stops being evidence of anything.**  Any acceptance
   criterion of the form "the row has a key, so seeding worked" now yields false
   positives — this proposal's author supplied exactly such a criterion to the aoe
   side, and it would have passed this incident as a success.

## What Changes

- **Stop treating `runtime_tty` as a seat identity.**  A recycled identifier cannot
  authorise a key move.
- **Give the dead-holder branch an identifier that means what the branch assumes.**
  Its premise is "this is the same pane, restarted".  The pane id is exactly that and
  is never reused — it is discarded today only because the last-writer-wins pane
  rebind clears it from the incumbent row.  Preserve it at the moment it is cleared,
  and match on it.  See design.md.

Deliberately NOT in scope:

- **No change to the thread-authorized branch's authorisation.**  Thread equality is a
  real correlation and stays exactly as it is.
- **No socket scoping of pane ids.**  Pane ids are unique per tmux server, so two
  servers can present the same one; that is the open item recorded in
  `2026-08-01-surface-prereg-write-destination` and its revisit criterion is
  unchanged.  A pane id is strictly better than a tty here regardless — this change
  does not claim to close that.
- **No repair of already-corrupted rows.**  `aoe-codex-test-2` keeps the key it took
  and `aoe-codex-shell` stays empty; the row is deliberately preserved as evidence.
  Deciding what to do with existing bad rows is an operational call, not this change.

## Capabilities

### Modified Capabilities

- `agent-registry`: seat-follow's notion of "the caller's seat" stops resting on a
  reusable identifier; the dead-holder migration requires an identifier that survives
  the pane rebind and is never recycled.

## Impact

- `src/storage/agents-repo.ts` — the seat lookup query, and the last-writer-wins pane
  clear that must preserve what it clears.
- `src/mcp/codex-seat-follow.ts` — branch inputs.
- `src/storage/schema.ts` — one nullable column (see design.md for why a column, and
  what the alternatives cost).
- `src/mcp/tools.ts` — wiring only.
- **Evidence preserved**: the incident rows stay in the production database. Any test
  fixture must reproduce the shape rather than depend on those rows.
