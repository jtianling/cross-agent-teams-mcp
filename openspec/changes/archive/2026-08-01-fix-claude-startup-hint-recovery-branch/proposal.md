# Proposal: fix-claude-startup-hint-recovery-branch

## Why

A claude pane that carries `XATS_IDENTITY_KEY` and is restarted does **not** recover
its identity, even though every piece of machinery works.  Measured 2026-08-01 on a
real recovery round (aoe left/right pane, Shift+C):

```
23:54:39Z  register_agent  name=e2e-claude-left-138ef8e2  identity_key_present=true   ← seeded
23:55:25   Shift+C                                                                    ← restart
23:55:27Z  restarted pane receives kind=startup_bind_hint
           containing "This pane carries an identity key: …"
           containing "BEFORE anything below, call reconnect({identity_key: …})"
23:55:31Z  assistant: "I'll register once you tell me the name and team."

transcript: tool_use total = 0, ToolSearch = 0, thinking objects = 0,
            agent-authored mentions of `reconnect` = 0, of the key = 0
```

Key injection PASS, hint injection PASS, **behaviour FAIL**.  The one text block the
agent produced reproduced the hint's own verbatim ask, word for word.

Two hypotheses were considered — the agent never treated `reconnect` as callable
(it is a deferred tool in Claude Code, so it arrives as a name with no schema and
must be loaded before it can be invoked), or it read the wording and chose the
scripted path.  A dedicated transcript pass could **not** separate them: with zero
thinking objects there is no record of the decision forming.  This proposal does not
need them separated, because both routes terminate at the same structural defect:

> The hint offers an **unconditional, verbatim-scripted, zero-tool-call action**
> ("ask the user, using exactly this wording: …") sitting in the same unbroken
> paragraph as the recovery instruction.  For a model that skims and answers, that
> action is the cheapest thing in the text — whether or not `reconnect` was ever a
> live option.

Three concrete faults produce it, all in `buildStartupHint`:

1. **The five segments are `.join(' ')`-ed into one unbroken paragraph.**  Ordering
   ("BEFORE anything below") is the only thing carrying precedence, and it carries it
   across several hundred words with no visual break.
2. **The ask segment is unconditional.**  It reads `Do NOT register automatically.
   First ask the user … use exactly this wording: '<script>'` regardless of whether
   the identity branch above it just told the agent to recover first.
3. **The routing segment contains a bare `do NOT call reconnect`.**  It is correct
   in its own branch (an agent that remembers its `(team, name)` should re-register
   rather than reverse-look-up a changed `$PPID`), but in the keyed hint it sits a
   few lines below `call reconnect(...)` in the same paragraph.  The keyed and
   unkeyed hints are therefore **not** a superset relation: adding the identity
   branch turns a previously harmless sentence into a contradiction.

## What Changes

- **Segment the notification.**  Join with blank lines instead of spaces so the
  identity branch is a block the reader cannot skim past on the way to the ask.
- **Make the ask conditional when a key is present.**  The verbatim user-facing
  script becomes reachable only on the identity branch's `need_register` outcome.
  With no key the ask stays unconditional and byte-comparable to today.
- **Scope the `do NOT call reconnect` clause to its own branch** so it cannot be
  read as a global discouragement.
- **State that the tools may need loading first.**  Not as a fix for an observed
  failure — nothing observed proves that barrier bites — but because `call
  reconnect({…})` describes a **two-step** action in Claude Code as if it were one.
  The claim is inaccurate on its own terms; that is the whole justification.

Deliberately NOT in scope:

- **No change to what the hint asks for.**  Same tools, same arguments, same
  routing conditions.  This change is about the text being followable, not about
  the protocol.
- **No behavioural verification harness for hint compliance.**  The gap is real
  (the codex nonce path has a behaviour-level check; the claude hint never had one)
  but building it is a separate piece of work, recorded under Impact.
- **No change to the unkeyed hint's semantics.**  Its content is unchanged apart
  from segmentation and the scoping of fault 3.

## Capabilities

### Modified Capabilities

- `claude-channel-transport`: the startup notification gains structural
  requirements — segment separation, the ask being conditional under a present
  identity key, and a prohibition on unscoped negative instructions about a tool
  the same notification elsewhere tells the agent to call.

## Impact

- `plugins/cross-agent-teams-channel/src/cli.ts` — `buildStartupHint` only.
- `plugins/cross-agent-teams-channel/tests/` — existing startup-notification tests
  assert on substrings; segmentation must not break them, and new assertions cover
  the conditional ask and the scoped negative.
- No daemon change, no schema change, no protocol change.
- **Known gap, not closed here**: there is no behaviour-level acceptance for the
  claude hint.  `add-codex-caller-row-correlation` task 5.5 verified the codex nonce
  path by observing the real agent carry the token back; nothing equivalent exists
  for this notification, which is why a text-level PASS coexisted with a
  behaviour-level FAIL for as long as it did.
