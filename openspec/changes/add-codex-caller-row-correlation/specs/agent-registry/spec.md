# agent-registry Delta

## ADDED Requirements

### Requirement: The pre-reg scan selects by a verifiable caller-to-row correlation

When a codex `register_agent` reaches the pre-registration scan, the daemon SHALL select the row belonging to THAT caller by a correlation the daemon can verify itself, rather than by the count of machine-wide candidates.  Candidate uniqueness SHALL be demoted to a fail-closed backstop used only when no correlation is available; it SHALL NOT be the means of deciding whose row a pending row is.

The correlation SHALL take as its caller-side input only values the delivery path already relies on.  A value the caller reports that the delivery path does NOT already rely on SHALL NOT be sufficient on its own: forging it would not cost the forger anything, while the pane-side carrier proof — which matches the row's stored uuid against a live pane's argv — would then corroborate the forger rather than expose it.  Such a self-reported value MAY be used only as an accelerator whose result is discarded unless it agrees with the daemon-derived correlation.

A correlation that resolves SHALL still be subject to every existing check before anything is written: the full foreground-carrier proof on the row's pane, the identity-key ownership arbitration, the full-snapshot re-read, and the in-transaction re-arbitration.  The correlation decides WHICH row is considered; it SHALL NOT waive any evidence.

#### Scenario: Two overlapping pre-reg windows each bind their own caller
- **GIVEN** two codex panes whose pre-registration rows are both pending and unexpired, each pane hosting its own foreground carrier carrying its own row's uuid
- **WHEN** each pane's codex registers
- **THEN** each registration consumes ITS OWN row and binds ITS OWN pane
- **AND** neither registration is refused for candidate count

#### Scenario: A correlation contradicted by pane evidence fails closed
- **GIVEN** a resolved correlation naming a row whose stored uuid does not appear on any visible pane's carrier
- **WHEN** the caller registers
- **THEN** the registration fails closed with its own reason — no row is consumed, no pane is bound
- **AND** the daemon SHALL NOT fall back to candidate counting for that registration, because doing so would let a correlation failure re-enter the very path the correlation replaced

#### Scenario: A self-reported identifier alone never selects a row
- **GIVEN** a caller reporting a launch identifier that the daemon cannot corroborate from its own sources
- **WHEN** that identifier names a row belonging to another pane
- **THEN** the report is ignored and the registration proceeds as if it had not been made

#### Scenario: No correlation available keeps today's behaviour
- **GIVEN** the correlation cannot be resolved for this caller
- **WHEN** the caller registers
- **THEN** the scan falls back to the existing unique-candidate rule with unchanged behaviour, and the fallback is logged with its own reason

### Requirement: Correlation outcomes are logged on success as well as failure

The daemon SHALL log the correlation outcome for every codex registration that reaches the scan, including the successful resolution, not only refusals.  A mechanism that reports only its failures becomes invisible once it works, and its later silent breakage would present as the ordinary candidate-count refusal it was introduced to eliminate.

#### Scenario: A resolved correlation leaves a trace
- **WHEN** a registration's correlation resolves and its row is consumed
- **THEN** the decision log records that the row was chosen by correlation, with the caller id and the chosen pane — never any key value
