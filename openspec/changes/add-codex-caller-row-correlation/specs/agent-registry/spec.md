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

### Requirement: The recovery notice carries a one-time pane token

When the daemon sends a codex recovery poke it SHALL mint a one-time token for
the pane it is sending to, quote that token in the notice, and instruct the
codex to pass it back verbatim on `register_agent`.  The daemon issued the token
to one known pane, so the token-to-pane mapping is a fact the daemon owns rather
than an inference — which is what makes it a correlation and not another
elimination rule.

The token SHALL be minted per SEND, not per schedule: a retry reissues and
retires the previous token, so only the notice actually sitting in the pane can
be quoted back.  It SHALL be spent when the scan begins, not after a successful
bind — a token surviving a failed bind could re-target a LATER registration at a
pane whose row has since moved on.  Minting for a pane SHALL retire that pane's
previous token, and cancelling the pane's recovery schedule (row consumed,
replaced or expired) SHALL clear it, because a token outliving its row would
still name that pane.  The token SHALL be stored in memory only: it is
meaningless once the daemon that issued it is gone, and persisting it would
outlive the pane state it names.

A registration carrying a token the daemon does not recognise SHALL be treated
as offering no correlation and SHALL fall back, never fail.  The recovery notice
SHALL NOT contain the identity key, unchanged from the existing wording rule.

#### Scenario: Two panes restarted together each bind their own
- **GIVEN** two panes with pending pre-reg rows and their own carriers, each having been sent a recovery notice with its own token
- **WHEN** each codex re-registers quoting the token it received
- **THEN** each consumes ITS OWN row and binds ITS OWN pane, and neither registration is refused for candidate count

#### Scenario: A token is spent once
- **GIVEN** a registration that already presented a token
- **WHEN** the same token is presented again
- **THEN** it resolves to nothing and that registration falls back to the unique-candidate rule

#### Scenario: Cancelling the schedule retires the token
- **WHEN** a pane's recovery schedule is cancelled because its row was consumed, replaced or expired
- **THEN** the pane's outstanding token no longer resolves

### Requirement: Correlation outcomes are logged on success as well as failure

The daemon SHALL log the correlation outcome for every codex registration that reaches the scan, including the successful resolution, not only refusals.  A mechanism that reports only its failures becomes invisible once it works, and its later silent breakage would present as the ordinary candidate-count refusal it was introduced to eliminate.

#### Scenario: A resolved correlation leaves a trace
- **WHEN** a registration's correlation resolves and its row is consumed
- **THEN** the decision log records that the row was chosen by correlation, with the caller id and the chosen pane — never any key value
