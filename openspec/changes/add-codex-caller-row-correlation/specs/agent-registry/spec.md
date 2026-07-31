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

### Requirement: A live keyed pre-registration is only replaceable by its own key

`pre_register_codex_pane` SHALL refuse a write that would replace an existing
pre-registration row when ALL of the following hold: the row is UNEXPIRED, it
carries an `identity_key`, the incoming call does not carry that same key, and
the row's own launch is still present on that pane (a `codex --remote` process
on the pane's tty whose argv carries the ROW's stored uuid).  The refusal SHALL
leave the stored row completely untouched and SHALL be reported as
`pane_claimed` with a detail naming no key value.

Holding SOME key SHALL NOT suffice — only the row's own key.  A key is
obtainable from the shared app-server environment, so "carries a key" would
admit exactly the caller this rule exists to exclude, while the launcher for
that pane always has the matching one.

This rule's premise — that only that pane's launcher holds that pane's key —
has a KNOWN reachable exception, and the requirement is stated with it rather
than around it: a `--remote` model reads the app-server's environment, which
carries ONE `TMUX_PANE` and ONE `XATS_IDENTITY_KEY`, both from the shell that
started it.  Should an app-server ever be started from a keyed codex pane,
every session through it can read that pane's id AND its key together, and its
write would satisfy this rule.  Production does not satisfy the precondition
today (its app-server environment carries no identity key), and the remedy
belongs to app-server launch hygiene rather than to this rule.  Consequently
this requirement SHALL NOT be described as making the write path safe; what it
establishes is that a caller which cannot read the pane's key can no longer
replace its row.

Protection SHALL end when the row's own launch is gone.  Liveness for this
purpose SHALL NOT require the foreground-carrier proof: that proof answers
whether it is safe to paste into the pane, and a suspended codex is still the
same launch.  A probe that cannot be completed SHALL read as NOT protected —
uniquely among this system's liveness rules — because a refusal here blocks a
launcher immediately before `exec codex`, so a transient tmux or ps failure
would break agent startup, a likelier and worse outcome than the overwrite
being guarded against.

A row carrying NO key, an expired row, and a pane with no row SHALL all remain
freely writable, and the liveness probe SHALL NOT be consulted for them.

#### Scenario: A stranger cannot destroy a live identity's handle
- **GIVEN** a pane whose unexpired pre-registration carries an identity key and whose original codex process is still running
- **WHEN** another caller pre-registers that pane with no key, or with a different key
- **THEN** the call is refused with `pane_claimed`, and the stored uuid, key and expiry are unchanged

#### Scenario: The rightful launcher replaces its own row
- **WHEN** a caller pre-registers that pane supplying the row's own identity key
- **THEN** the write is accepted and the row takes the new uuid

#### Scenario: A vacated pane is free again
- **GIVEN** the row's stored uuid no longer matches any process on that pane
- **WHEN** any caller pre-registers that pane
- **THEN** the write is accepted, so a tmux server restart that reissues pane ids never leaves a batch of panes locked for the remainder of their TTL
