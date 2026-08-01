# Tasks: fix-claude-startup-hint-recovery-branch

## 1. Restructure `buildStartupHint`

- [x] 1.1 Join parts with a blank line instead of a space; identity branch stays its own part
- [x] 1.2 Keyed form: the verbatim user-facing ask becomes the identity branch's `need_register` outcome, not a sibling instruction
- [x] 1.3 Unkeyed form: ask stays unconditional, wording unchanged (byte-compare the ask sentence against today)
- [x] 1.4 Scope the `do NOT call reconnect` clause inside the remembered-identity branch so it cannot read as global
- [x] 1.5 State that the named tools may need loading before they can be called

## 2. Tests

- [x] 2.1 Existing `proxy-startup-notification` assertions still pass (substring assertions survived segmentation)
- [x] 2.2 Keyed form: ask is presented as the `need_register` outcome; no unconditional "ask the user first"
- [x] 2.3 Unkeyed form: ask sentence unchanged from today, verbatim
- [x] 2.4 Keyed form: no unscoped instruction against calling `reconnect` (checked on all three forms — unkeyed, keyed, keyed+device)
- [x] 2.5 Both forms: content states tools may need loading
- [x] 2.6 Mutation verified: dropping the gate (1.2) turns 2.2 red; restoring the bare negative (1.4) turns 2.4 **and** the byte-identical no-key test red

## 3. Verification

- [x] 3.1 Plugin suite 47/47 + `tsc --noEmit` clean
- [x] 3.2 Rendered keyed and unkeyed notifications read end to end

## 4. Deliberate non-changes

- [x] 4.1 **Routing block's `reconnect({ui_pid: $PPID})` left as is in the keyed form.**  Under the gate it is only reached after the key lookup already returned `need_register`, so calling it is a wasted round trip that returns `need_register` again — the agent then asks the user, which is the correct terminal state.  It is redundant, not wrong, and the core diagnosis is that this message is too long and too dense; spending more words to fight a mild redundancy works against the fix.  Recorded rather than silently chosen.

## 5. Not closed here (recorded, not a completion condition)

- [>] 5.1 No behaviour-level acceptance exists for this notification.  A text-level PASS coexisted with a behaviour-level FAIL because every check asserts on substrings.  The codex nonce path has such a check (`add-codex-caller-row-correlation` 5.5); this one needs its own and it is not this change.
