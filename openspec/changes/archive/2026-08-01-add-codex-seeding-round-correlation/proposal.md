# Proposal: add-codex-seeding-round-correlation

## Why

`add-codex-caller-row-correlation` gave a restarted codex pane a token it can quote
back, so overlapping pre-registration windows stop failing every caller.  It states
its own first limit plainly:

> a FIRST launch receives no notice and therefore no token, so it still falls back to
> the unique-candidate rule

That limit is the whole remaining failure.  A token is minted when a **recovery poke**
is sent, and a recovery poke is scheduled only when the pre-reg row's `identity_key`
is already held by an agent row (`codex-recovery-poke.ts:201-204` returns silently
otherwise).  An agent row acquires an `identity_key` in exactly one way: by consuming
a keyed pre-reg row.  So:

```
no key on any agent row  →  no recovery poke  →  no token
                         →  scan falls back to "exactly one candidate"
                         →  two codex panes  →  candidates=2  →  both refused
                         →  no row consumed  →  no key attached  →  loop
```

Nothing seeds, so nothing ever becomes recoverable.  This is a closed loop, not a
slow path.

Measured on the production daemon (0.8.1, which contains the token mechanism):

```
23:34:54Z same-thread decision: caller=bc98ce97 outcome=none rows=0 seats=0
23:34:54Z auto-bind skip: reason=candidate_count candidates=2 pending=2 panes=%85,%86
23:35:05Z same-thread decision: caller=3ea2618c outcome=none rows=0 seats=0
23:35:05Z auto-bind skip: reason=candidate_count candidates=2 pending=2 panes=%85,%86
```

`bc98ce97` and `3ea2618c` are `aoe-codex` and `aoe-codex-2`.  Whole-log counts:
`auto-bind targeted` = 0, `nonce` = 0, `recovery` = 0 — the token path never engaged
once.  In the registry, 3 of 526 agent rows carry an `identity_key`, and neither of
those two panes is among them.  Both rows in `codex_pane_pre_registrations` carried a
key; no agent row held either.

A second finding falls out of the same data and is worth stating on its own, because
it explains why "these panes used to bind fine" and "these panes never recover" are
both true:

> **A successful bind is not a seed.**  Only consuming a keyed pre-reg row attaches
> `identity_key`.  The `detect_tmux_pane` fallback binds the runtime and records
> `runtime_ui_pid` while attaching no key at all — `aoe-codex-r2` in production has a
> pid and no key, which is exactly that state.

## What Changes

- **Give the seeding round the same kind of token the recovery round has**, so a
  first launch can name its own pane instead of relying on being the only candidate.
- **Mint it only when the ambiguity is real.**  With one pending row the existing
  unique-candidate rule already works and nothing is sent.  The trigger is two or more
  unexpired pending rows, which is precisely the condition under which every caller
  would otherwise be refused.
- **Keep every existing proof.**  The token selects WHICH row is examined.  The
  foreground-carrier proof, the identity-key arbitration, the snapshot re-read and the
  in-transaction re-arbitration all still have to pass, exactly as on the recovery
  path.

Deliberately NOT in scope:

- **No serialisation of pane startup.**  It was evaluated and rejected on both sides:
  the criterion for "is this the first launch" is `identity_key` presence in the xats
  registry, so the launcher would have to poll the daemon to know when to start its
  second pane — the deciding fact sits on the wrong side of the boundary, and a
  timeout fallback puts the concurrent case straight back.
- **No caller-self-reported `xats.agent_id`.**  Settled by experiment E1 and recorded
  in the archived change's task 2.3 — twice over: `codex --remote` cannot read its own
  `-c` overrides (its tools run in a shared app-server), and even a caller that
  answers correctly may have fabricated rather than derived the value, which the
  daemon cannot distinguish.  Handover item 6.3 adds that the uuid leaks into other
  sessions' rollouts, so deriving it by search would succeed and be wrong.
- **No change to the unique-candidate backstop.**  It stays as the no-token path.

## Capabilities

### Modified Capabilities

- `agent-registry`: the caller-to-row correlation extends to the first launch, gated
  on the ambiguity that makes it necessary; the requirement that a successful bind
  does not by itself seed an identity is stated explicitly.

## Impact

- `src/mcp/codex-recovery-poke.ts` — the schedule entry point currently returns early
  when no identity holds the row's key; that branch gains the seeding path.  See
  design.md: the send path is holder-coupled, and the decision is to add a parallel
  minimal path rather than thread "no holder" through the recovery one.
- `src/mcp/pre-register-codex-pane.ts` — the write path is where the second pending
  row becomes observable, so the ambiguity trigger is evaluated there.
- `src/mcp/tools.ts` — no signature change: `recovery_nonce` already exists and is
  already "a token the daemon minted for one pane"; its description widens.
- **Naming constraint inherited**: the archived requirement forbids describing the
  token mechanism as making codex recovery automatic.  The same applies here, plus
  one more limit specific to seeding — see the delta.
