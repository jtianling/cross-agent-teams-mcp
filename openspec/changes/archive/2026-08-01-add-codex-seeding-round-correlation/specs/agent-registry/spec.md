# agent-registry Delta

## ADDED Requirements

### Requirement: A first launch can be given a pane token when candidacy is ambiguous

When two or more unexpired pre-registration rows are pending at once, the daemon SHALL be able to give each of those panes a one-time token by the same means it gives one to a restarted pane, and SHALL do so even when no agent row holds the row's `identity_key`.

Without this, the first launch is a closed loop rather than a slow path: a token is minted only when a recovery notice is sent, a recovery notice is scheduled only when an identity already holds the row's key, and an identity acquires that key only by consuming a pre-registration row — which is the step the ambiguity blocks.  Nothing seeds, so nothing ever becomes recoverable, and every subsequent launch of those panes repeats the same round.

The token SHALL be minted ONLY under that ambiguity.  With a single pending row the existing unique-candidate rule already selects correctly, and sending anyway would write into a pane where nothing was ambiguous, which buys nothing and costs an unsolicited write into a pane a person may be using.

A pane SHALL hold at most one live token.  When a pane already has a recovery token, that token SHALL stand and no seeding token SHALL be minted for it: the recovery notice carries strictly more than the seeding one, and two live tokens for one pane would make the pane's identity ambiguous at the moment the token is spent.

The seeding notice SHALL NOT contain the identity key, under the same rule that governs the recovery notice.

#### Scenario: Two first-launch panes each bind their own row

- **GIVEN** two panes with pending unexpired pre-registration rows, neither row's `identity_key` held by any agent row, each pane hosting its own foreground carrier carrying its own row's uuid
- **WHEN** each pane's codex registers quoting the token it was given
- **THEN** each registration consumes ITS OWN row and binds ITS OWN pane
- **AND** neither is refused for candidate count

#### Scenario: A single pending row is not sent anything

- **GIVEN** exactly one pending unexpired pre-registration row
- **WHEN** the row is written
- **THEN** no seeding token is minted and nothing is written into the pane
- **AND** the registration binds through the existing unique-candidate rule

#### Scenario: A recovery token is not displaced by a seeding token

- **GIVEN** pane A with a live recovery schedule and pane B pre-registering as a first launch
- **WHEN** the ambiguity trigger evaluates
- **THEN** pane A keeps its recovery token and receives no seeding token
- **AND** pane B is given a seeding token

#### Scenario: A registration quoting an unknown token still falls back

- **GIVEN** a registration quoting a token the daemon does not recognise
- **WHEN** the pre-reg scan runs
- **THEN** the scan proceeds as if no token had been offered, and never fails for that reason

### Requirement: Binding a runtime does not seed an identity

An agent row SHALL acquire an `identity_key` only by consuming a pre-registration row that carries one.  A runtime binding established by any other path — in particular the `detect_tmux_pane` fallback — SHALL NOT be described or relied upon as making that agent recoverable.

These two states look alike from outside and are not: a row can carry a bound `runtime_ui_pid`, deliver pokes, and appear fully working while holding no key, and such an agent has no restart recovery at all.  Measured 2026-08-01, a production registry held 3 keys across 526 agent rows, including one codex row with a bound pid and no key.  Reading "it binds fine" as "it will recover" is what let this stand: the two are unrelated, and the daemon SHALL NOT present a successful bind as evidence of the second.

#### Scenario: A fallback-bound agent holds no key

- **GIVEN** a codex registration that binds through the `detect_tmux_pane` fallback with no pre-registration row consumed
- **WHEN** the bind succeeds and records a runtime pid
- **THEN** the agent row's `identity_key` remains unset
- **AND** a later restart of that pane finds no holder and schedules no recovery

### Requirement: The seeding token states what it does not supply

This requirement SHALL NOT be described as making a first launch register itself.  Beyond the limits the recovery token already carries — the re-registration stops at the host's approval prompt unless pre-authorised, so what is automatic is the PROMPTING; and whether one action brings two panes back also depends on the launcher's adoption timing — seeding carries one more that is specific to it.

A pane in the seeding round has no xats identity yet.  The notice therefore asks a codex to register under a name and team it does not know, and the token does not supply them: it fixes WHICH row such a registration consumes, not WHO registers.  Something else still has to name the agent.

What this establishes is exactly this and no more: two codex panes asked to register concurrently can each name their own pane, so they stop refusing each other.

#### Scenario: The notice does not assert an identity it does not have

- **GIVEN** a seeding notice being composed for a pane whose row's key is held by no agent row
- **WHEN** the notice content is produced
- **THEN** it names no team and no name as the pane's prior identity
- **AND** it contains no identity key
