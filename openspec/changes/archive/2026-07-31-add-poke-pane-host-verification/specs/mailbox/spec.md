## ADDED Requirements

### Requirement: A retry tick that injects nothing is not recorded as delivered

A retry tick scheduled after `guard_failed` re-checks the recipient at fire time, and by then the pane may belong to somebody else.  The tick SHALL consult the outcome of the poke it fires rather than assuming the fire succeeded.

The tick SHALL record `wake_status='delivered'` only for an outcome that reports success.  For compatibility with callers whose poke function returns nothing, a `void` outcome SHALL be read as delivered.  **Every unsuccessful outcome SHALL be excluded from `delivered`, whatever its reason** — enumerating one reason and letting the rest fall through to the delivered branch is the specific defect this forbids.

Unsuccessful outcomes resolve as follows:

- `pane_reassigned`, `no_pane`, `tmux_unavailable` → record `wake_status='skipped'` with that reason and stop retrying, because none of them reverts on a timer (the same reasoning that already stops `no_pane`).
- `guard_failed`, or any reason the daemon does not recognise → keep the existing backoff and terminate at `retry_exhausted` if attempts run out.  An unknown failure SHALL NOT invent a new terminal status and SHALL NOT be recorded as delivered.

Recording a delivery for a tick that performed no injection is the specific defect this forbids: it reports a wake-up that the recipient never received, which is indistinguishable from a real delivery in `get_delivery_status`.

#### Scenario: Pane taken over between the initial send and the retry tick

- **GIVEN** an auto-poke that resolved to `guard_failed` and scheduled retries
- **AND** the recipient's pane is bound to a different agent before the first tick fires
- **WHEN** the tick fires and its poke returns `pane_reassigned`
- **THEN** the delivery status is `skipped` with `skip_reason='pane_reassigned'`
- **AND** it is never recorded as `delivered`
- **AND** no further retry attempt is scheduled for that recipient

#### Scenario: Other unsuccessful outcomes are also kept out of delivered

- **GIVEN** a scheduled retry whose tick fires
- **WHEN** its poke returns an unsuccessful outcome of `tmux_unavailable` or `no_pane`
- **THEN** the delivery status is `skipped` with that reason and retrying stops
- **AND** when the outcome is unsuccessful with no recognised reason, the backoff continues and terminates at `retry_exhausted`
- **AND** in none of these cases is `delivered` ever recorded

#### Scenario: A successful retry still records delivered

- **GIVEN** the same setup where the pane is still held by the recipient
- **WHEN** the tick fires and its poke succeeds
- **THEN** the delivery status is `delivered` with `delivered_at` set

## MODIFIED Requirements

### Requirement: Auto-poke prompt is a wake-up hint, not the message body

When `send_message`, `broadcast`, or `broadcast_to_role` triggers the internal auto-poke path (either during the initial fan-out or in any retry tick scheduled by the guard_failed backoff), the prompt injected into the recipient's tmux pane MUST be a short wake-up hint that identifies the sender, names the intended recipient, and points the recipient at `get_inbox`. The prompt MUST NOT contain any substring of the message `body` the caller passed.

The prompt format MUST be:

```
新邮件 from {sender_identifier} → {target_name}@{target_team}, 请调 get_inbox 查看
```

Where `sender_identifier` is:

- `{display_name} ({agent_id})` when the sender agent has a non-empty `display_name` in the `agents` table
- `{agent_id[:8]}` when `display_name` is `null`, empty, or the agent row cannot be resolved (defensive fallback)

And `{target_name}@{target_team}` names the agent row the poke was addressed to, so that a recipient which receives a hint but finds an empty `get_inbox` can identify in one step whether the wake-up was meant for it.  When the target row cannot be resolved, the target segment together with its ` → ` separator SHALL be omitted rather than rendered with placeholders.

`name` and `team` carry no upper length bound, so the length cap below is enforced at render time by the same omission: when including the target segment would push the prompt past the cap, the whole segment and its ` → ` separator SHALL be dropped rather than truncated to a partial label.

For cross-team `send_message`, the sender_identifier is looked up by `from_agent_id` regardless of team — no team prefix is added to the sender segment (recipient can inspect `from_team` via `get_inbox`).

The total prompt length MUST NOT exceed 200 characters.  Neither the sender's `display_name` nor the target's `name` / `team` carries a schema length cap, so the hint SHALL shed content to stay within the cap in this order: first the ` → {target_name}@{target_team}` segment, then the sender's `display_name` in favour of `{agent_id[:8]}`.  Dropping only the target segment does not bound the result and MUST NOT be treated as enforcing the cap.

The rule applies to every poke issued by the daemon via the `autoPokeImpl` path, including:

