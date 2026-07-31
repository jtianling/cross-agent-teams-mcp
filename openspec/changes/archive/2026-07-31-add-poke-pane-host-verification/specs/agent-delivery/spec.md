## ADDED Requirements

### Requirement: Tmux injection verifies the pane's current host

Before injecting into a tmux pane on behalf of a target agent row, the daemon SHALL verify that the pane is still hosted by that agent.  The verification SHALL run at the single point where every route converges on tmux injection, so that it applies uniformly to the `poke` tool, to `send_message` / `broadcast` / `broadcast_to_role` auto-poke, to retry ticks, and to every transport's tmux fallback.

The target row is read before dispatch reaches this point, so the pane may have changed hands in between.  The daemon SHALL therefore re-read current ownership from the database and reject when the row no longer holds that `(device, tmux_pane_id)`, rather than trusting the row it was handed.  This makes "Pane binding is exclusive per device with last-writer-wins" an enforced precondition of injection instead of a steady-state argument.

This ownership read SHALL be repeated immediately before the first tmux write, after the quiet-guard has run.  A single check at dispatch entry is not sufficient: the predicate awaits process/tty lookups and the quiet-guard parks for `POKE_QUIET_MS` (2 seconds by default), which is ample time for a takeover to land.  The final read SHALL be synchronous and SHALL have no `await` between it and the write it guards, so no takeover can be interleaved after it.  The residual window is then the write syscall itself, which cannot be closed without holding a lock across tmux; this is accepted and is orders of magnitude smaller than the guard window it replaces.

The predicate then resolves in order, first match wins:

1. **Target row's `device` is not the local device** → NOT verified.  A remote row's `tmux_pane_id` numbers a pane on that host and is meaningless against the local tmux server.
2. **`runtime_ui_pid` is set and that process does not exist** → NOT verified.
3. **`runtime_ui_pid` is set and that process exists** → verified iff the pid's controlling tty equals the pane's `#{pane_tty}`, or the pid equals the pane's `#{pane_pid}`.  A live process is not proof it still occupies this pane.
4. **`runtime_ui_pid` is `NULL`** → verified iff the pane exists in the current tmux pane set AND no other agent row claims the same `(device, tmux_pane_id)` while itself passing rule 2 or 3.  Agent types that legitimately carry no pid (codex, opencode) MUST NOT be rejected outright, but a row loses to a peer whose live host on that pane has been positively confirmed.

When the predicate does not verify, the daemon SHALL NOT inject, and SHALL report the skip reason `pane_reassigned`.  The mailbox row for the target SHALL still be written — verification governs the physical wake-up only, never message persistence.

When `tmux` is unavailable, rules 3 and 4 cannot be evaluated.  Unknown ownership SHALL NOT be treated as verified: the daemon SHALL NOT inject, and SHALL report the existing `tmux_unavailable` reason rather than `pane_reassigned`.  A snapshot query can fail transiently while the subsequent paste would still have reached a pane, so failing open here would inject on exactly the state the predicate exists to rule out.

The daemon MAY take a single tmux pane snapshot per fan-out round and evaluate every recipient against it, rather than querying tmux once per recipient.

#### Scenario: Dead host pid skips injection

- **GIVEN** target agent A on the local device with `tmux_pane_id='%19'` and `runtime_ui_pid` naming a process that no longer exists
- **AND** pane `%19` exists and is currently occupied by a different agent B
- **WHEN** the daemon dispatches a poke to A
- **THEN** nothing is injected into `%19`
- **AND** the skip reason for A is `pane_reassigned`
- **AND** B's pane tail is unchanged

#### Scenario: Live host on the matching pane is injected normally

- **GIVEN** target agent A on the local device with `tmux_pane_id='%19'` and `runtime_ui_pid` naming a running process whose controlling tty is pane `%19`'s tty
- **WHEN** the daemon dispatches a poke to A
- **THEN** the poke is injected into `%19` exactly as before this change

#### Scenario: Live pid sitting on a different pane skips injection

- **GIVEN** target agent A with `tmux_pane_id='%19'` and `runtime_ui_pid` naming a running process whose controlling tty belongs to pane `%31`
- **WHEN** the daemon dispatches a poke to A
- **THEN** neither `%19` nor `%31` is injected
- **AND** the skip reason for A is `pane_reassigned`

#### Scenario: Remote-device row never injects locally

- **GIVEN** target agent A whose `device` is `gx` (not the local device) and whose row carries `tmux_pane_id='%9'`
- **AND** pane `%9` exists on the local tmux server
- **WHEN** the daemon dispatches a poke to A
- **THEN** `%9` is not injected
- **AND** the skip reason for A is `pane_reassigned`

#### Scenario: Pid-less row loses to a confirmed live host on the same pane

- **GIVEN** target agent A with `tmux_pane_id='%7'` and `runtime_ui_pid IS NULL`
- **AND** another row B with the same `device` and `tmux_pane_id='%7'` whose `runtime_ui_pid` is alive on `%7`'s tty
- **WHEN** the daemon dispatches a poke to A
- **THEN** `%7` is not injected
- **AND** the skip reason for A is `pane_reassigned`

#### Scenario: Pid-less row on an uncontested live pane still injects

- **GIVEN** target agent A with `tmux_pane_id='%23'` and `runtime_ui_pid IS NULL`
- **AND** no other row claims `%23` on the same device
- **AND** pane `%23` exists
- **WHEN** the daemon dispatches a poke to A
- **THEN** the poke is injected into `%23`

#### Scenario: An unqueryable tmux performs zero writes

