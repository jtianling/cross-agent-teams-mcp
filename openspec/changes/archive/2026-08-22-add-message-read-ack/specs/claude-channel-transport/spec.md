## MODIFIED Requirements

### Requirement: ChannelWakeFanout tracks sinks keyed by channel_session_id

The daemon SHALL maintain an in-memory `ChannelWakeFanout` map from `channel_session_id: string` to a single sink callback that emits JSON-RPC notifications on the subscribing MCP session's Streamable HTTP transport.  Only the most recent subscription per `channel_session_id` is retained; re-subscription replaces the previous sink.

`send` SHALL report whether the payload was actually accepted: it MUST return `true` only when the sink returned normally, and `false` when no sink is attached OR when the sink threw.  A throwing sink MUST NOT be reported as a successful send.

This is a behavioral change.  Previously a throwing sink was swallowed and `send` still returned `true`, which made this the weakest delivery signal in the daemon: a Claude host whose channel had gone away still produced `poked: true` on every `send_message` aimed at it, and the retry ladder never engaged because nothing had reported a failure.

A sink that throws MUST remain attached.  A transient write error is not evidence the subscriber is gone, and detaching inside `send` would race the channel proxy's own subscribe/unsubscribe lifecycle.

#### Scenario: attach and send fan out only to the matched sink

- **GIVEN** no sinks attached
- **WHEN** `attach('csid-1', sink1)` and `attach('csid-2', sink2)` are called
- **THEN** `send('csid-1', payload)` invokes `sink1` exactly once and does NOT invoke `sink2`

#### Scenario: detach removes sink

- **GIVEN** `attach('csid-1', sink1)` has been called
- **WHEN** `detach('csid-1')` is called, then `send('csid-1', payload)` is called
- **THEN** `sink1` is NOT invoked

#### Scenario: re-subscription replaces prior sink

- **GIVEN** `attach('csid-1', sinkA)` has been called
- **WHEN** `attach('csid-1', sinkB)` is called, then `send('csid-1', payload)` is called
- **THEN** `sinkB` is invoked exactly once and `sinkA` is NOT invoked

#### Scenario: detachBySession removes all sinks owned by an MCP session