1. Initial poke fired during `send_message` auto-poke (same team or cross team, single recipient).
2. Initial poke fired during `broadcast` auto-poke fan-out.
3. Initial poke fired during `broadcast_to_role` auto-poke fan-out.
4. Retry pokes fired by `poke-retry.ts` ticks after a prior `guard_failed`.

The rule does NOT constrain the `poke` MCP tool itself when callers invoke it directly.

#### Scenario: send_message auto-poke injects hint, not body (same team)

- **GIVEN** agents A (display_name="lead-opus") and B (display_name="worker-kimi", team `core`) are registered in the same team, both with `tmux_pane_id`
- **AND** B's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "please investigate bug #42 in the auth module"})` with default auto_poke
- **THEN** the message is persisted to B's mailbox with the full body
- **AND** the poke prompt injected into B's pane equals `"新邮件 from lead-opus (<A's agent_id>) → worker-kimi@core, 请调 get_inbox 查看"`
- **AND** the injected prompt does NOT contain `"bug #42"` or any other substring of the body

#### Scenario: Cross-team send_message auto-poke names the target's own team

- **GIVEN** agent A (display_name="lead-alpha") in team `alpha`, agent with `name='bob'` in team `beta` with idle pane
- **WHEN** A calls `send_message({to_agent_name: 'bob', to_team: 'beta', body: "secret: token=xyz"})` with default auto_poke
- **THEN** bob's pane receives exactly `"新邮件 from lead-alpha (<A's agent_id>) → bob@beta, 请调 get_inbox 查看"`
- **AND** the prompt does NOT contain `"token"` or any body substring

#### Scenario: Hint identifies the intended target when the pane host differs

- **GIVEN** a poke addressed to agent `tester-2` in team `webdot` reaches a tmux pane
- **WHEN** the hint is rendered
- **THEN** it contains `→ tester-2@webdot`
- **AND** whoever reads that pane can tell the wake-up was addressed to `tester-2@webdot` without querying another team's `list_agents`

#### Scenario: broadcast_to_role auto-poke names each recipient individually

- **GIVEN** sender A (display_name="captain"), recipients B (`name='b'`) and C (`name='c'`) in team `svc` with role `backend`, both with `tmux_pane_id` and idle panes, `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast_to_role({to_role: 'backend', body: "sensitive config: API_KEY=sk-xyz"})` with default auto_poke
- **THEN** both B and C have the message in mailbox
- **AND** B's pane receives `"新邮件 from captain (<A's agent_id>) → b@svc, 请调 get_inbox 查看"`
- **AND** C's pane receives the same format with `→ c@svc`
- **AND** neither pane contains `"API_KEY"`, `"sk-xyz"`, or any body substring

#### Scenario: Retry tick reuses hint format, not the captured body

- **GIVEN** agent A sends `send_message` to B whose pane is active (guard fails) → retry scheduled
- **AND** 30 seconds later B's pane becomes idle, the first retry tick fires and guard passes
- **WHEN** the retry fires the poke via `autoPokeImpl`
- **THEN** the poke prompt is the hint format including the `→ {target_name}@{target_team}` segment, NOT the original body

#### Scenario: Sender without display_name falls back to agent_id[:8]

- **GIVEN** sender A registered with `display_name = null` and `agent_id = "abc12345-6789-..."`, recipient B (`name='b'`, team `t`) idle
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "anything"})` with default auto_poke
- **THEN** the poke prompt equals `"新邮件 from abc12345 → b@t, 请调 get_inbox 查看"`

#### Scenario: Unresolvable target omits the target segment

- **GIVEN** a poke whose target row cannot be resolved at hint-build time
- **WHEN** the hint is rendered
- **THEN** it equals `"新邮件 from {sender_identifier}, 请调 get_inbox 查看"` with no ` → ` separator and no placeholder text

#### Scenario: Long identities stay within the length cap

- **GIVEN** a sender display_name and a target name/team that are long but still leave the full hint within 200 characters
- **WHEN** the hint is rendered
- **THEN** the target segment is present and the total length does not exceed 200 characters
- **AND** when the labels are long enough that the full hint would exceed 200 characters, the target segment and its ` → ` separator are dropped and the total length still does not exceed 200 characters

#### Scenario: An oversized sender name is shed too, not just the target segment

- **GIVEN** a sender whose `display_name` is 500 characters and a short target name and team
- **WHEN** the hint is rendered
- **THEN** its total length does not exceed 200 characters
- **AND** the sender renders as `{agent_id[:8]}` with no part of the oversized display_name present

#### Scenario: All three tools' descriptions document the hint-only contract

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `send_message`, `broadcast`, and `broadcast_to_role`
- **THEN** each description SHOULD state that auto-poke injects only a short wake-up hint (e.g. "only injects a SHORT wake-up hint" or "短提醒") and NOT the message body
- **AND** each description SHOULD reference `get_inbox` as the retrieval path
