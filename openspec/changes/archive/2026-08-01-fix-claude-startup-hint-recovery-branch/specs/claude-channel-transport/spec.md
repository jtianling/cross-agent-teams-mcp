# claude-channel-transport Delta

## ADDED Requirements

### Requirement: The startup notification is segmented, not one paragraph

The startup notification SHALL separate its parts with blank lines rather than
running them together with spaces.  Precedence between the parts SHALL NOT rest on
word order alone: an ordering cue ("before anything below") carried across several
hundred unbroken words is not a structure a skimming reader can be expected to
honour, and the observed failure was exactly a reader that took the cheapest
complete action available in the text.

#### Scenario: The notification contains blank-line separated parts

- **GIVEN** a proxy emitting its startup notification, with or without an identity key
- **WHEN** the notification content is inspected
- **THEN** its parts are separated by blank lines
- **AND** the identity branch, when present, is its own part rather than a clause
  inside a longer run of text

### Requirement: A present identity key makes the user-facing ask conditional

When the proxy environment carried an identity key, the notification's verbatim user-facing registration ask SHALL be reachable only as the identity branch's `need_register` outcome, and SHALL NOT be stated as an unconditional instruction alongside the identity branch.

An unconditional, verbatim-scripted ask requires no tool call to satisfy, so it is
always the cheapest complete action in the notification.  Leaving it unconditional
next to a recovery instruction lets a reader satisfy the notification while
skipping recovery entirely — which is the observed failure, independent of whether
the recovery tool was ever treated as callable.

When the environment carried NO identity key, the ask SHALL remain unconditional
and its wording SHALL be unchanged.

#### Scenario: Keyed notification gates the ask behind the recovery outcome

- **GIVEN** the proxy environment set `XATS_IDENTITY_KEY`
- **WHEN** the startup notification is emitted
- **THEN** the user-facing ask is presented as what to do when the identity branch
  returns `need_register`
- **AND** the notification does not instruct the agent to ask the user first as an
  unconditional step

#### Scenario: Unkeyed notification keeps the ask unconditional

- **GIVEN** the proxy environment did not set `XATS_IDENTITY_KEY`
- **WHEN** the startup notification is emitted
- **THEN** the user-facing ask appears unconditionally, with its existing wording

### Requirement: Negative instructions about a tool are scoped to their own branch

The notification SHALL NOT contain an unscoped instruction not to call a tool that
the same notification elsewhere instructs the agent to call.  Where one routing
branch is better served by a different tool, that preference SHALL be expressed
inside that branch and SHALL be attached to the branch's own condition.

The keyed and unkeyed notifications are NOT in a superset relation: a sentence that
is unambiguous without the identity branch can become a contradiction once the
identity branch is added above it.  Any wording rule here therefore SHALL be
evaluated against the keyed form, not only the unkeyed one.

#### Scenario: The remembered-identity branch does not globally discourage reconnect

- **GIVEN** a notification emitted with an identity key present
- **WHEN** its content is inspected
- **THEN** the guidance preferring `register_agent` for an agent that remembers its
  own `(team, name)` is stated within that branch's own condition
- **AND** the notification contains no instruction against calling `reconnect` that
  reads as applying to the notification as a whole

### Requirement: The notification states that its tools may need loading first

The notification SHALL state that the tools it names may not be directly callable
until loaded, and that loading them is the first step when so.

The justification is accuracy, not defect prevention: in a host where these tools
are deferred, the agent receives their names without schemas and invoking one
directly fails, so `call reconnect({…})` describes a two-step action as a single
step.  No evidence establishes that this barrier caused any observed failure, and
this requirement SHALL NOT be described as fixing one.

#### Scenario: The notification does not present tool invocation as unconditionally single-step

- **GIVEN** any startup notification
- **WHEN** its content is inspected
- **THEN** it states that the named tools may require loading before they can be
  called
