# agent-registry Delta

## ADDED Requirements

### Requirement: Seat identity for key migration is the pane, never the tty

Seat-follow SHALL NOT treat `runtime_tty` equality as evidence that two rows occupy the same seat, on either branch.

A tty number is drawn from a pool and is reused as soon as the previous pane releases it, so it identifies nothing durable; a tmux pane id is monotonic within a server and is never reused.  Measured 2026-08-01: a brand-new pane inherited a live identity key from an unrelated dead agent on the strength of a recycled tty alone, and a second pane in the same startup matched three further unrelated rows and was spared only because none of them held a key.

The DEAD-holder migration is the branch that most requires this, because it performs no identity verification at all.  Its premise is that the caller is the same pane restarted, and that premise SHALL be established by an identifier that survives the pane rebind and is never recycled.  Matching by `runtime_ui_pid` cannot reach that branch — a pid equal to the caller's own live carrier is classified ALIVE — so the branch's entire input was the reusable identifier, and its "same seat, so no check is needed" justification was therefore circular.

#### Scenario: A recycled tty does not move a key

- **GIVEN** a dead key-holding row whose `runtime_tty` equals a newly bound caller's, with a different pane and a different pid
- **WHEN** seat-follow runs for that caller
- **THEN** no key is moved, and the holder keeps its `identity_key`

#### Scenario: A recycled tty does not suppress a legitimate follow either

- **GIVEN** a caller whose genuine predecessor is matched by pane takeover, and an unrelated key-holding row sharing only the caller's `runtime_tty`
- **WHEN** seat-follow runs
- **THEN** the unrelated row is not a candidate, so the genuine migration is not skipped for ambiguity

### Requirement: The pane rebind preserves the pane it takes over

When a runtime-binding path clears `tmux_pane_id` on another row under the per-device pane exclusivity rule, the daemon SHALL record on that row the pane id being cleared, and seat-follow's dead-holder branch SHALL use it as the seat identity: the holder qualifies when the pane it lost is the pane the caller now holds.

The pane id is destroyed exactly one statement before seat-follow needs it, by code that is already authoritative about the takeover.  Preserving it is what lets the dead-holder branch keep serving the case it was written for — a same-pane restart with no pre-registration row — instead of that case being removed along with the unsound identifier.

A preserved pane id SHALL NOT be read as a live binding: it records that this row once held that pane and lost it, nothing more.

#### Scenario: A same-pane restart still migrates its key

- **GIVEN** a key-holding row whose pane was taken over by the caller's bind, and whose recorded pid is confirmed not running
- **WHEN** seat-follow runs for the caller
- **THEN** the key migrates and is cleared from the holder, in the caller's bind transaction

#### Scenario: A row that never held the caller's pane does not qualify

- **GIVEN** a dead key-holding row that lost a DIFFERENT pane than the one the caller now holds
- **WHEN** seat-follow runs
- **THEN** no key is moved

#### Scenario: The preserved pane is not a binding

- **GIVEN** a row whose pane was taken over
- **WHEN** any path reads its runtime binding
- **THEN** the row is still unbound from that pane — the preserved value never makes it a delivery target