- **GIVEN** MCP session `sess-P` attached sinks under `csid-1` and `csid-2` (both created from `sess-P`'s transport)
- **WHEN** `detachBySession('sess-P')` is called
- **THEN** `ChannelWakeFanout` contains no entry for `csid-1` nor `csid-2`

#### Scenario: a successful sink reports success

- **GIVEN** `attach('csid-1', sink)` where `sink` returns normally
- **WHEN** `send('csid-1', payload)` is called
- **THEN** it returns `true`

#### Scenario: a throwing sink reports failure and stays attached

- **GIVEN** `attach('csid-1', sink)` where `sink` throws
- **WHEN** `send('csid-1', payload)` is called
- **THEN** it returns `false`
- **AND** `has('csid-1')` is still `true`

#### Scenario: an absent sink reports failure

- **WHEN** `send('csid-unknown', payload)` is called with no sink attached
- **THEN** it returns `false`

### Requirement: daemon emits notifications/channel_wake with sanitized meta

The daemon SHALL expose an internal `sendChannelWake(channel_session_id, {content: string, meta: Record<string, string>})` function.  If a sink is attached for the given `channel_session_id`, it emits a JSON-RPC notification with method `notifications/channel_wake` and params `{content, meta}`.  Meta keys NOT matching `/^[A-Za-z0-9_]+$/` MUST be silently dropped before send.  Meta values MUST be strings.  If no sink is attached, `sendChannelWake` returns `{ok: false, reason: 'no_subscriber'}` without emitting.

The result is three-valued, not two-valued: when a sink IS attached but its write throws, `sendChannelWake` MUST return `{ok: false, reason: 'sink_failed'}`.  The two failure reasons MUST stay distinct, because they call for different handling — `no_subscriber` means there is nothing to write to, while `sink_failed` means a subscriber is attached and this particular write did not land.

#### Scenario: sendChannelWake emits notifications/channel_wake payload

- **GIVEN** a sink attached under `'csid-abc'` that records emitted JSON-RPC payloads
- **WHEN** `sendChannelWake('csid-abc', {content: 'you have 3 unread', meta: {message_count: '3', latest_sender: 'alice'}})` is called
- **THEN** the recorded payload equals `{jsonrpc: '2.0', method: 'notifications/channel_wake', params: {content: 'you have 3 unread', meta: {message_count: '3', latest_sender: 'alice'}}}`

#### Scenario: meta keys containing hyphens are dropped before send

- **GIVEN** a sink attached under `'csid-abc'`
- **WHEN** `sendChannelWake('csid-abc', {content: 'hi', meta: {message_count: '3', 'bad-key': 'oops'}})` is called
- **THEN** the recorded payload's `params.meta` equals `{message_count: '3'}` (`'bad-key'` dropped)

#### Scenario: sendChannelWake with no subscriber returns no_subscriber

- **GIVEN** no sink attached under `'csid-none'`
- **WHEN** `sendChannelWake('csid-none', {content: 'x', meta: {}})` is called
- **THEN** the return value equals `{ok: false, reason: 'no_subscriber'}`
- **AND** no JSON-RPC payload is emitted on any transport

#### Scenario: sendChannelWake with a throwing sink returns sink_failed

- **GIVEN** a sink attached under `'csid-abc'` whose write throws
- **WHEN** `sendChannelWake('csid-abc', {content: 'x', meta: {}})` is called
- **THEN** the return value equals `{ok: false, reason: 'sink_failed'}`

## ADDED Requirements

### Requirement: A failed channel write falls back to tmux and is otherwise reported as its own skip reason

When a Claude target's channel sink is attached but its write fails, the daemon MUST NOT treat the wake-up as delivered.

1. If the target also has a `tmux_pane_id`, the daemon MUST fall back to the tmux transport exactly as it does when no subscriber is attached.
2. If no tmux fallback exists, the dispatch MUST fail with `channel_sink_failed`, and auto-poke MUST surface `channel_sink_failed` as the recipient's `poke_skip_reasons` entry.

`channel_sink_failed` MUST NOT be collapsed into `no_transport_available` / `no_pane`.  The two describe different states — a subscriber that is attached and failing versus no transport at all — and only the distinct value lets a reader tell them apart; collapsing them would reintroduce, one layer up, the false signal that reporting the sink failure was meant to remove.

Note what this Requirement does NOT claim: ordinary sends do not retry `channel_sink_failed`.  The auto-poke retry ladder is scheduled only for `guard_failed` on a pane-bound target and for `kimi_session_busy`, and a pane-less channel target has neither.  The mailbox row is written regardless, the recipient still sees the message on its next `get_inbox`, and an unread reply-expecting message still raises the 15-minute alert.  The `message-read-ack` capability does treat `channel_sink_failed` as transient, but only for retrying the watchdog's own alert poke.

The MCP descriptions of the send tools SHALL list `channel_sink_failed` among the possible `poke_skip_reasons` values and state that the mailbox row is still written.

#### Scenario: Channel write failure falls back to the tmux pane

- **GIVEN** agent B has a `claude-channel` delivery whose sink throws, and a registered `tmux_pane_id`
- **WHEN** agent A sends B a message with auto-poke enabled
- **THEN** the daemon dispatches the wake-up over tmux

#### Scenario: Channel write failure without a pane reports channel_sink_failed

- **GIVEN** agent B has a `claude-channel` delivery whose sink throws, and no `tmux_pane_id`
- **WHEN** agent A sends B a message with auto-poke enabled
- **THEN** the send reports `poked: false`
- **AND** `poke_skip_reasons` contains `channel_sink_failed` for B
- **AND** the mailbox row for B is still written

#### Scenario: Send tool descriptions document channel_sink_failed

- **WHEN** a client fetches the MCP tool list via `tools/list`
- **THEN** the descriptions of `send_message` and `send_message_by_id` list `channel_sink_failed` among `poke_skip_reasons`
