# Design: add-codex-seeding-round-correlation

## What the seeding round has and does not have

The recovery round has a prior identity: the row's `identity_key` names an agent row,
so the daemon knows who the pane was, can address the notice to that identity, and can
verify at every checkpoint that the identity is still the one it started for.

The seeding round has none of that.  There is no prior identity — that is what makes
it the seeding round.  What it does have is exactly what the token needs:

- a **pane id**, asserted by the launcher on the pre-register call;
- a **uuid** on the row, which the launcher also put on the codex command line, so the
  daemon can prove the pane's carrier is the one the row describes.

The token is minted by the daemon, sent to one pane, and quoted back.  None of that
depends on knowing who the pane used to be.  So the correlation transfers; only the
delivery machinery around it is holder-shaped.

## Where the holder coupling actually is

Reading `sendAfterGuard`:

| Leg | Needs holder? |
|---|---|
| `detectCodexProcess` | no — pane tty, uuid |
| pid-stability re-check | no |
| `rowStillCurrent` | no — row snapshot |
| `resolveCurrentHolder` | **yes** |
| `verifyPaneHost({holderAgentId})` | **yes** |
| `confirmOwnership` → `classifyCodexCarrier({lines, pid, uuid})` | no — pane + uuid |
| `tmuxPoke` | no |
| message body `{team, name}` | **yes** |

Three legs, and the strongest one — the composite ownership confirm re-evaluated at
every write checkpoint inside the tmux primitive — is already holder-free.  It proves
"the codex that this row describes is the foreground carrier of this pane, right now",
which is the property that makes a paste safe.

`verifyPaneHost` exists to stop a paste landing in a pane that has been reassigned to a
different agent.  For seeding there is no expected agent to compare against, but the
uuid carrier proof answers the same question more directly: if the pane's foreground
carrier is running with this row's uuid, the pane is the one the launcher announced.

## Options

### A — Thread "no holder" through the recovery path

Make `holder` optional everywhere: `resolveCurrentHolder` returns a sentinel,
`verifyPaneHost` takes an optional id, the message body branches.

Rejected.  That path is the most safety-critical code in the repo and its guards were
built incrementally against real incidents (pasted-but-unexecuted, SIGSTOP-ed carrier,
pane reassigned, stale generation, row overwritten mid-flight).  Every one of them is
expressed against a non-optional holder.  Making the holder optional means every guard
grows a nullable branch, and a nullable branch in a guard is where a guard stops
guarding.  The blast radius is the working recovery path, to add a case it was not
built for.

### B — A parallel minimal seeding path reusing the primitives

A separate scheduler that reuses `detectCodexProcess`, `classifyCodexCarrier`,
`mintCodexRecoveryNonce` and `tmuxPoke`, with its own message body and without the two
holder legs.

Chosen.  The recovery path is untouched, so its guards keep their non-optional holder
and cannot regress.  The seeding path carries the guards that apply to it — generation,
row-snapshot currency, and the composite carrier confirm at every write checkpoint —
and simply does not have the two that presuppose a prior identity.

The cost is a second scheduler with its own lifecycle, which must share the nonce store
and the per-pane cancellation so that a pane never has both a seeding and a recovery
token live at once.  Cancellation is already per-pane and already clears the pane's
nonces, so the sharing point exists.

## When to send

Not on every pre-registration.  Sending on every codex launch would paste into panes
where nothing is ambiguous and the existing rule already works — an unsolicited write
into a pane a human may be typing in, bought for nothing.

The trigger is the condition that makes the seeding round fail: **two or more unexpired
pending rows**.  Evaluated on the pre-register write, because that is the moment the
second row becomes observable.  When the second row lands, both panes need a token —
the first pane's codex may already be up and about to register — so both are scheduled.

Ordering cases:

- **One row only.** Nothing scheduled.  Unique-candidate binds it, as today.
- **Row A, A registers, row B lands.** Only B pending at every point; nothing
  scheduled; both bind via the existing rule.  This is the case that "sometimes works
  today", and it keeps working with no paste.
- **Row A, row B, neither registered.** The failing case.  Both scheduled on B's write.
- **A already has a live recovery schedule** (A is a restart, B is a first launch).
  A keeps its recovery token; only B is seeded.  One token per pane, recovery wins —
  it carries strictly more information.

## What this does not establish

The archived requirement forbids describing the token as making codex recovery
automatic, and lists three limits.  Two of them apply here unchanged: the
re-registration the notice asks for **stops at the host's approval prompt** unless the
user pre-authorised it, so what is automatic is the prompting; and whether one action
brings two panes back also depends on the launcher's adoption timing.

Seeding adds a fourth limit of its own, and it must not be elided: **the seeding notice
asks a codex that has no xats identity yet to register with a name and team it does not
know.**  The token fixes *which row* such a registration consumes; it does not supply
the identity.  Something still has to name the agent — the user, or the launcher's own
prompt.  So the honest claim is narrow:

> Once two codex panes are asked to register concurrently, each can now name its own
> pane, so they stop refusing each other.  Who they register *as* is unchanged.

## Rejected: break the tie deterministically

When two candidates are indistinguishable, pick by pane id order, or by row age.  This
is the exact failure the parent change was written to remove — an elimination rule
wearing a correlation's clothes — and it would be worse than the current refusal
because it would silently succeed at binding the wrong pane.
