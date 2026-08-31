## REMOVED Requirements

### Requirement: Sentinel migration advances stale zero cursors on schema apply

**Reason**: The migration silently destroys unread mail, and its useful work is already complete everywhere.

Its sentinel is `last_processed_event_id = 0`, a value that carries two mutually exclusive meanings.  One is a row registered before the cursor feature landed: the column has been in the `agents` DDL with `DEFAULT 0` since the table was created, but the registration INSERT did not list it, so those rows took the default and their cursor was never written.  The other is a row that `register_agent` legitimately initialised to `0`, because `COALESCE(MAX(event_id), 0)` was evaluated while the `events` table was empty — registration itself appends no event.  The two are indistinguishable in the data.

That second state recurs; it is not confined to a brand-new database.  Cleanup applies a 30-day TTL to `events`, so any deployment that stays quiet for that long has its events table emptied again, and the next agent to register there is handed a fresh, legitimate cursor of `0`.  The removed migration therefore did not misfire once per database — it misfired again every time an idle deployment gained a new agent.

The removed requirement justified itself with a claim that is false: it stated the WHERE-clause stops matching once a cursor has advanced past 0 "via a fresh registration", but a fresh registration on an empty events table produces exactly `0`.  Such an agent's pending mail is therefore marked read by a restart it never observed, which hides the mail from `get_inbox`, suppresses the auto-poke retry (whose `alreadyReadFn` uses the same predicate), and suppresses the unread-alert watchdog — every backstop for the loss is disabled by the same write.

**Migration**: None required for any database that has run a build containing the migration.  The migration and `register_agent`'s cursor initialisation shipped in the same commit (`8f1c068`, 2026-05-08), so the rows it targeted can only have been registered before that commit, and the first boot on any build carrying it advanced them all.

The affected population is databases that have never run such a build — note this is scoped by BUILD, not by boot: nothing persists that the migration ran, so a pre-`8f1c068` daemon can boot the same file any number of times and leave those cursors at `0`.  On such a database the historical rows stay at `0` and those agents read their backlog once on the next `get_inbox`.

That replay is one-shot and per-call bounded (the `get_inbox` page limit is `min(limit ?? 50, 200)` and the cursor advances per page), but it is NOT bounded by the 30-day retention window at the moment it happens: retention runs only on the daemon's periodic cleanup timer, not at boot, so the first read after an upgrade can return mail older than the window.  The cost is accepted in preference to silent data loss.

## ADDED Requirements

### Requirement: Schema apply MUST NOT modify any agent's inbox cursor

`applySchema` and every migration it runs SHALL NOT write `agents.last_processed_event_id`.  The cursor has exactly two writers: `get_inbox`, which advances it in the same transaction that returns the rows, and the fresh-registration INSERT, which initialises it to `COALESCE((SELECT MAX(event_id) FROM events), 0)`.

This restores the invariant the read-receipt predicate depends on: a cursor may only move because the owning agent read something, or because the row was just created.  A daemon restart MUST be unobservable in the cursor.

A cursor legitimately sitting at `0` MUST be treated as a valid cursor, not as an uninitialised sentinel.  Any future need to bulk-initialise cursors MUST use an unambiguous marker (a nullable column, or an explicit flag) rather than matching on `= 0`.

#### Scenario: Restart does not advance a legitimately zero cursor

- **GIVEN** agent `B` registered while the `events` table was empty, so its `last_processed_event_id` is `0`
- **AND** agent `A` then sent `B` a message, creating `event_id = 1`
- **WHEN** the daemon restarts and `applySchema` runs
- **THEN** `B`'s `last_processed_event_id` is still `0`
- **AND** `B`'s next `get_inbox` returns that message

#### Scenario: Restart does not advance a non-zero cursor

- **GIVEN** an agent whose `last_processed_event_id` is `3`
- **AND** the events table has since grown past `3`
- **WHEN** the daemon restarts and `applySchema` runs
- **THEN** that agent's `last_processed_event_id` is still `3`

#### Scenario: Repeated schema applies leave every cursor untouched

- **GIVEN** a database holding agents with a mix of zero and non-zero cursors, and a non-empty events table
- **WHEN** `applySchema` runs several times
- **THEN** every agent's `last_processed_event_id` holds the value it had before the first run

#### Scenario: An emptied events table yields a valid zero cursor again

- **GIVEN** a long-running database whose `events` rows have all aged past the retention TTL and been deleted
- **WHEN** a new agent registers
- **THEN** its `last_processed_event_id` is `0`
- **AND** a subsequent `applySchema` leaves it at `0`

#### Scenario: A fresh registration on an empty events table yields a valid zero cursor

- **WHEN** an agent registers while the `events` table is empty
- **THEN** its `last_processed_event_id` is `0`
- **AND** that value is treated as a valid cursor by every later read, not as a sentinel to be rewritten
