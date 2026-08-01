# Tasks: fix-seat-follow-tty-seat-key

## 1. Preserve the pane at takeover

- [x] 1.1 Add nullable `prev_tmux_pane_id` to `agents` (schema + migration path for existing rows)
- [x] 1.2 The per-device pane-exclusivity clear writes the pane it is clearing into that column, in the SAME transaction as the clear — a separate write could leave the two disagreeing
- [x] 1.3 The preserved value is NOT a binding: no delivery, liveness, poke or detection path may read it as one.  Grep every reader of `tmux_pane_id` and confirm none picks the new column up by pattern

  Audited: no `SELECT *` against `agents` anywhere in `src/` (the only one in the codebase reads `events`), so every reader names its columns and none can pick the new one up implicitly.  The six `table_info(agents)` sites are all migration existence checks in `schema.ts` using exact-name equality, never a prefix match.  Every consumer of a pane (`transport-dispatch`, `poke`, `poke-retry`, `auto-poke-fanout`, `fanout-with-retry`, `broadcast`, `broadcast-to-role`, `send-message`, `same-thread-seat`, `agent-public-row`, `isAgentLive`) takes it from an explicit `tmux_pane_id` selection.

## 2. Seat lookup

- [x] 2.1 `findKeyHoldersBySeat`: drop the `runtime_tty` leg entirely (both branches — a recycled tty also creates false candidates that suppress legitimate follows via `holders.length !== 1`)
- [x] 2.2 Add the pane-takeover leg: `h.prev_tmux_pane_id = c.tmux_pane_id`
- [x] 2.3 Keep the `runtime_ui_pid` leg unchanged
- [x] 2.4 Update the doc comment — it currently states the tty rationale that this change refutes

## 3. Tests

- [x] 3.1 Recycled tty, different pane, different pid, dead holder → no migration (the measured incident, reproduced as a fixture rather than depending on the production rows)
- [x] 3.2 Recycled tty on an unrelated row does not make a legitimate pane-takeover follow ambiguous
- [x] 3.3 Same-pane restart (holder lost the pane the caller now holds, holder pid dead) → key migrates and is cleared from the holder
- [x] 3.4 Holder that lost a DIFFERENT pane → no migration
- [x] 3.5 Thread-authorized branch unchanged: alive/unknown holder still requires thread equality, still refuses on mismatch with the existing reasons
- [x] 3.6 The preserved column is never treated as a live binding (assert one concrete reader, e.g. poke target resolution, does not resolve to it)
- [x] 3.7 Mutation: restoring the tty leg turns 3.1 red; dropping the takeover write (1.2) turns 3.3 red

  3.1–3.6 live in `tests/seat-follow-pane-seat-key.test.ts`, which wires the real `AgentsRepo` to `followSeatIdentityKey` exactly as `tools.ts` does: the incident was only visible in the composition of the seat query with the branch logic, so neither existing layer test reproduces it alone.  3.5 is additionally covered end-to-end, through the real query, by the three thread-mismatch cases already in `register-agent-seat-follow.test.ts`.  3.6 asserts `poke()` returns `tmux_pane_not_set` for a row whose pane was taken over.

  Mutations both confirmed by running them:
  - Re-adding `OR (c.runtime_tty IS NOT NULL AND h.runtime_tty = c.runtime_tty)` → 3.1, 3.2 and 3.4 fail.
  - Reverting `clearPaneBinding` to `SET tmux_pane_id=NULL` alone → 3.3 fails, along with 3.2, 3.5, 3.6 and two `register-agent-seat-follow` migrations.

## 3b. Found in verify (not in the original plan)

- [x] 3b.1 `prev_tmux_pane_id` was written but never cleared, so it went stale: a row that lost `%1`, rebound onto `%2` and died there would still answer to `%1`, and the dead-holder branch would hand its key to whoever took over `%1` instead of `%2`.  That is a stale identifier authorising a key move — the exact defect this column was added to remove, reintroduced one level down.  The pane bind now clears it in the same statement, so the memory means "the pane this row lost AND has not replaced".  `clearRuntimeBinding` deliberately does NOT set it: that path is an undo, nobody took the pane, and after this fix the row's value is already NULL.
- [x] 3b.2 Test + mutation: removing the clear turns 3b.1's case red and nothing else

## 4. Regression

- [x] 4.1 Existing seat-follow suites (`codex-seat-follow`, `codex-seat-follow-recovery`, `register-agent-seat-follow`) pass unchanged, or every changed expectation is justified in this file

  All three pass with no edits.  Three expectations changed elsewhere, all forced by the new column and all made sharper rather than merely widened:
  - `agents-schema.test.ts` asserts the exact column list; `prev_tmux_pane_id` added to it.
  - `agents-repo-pane-exclusivity.test.ts` asserts the eviction touches nothing but `tmux_pane_id`; it now also asserts `prev_tmux_pane_id === PANE` and excludes that column from the "everything else survives" sweep.
  - `agents-repo-find-key-holders-by-seat.test.ts`: the first case was named "matches via surviving runtime_tty"; that leg no longer exists and the case now matches via the preserved pane, so the name and comment were corrected.  No assertion changed.

- [x] 4.2 Typecheck + the pre-reg / recovery / seeding path files

  `npm run -s typecheck` clean.  18 pre-reg / recovery / seeding / runtime-identity files: 175 tests, all pass.

- [x] 4.3 Schema change: confirm an existing database opens and the column is added without data loss

  `tests/agents-prev-pane-schema.test.ts`: fresh database carries the nullable column; a pre-existing `agents` table gains it via `ALTER TABLE ... ADD COLUMN` with its rows' pane / pid / key untouched and `prev_tmux_pane_id` at NULL; the migration is a no-op on a second startup.

  Known pre-existing failure, NOT caused by this change: `register-agent-takeover-inject.test.ts` times out on both of its cases (5000ms).  Verified by restoring `schema.ts` and `agents-repo.ts` to HEAD and re-running — identical failure.  It registers codex agents against a server with the tmux pane probe unmocked, so it probes the host's real tmux server.

## 5. Not in scope (recorded)

- [>] 5.1 Rows already corrupted by the old rule are left as they are — `aoe-codex-test-2` keeps the key it took, `aoe-codex-shell` stays empty.  Deliberately preserved as evidence; what to do about existing bad rows is an operational call.
- [>] 5.2 Pane ids collide across tmux servers.  Same open item as `2026-08-01-surface-prereg-write-destination` 6.1, same revisit criterion, NOT closed here.
- [>] 5.3 Acceptance criteria that read "the row has an `identity_key`, so seeding worked" are unsafe and this change does not make them safe — the key must be the one the launcher issued for that pane.  Recorded because the criterion that missed this incident was written by this project.