- **GIVEN** the tmux pane snapshot cannot be obtained
- **WHEN** the daemon dispatches a poke to a target with `tmux_pane_id` set
- **THEN** no tmux write of any kind is issued — not the quiet-guard capture, not the paste
- **AND** the reported reason is `tmux_unavailable`, not `pane_reassigned` and not a success

#### Scenario: A takeover that lands during the quiet-guard still blocks the write

- **GIVEN** a target that passes host verification at dispatch entry
- **AND** another agent binds the same pane while the quiet-guard is parked
- **WHEN** the guard completes and the poke is about to write
- **THEN** the pre-write ownership read observes the takeover
- **AND** no tmux write occurs and the reason is `pane_reassigned`

#### Scenario: Every tmux route reports the same reason for the same state

- **GIVEN** a target whose pane cannot be verified because tmux is unqueryable
- **WHEN** the poke arrives through the fan-out dispatcher, through a transport's tmux fallback, or through the legacy path taken when no `ChannelWakeFanout` is supplied
- **THEN** all three report `tmux_unavailable`
- **AND** none of them surfaces an internal verdict value in its place

#### Scenario: A pane that changed hands after the target row was read

- **GIVEN** target agent A's row was read while it held `tmux_pane_id='%19'`
- **AND** agent B subsequently binds `%19`, which clears A's binding per last-writer-wins
- **WHEN** the daemon dispatches the already-in-flight poke to A
- **THEN** the current binding is re-read, A is found to no longer hold `%19`
- **AND** nothing is injected and the skip reason is `pane_reassigned`

#### Scenario: Mailbox row is written even when injection is skipped

- **GIVEN** target agent A whose pane fails verification
- **WHEN** a sender calls `send_message` to A with default `auto_poke`
- **THEN** the message is persisted to A's mailbox with the full body
- **AND** the response reports `poked: false` with reason `pane_reassigned`
- **AND** A reads the message on its next `get_inbox` after it comes back online

#### Scenario: Verification covers direct send_message, not only broadcast

- **GIVEN** target agent A whose pane fails verification
- **WHEN** a sender calls `send_message_by_id({to_agent_id: A, ...})`
- **THEN** no injection occurs and the reason is `pane_reassigned`
- **AND** the same holds when the poke originates from `broadcast`, `broadcast_to_role`, a retry tick, or a direct `poke` tool call

## MODIFIED Requirements

### Requirement: Poke dispatch routes by delivery.kind

The daemon's poke dispatcher SHALL select the backend transport based on the target agent's `delivery.kind` value, with the following routing:

- `kind === 'claude-channel'` → deliver via `ChannelWakeFanout` using `delivery.channel_session_id`, per `claude-channel-transport` spec; if no subscribed sink exists and `tmux_pane_id` is set, it MAY fall back to tmux injection, subject to "Tmux injection verifies the pane's current host".
- `kind === 'none'` → fall back to tmux injection if `tmux_pane_id` is set, subject to "Tmux injection verifies the pane's current host"; otherwise fail with `no_transport_available`.
- `kind === 'codex-appserver'` → deliver via the Codex websocket dispatcher defined in `codex-appserver-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.
- `kind === 'opencode-server'` → deliver via the opencode HTTP dispatcher defined in `opencode-server-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.
- `kind === 'kimi-server'` → deliver via the kimi HTTP dispatcher defined in `kimi-server-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.

Every tmux fallback reachable from any route, including the legacy tmux-only path taken when no `ChannelWakeFanout` is supplied, SHALL pass host verification first.

#### Scenario: Route kind 'claude-channel' to ChannelWakeFanout

- **GIVEN** target agent has `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` and a sink attached under `csid-abc`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the sink is invoked exactly once with the poke payload

#### Scenario: Unsubscribed channel falls back to tmux only when the pane verifies

- **GIVEN** target agent has `delivery={kind: 'claude-channel', channel_session_id: 'csid-dead'}` with no attached sink and `tmux_pane_id='%19'`
- **WHEN** the daemon dispatches a poke and `%19` passes host verification
- **THEN** the poke is injected into `%19`
- **AND** when `%19` instead fails host verification, nothing is injected and the reason is `pane_reassigned`

#### Scenario: Route kind 'none' to tmux when pane is set

- **GIVEN** target agent has `delivery={kind: 'none'}` and `tmux_pane_id='%42'` that passes host verification
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the poke is injected via tmux to pane `%42`

#### Scenario: Route kind 'none' with no tmux returns no_transport_available

- **GIVEN** target agent has `delivery={kind: 'none'}` and `tmux_pane_id IS NULL`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the dispatcher returns `{error: 'no_transport_available'}`

#### Scenario: Route kind 'codex-appserver' to Codex dispatcher

- **GIVEN** target agent has `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the Codex dispatcher with that `thread_id` and `ws_url`

#### Scenario: Codex dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}`
- **AND** the Codex dispatcher fails with `{ error: 'codex_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'codex_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically

#### Scenario: Route kind 'opencode-server' to opencode dispatcher

- **GIVEN** target agent has `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the opencode dispatcher with that `session_id` and `base_url`

#### Scenario: opencode dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **AND** the opencode dispatcher fails with `{ error: 'opencode_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'opencode_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically

#### Scenario: Route kind 'kimi-server' to kimi dispatcher

- **GIVEN** target agent has `delivery={kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the kimi dispatcher with that `session_id` and `base_url`

#### Scenario: kimi dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627'}`
- **AND** the kimi dispatcher fails with `{ error: 'kimi_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'kimi_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically
