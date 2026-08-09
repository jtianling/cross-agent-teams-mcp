# mcp-transport Specification

## Purpose

Expose the MCP Streamable HTTP transport, manage per-session identifiers, and provide the built-in `echo` tool plus Phase 0 three-agent connectivity coverage.
## Requirements
### Requirement: MCP Streamable HTTP transport mount

The daemon SHALL expose the MCP Streamable HTTP endpoint at `POST /mcp` using `@modelcontextprotocol/sdk` server transport. The endpoint MUST accept JSON-RPC 2.0 framed requests and MAY upgrade to SSE for server→client streaming per the 2025 MCP spec.

#### Scenario: MCP initialize succeeds

- **WHEN** an MCP client sends `initialize` to `POST /mcp`
- **THEN** the daemon returns a valid JSON-RPC response with `protocolVersion` and `capabilities.tools` set

### Requirement: Session id assignment

The transport SHALL assign a unique session id (UUID v4) to every new MCP HTTP session and surface it via the `Mcp-Session-Id` response header. Subsequent requests from the same client MUST include that header.

When a request (POST, GET, or DELETE on `/mcp`) presents an `Mcp-Session-Id` that the daemon does not currently hold (never issued, or already reaped/closed), the daemon MUST reject it with **HTTP 404**. This aligns with the MCP Streamable HTTP transport spec: a `404` in response to a request carrying a session id is the standard signal for the client to start a new session by re-sending `initialize` WITHOUT a session id. The guarantee this requirement establishes is that the rejection MUST NOT poison a strict client's transport (see the body rule below); whether a specific client transparently re-initializes AND retries the in-flight request on receiving the `404` is client-side behavior and is NOT asserted by this requirement.

The response body for this rejection MUST NOT be a bare `{ "error": <string> }` object. Strict MCP clients deserialize ANY response body as a JSON-RPC message; a bare `{ "error": ... }` object matches no JSON-RPC 2.0 variant and poisons the client's transport worker (observed symptom: `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage`, after which every subsequent tool call fails with `Transport send error`). The body MUST therefore be either:

- an empty body (the safe default), or
- a well-formed JSON-RPC 2.0 error object `{ "jsonrpc": "2.0", "id": null, "error": { "code": <integer>, "message": <string> } }` that a strict client can deserialize without error.

The chosen form MUST be verified against a strict `rmcp`-based client (see design). A request that fails session lookup MUST NOT bump any session timestamp.

#### Scenario: Two clients receive distinct session ids

- **WHEN** two independent MCP clients call `initialize`
- **THEN** each receives a different `Mcp-Session-Id` header value

#### Scenario: Follow-up request with unknown session id

- **WHEN** a client sends a tool call with `Mcp-Session-Id: <random-uuid-never-issued>`
- **THEN** response status is `404`
- **AND** the response body is NOT a bare `{ "error": "unknown_session" }` object (it is empty or a valid JSON-RPC 2.0 error object)

#### Scenario: Reaped-session request is not transport-poisoning and a fresh initialize is accepted

- **GIVEN** an MCP session id that was force-closed by orphan GC
- **WHEN** a client issues a request reusing that now-unknown session id
- **THEN** the daemon returns `404` with a non-poisoning body (no bare `{ "error": ... }` object)
- **AND** a subsequent `initialize` sent WITHOUT a session id succeeds and yields a fresh `Mcp-Session-Id` (the daemon does not carry over any poisoned state)

### Requirement: MCP session is tagged with origin and peer address

For every MCP HTTP request, the daemon SHALL classify the connecting peer as `origin: 'local' | 'remote'` based on the socket's remote address:

- `local`: the socket's `remoteAddress` belongs to a loopback range — IPv4 `127.0.0.0/8`, IPv6 `::1`, or `::ffff:127.0.0.0/8`. Unix-domain sockets (if ever used) are treated as `local`.
- `remote`: any other address.

When the request belongs to an MCP session identified by `Mcp-Session-Id`, the daemon SHALL stash `{ origin, remote_addr }` on the in-memory session record. The `remote_addr` value is the raw socket remote address string for `remote` sessions, and `null` for `local` sessions. The tagging happens at the transport layer (e.g. a Fastify `onRequest` hook) BEFORE any tool dispatch and MUST be available to tool handlers invoked on that session.

The session tag is daemon-internal: it MUST NOT appear in any tool response payload, MUST NOT appear in `list_agents` output, and MUST NOT be exposed through any introspection tool. It is consumed only by:

- `register_agent` (in `agent-registry`) — to enforce device-spoofing guards and to write `remote_addr` on the agent row for non-loopback registrations.
- Daemon-internal audit logging at debug level.

#### Scenario: Loopback session is tagged local

- **GIVEN** an MCP client connects from `127.0.0.1` and obtains a session id
- **WHEN** any tool is dispatched on that session
- **THEN** the daemon's session record for that session id has `origin = 'local'` and `remote_addr = null`

#### Scenario: Non-loopback session is tagged remote with peer address

- **GIVEN** the daemon is bound to `0.0.0.0:9100` with a token
- **WHEN** an MCP client connects from `10.0.0.42` and obtains a session id
- **THEN** the daemon's session record for that session id has `origin = 'remote'` and `remote_addr = '10.0.0.42'`

#### Scenario: IPv6 loopback ::1 is tagged local

- **GIVEN** an MCP client connects from `::1` and obtains a session id
- **THEN** the session record has `origin = 'local'`

#### Scenario: IPv4-mapped IPv6 loopback is tagged local

- **GIVEN** an MCP client connects from `::ffff:127.0.0.1` and obtains a session id
- **THEN** the session record has `origin = 'local'`

#### Scenario: origin and remote_addr are NOT returned by list_agents

- **GIVEN** agents exist in the caller's team registered from both loopback and remote sessions
- **WHEN** the caller invokes `list_agents()`
- **THEN** no entry in the `agents[]` response array contains a key named `origin`
- **AND** no entry contains a key named `remote_addr`

### Requirement: Echo tool for connectivity probing

The daemon SHALL register a built-in tool `echo(msg: string)` that returns `{ msg, echoed_at: <ISO8601 timestamp> }`. This tool is unauthenticated by the tool layer (auth applies at transport layer only) and is used to confirm three-way MCP client compatibility before any business tool is shipped.

#### Scenario: Echo returns input and timestamp

- **WHEN** client calls `echo({ msg: "hi" })`
- **THEN** response is `{ msg: "hi", echoed_at: <valid ISO8601> }`

### Requirement: Three-agent Phase 0 connectivity

Before any business tool is released, the project SHALL include an automated Phase 0 connectivity test that starts the daemon and drives three MCP clients simulating opencode, Claude Code, and Codex CLI over Streamable HTTP. All three MUST successfully call `echo` within the same daemon session.

#### Scenario: All three agents connect and echo

- **GIVEN** daemon started on a random free port
- **WHEN** three MCP clients (opencode-style, Claude-Code-style, Codex-CLI-style) each open a Streamable HTTP session and call `echo({ msg: "<role>" })`
- **THEN** each client receives the correct echoed message
- **AND** `list_agents` (once Phase 1 exists) returns three distinct agent_id values

### Requirement: SSE fanout keyed by agent_id, attached after register_agent

The SSE fanout sink for an MCP session SHALL be attached to `SseFanout` keyed by the session's final `agent_id` (as returned by `register_agent`), **not** by the MCP session id. Attachment MUST be deferred until the first successful `register_agent` call on that session.

当 `register_agent` 成功并返回 `agent_id=X` 时:

1. Transport MUST 调用 `fanout.attach(X, team, sink)`, 其中 `sink` 绑定到当前 session 的 `StreamableHTTPServerTransport`.  如果 key `X` 已存在 sink, `attach` MUST 原子替换旧 sink, 并保持 `X` 下仅有一个活动 sink.
2. Transport MUST 更新 `agentIdHolder.current = X`, 使后续 `from_agent_id` 防伪检查与 `X` 比较.
3. Transport MUST 在 session 记录中保存成功注册的 `team`, 以便并发同身份 session 关闭时恢复 fanout 所有权.

当 MCP session 关闭并触发 `transport.onclose` 时:

1. 如果该 session 已完成注册, 且另一个活动 session 持有相同 `agent_id`, transport MUST 将 fanout sink 恢复为另一个活动 session 的 sink.
2. 如果该 session 是该 `agent_id` 的唯一活动 session, transport MUST 执行 `fanout.detach(agentIdHolder.current)`.
3. 如果该 session 从未成功调用 `register_agent`, transport MUST 不修改 fanout.

Takeover 或 orphan GC 发起强制关闭时, transport MUST 调用同一个幂等 session 清理器, 立即从 `sessions`, Authorization owner 和注册连接账本中撤销该 session.  SDK transport 的异步 `close()` 失败 MUST 被显式记录, 但不得恢复已撤销的路由.  SDK 后续触发 `onclose` 时, 同一个清理器 MUST 安全地 no-op.

#### Scenario: Fanout attached after register_agent, not at session init

- **GIVEN** a freshly initialized MCP session with session id `sess-A` and no `register_agent` yet
- **WHEN** an internal caller inspects `SseFanout` state
- **THEN** no sink is attached under key `sess-A`
- **AND** no sink is attached under any key originating from this session

#### Scenario: Register triggers fanout attach under returned agent_id

- **GIVEN** a session `sess-A` that calls `register_agent` and receives `agent_id='X'`
- **WHEN** the tool call completes
- **THEN** `SseFanout` has exactly one sink attached under key `'X'`
- **AND** no sink is attached under key `sess-A`

#### Scenario: Cross-session reuse replaces prior sink

- **GIVEN** session `sess-A` registered `(default, alice, backend)` and holds the sink attached under `agent_id='X'`
- **WHEN** a new session `sess-B` registers the same identity and also receives `agent_id='X'`
- **THEN** the fanout sink for `X` is now `sess-B`'s transport
- **AND** `sess-A`'s old sink was detached before `sess-B`'s attach (net: exactly one sink under `X`)
- **AND** subsequent `fanout.emit('X', event)` reaches `sess-B`'s SSE stream, not `sess-A`'s

#### Scenario: 唯一 session 关闭后移除 agent_id sink

- **GIVEN** `sess-A` 是 `agent_id='X'` 的唯一活动 session, 并持有该 key 下的 sink
- **WHEN** HTTP transport 触发 `onclose`
- **THEN** `SseFanout` 在 key `'X'` 下没有 sink

#### Scenario: 关闭并发 Codex session 后恢复剩余 session 的 sink

- **GIVEN** `sess-A` 和 `sess-B` 属于同一 Codex thread, 都持有 `agent_id='X'`, 且当前 sink 属于 `sess-B`
- **WHEN** `sess-B` 的 HTTP transport 触发 `onclose`
- **THEN** `SseFanout` 在 key `'X'` 下绑定 `sess-A` 的 sink
- **AND** `SseFanout` 在 key `'X'` 下仍只有一个 sink

#### Scenario: Close before register is a no-op for fanout

- **GIVEN** a session that initialized but never successfully called `register_agent`
- **WHEN** the HTTP transport emits `onclose`
- **THEN** the fanout state is unchanged (no spurious detach, no error)

### Requirement: MCP server initialize returns instructions field with xats abbreviation and team-default convention

The daemon's `McpServer` instance SHALL declare a non-empty `instructions` field (via the `ServerOptions.instructions` constructor argument) so that every MCP session's `initialize` response exposes it to the calling client / LLM.  The `instructions` string MUST convey at least these two conventions, in any prose form the implementer chooses:

1. **Abbreviation**: `xats` is an abbreviation for `cross-agent-teams`; when users or other agents mention `xats`, they refer to this MCP server (the `cross-agent-teams-mcp` daemon) and its registered tools.
2. **Team default on registration**: when invoking `register_agent`, if the end user has not explicitly specified a `team`, the LLM client SHOULD pass its current working directory as `project_dir` so the daemon can derive a project-scoped default team (instead of falling back to the global `'default'` team).

The `instructions` string MUST be a single plain string (the MCP protocol slot is not a list).  It MUST be present on every session; it MUST NOT be gated on runtime state.  The string MUST NOT name `register_claude_self` or `register_codex_self` (those tools are removed; see `agent-registry`'s "register_claude_self and register_codex_self tools removed from MCP tool surface" requirement).

#### Scenario: initialize response includes instructions string

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `initialize` response contains a non-empty `instructions` field whose value is a string

#### Scenario: instructions content mentions xats abbreviation

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string contains the literal substring `xats`
- **AND** the `instructions` string contains the literal substring `cross-agent-teams`

#### Scenario: instructions content mentions project_dir team default convention

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string contains the literal substring `project_dir`
- **AND** the `instructions` string mentions (case-insensitively) both `team` and the intent of using the current working directory when `team` is unspecified

#### Scenario: instructions do not name removed self tools

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string does NOT contain the literal substring `register_claude_self`
- **AND** the `instructions` string does NOT contain the literal substring `register_codex_self`

### Requirement: MCP server instructions field includes anti-pattern paragraph forbidding list_agents pre-check before send_message

The daemon's `McpServer` `instructions` field (declared via `ServerOptions.instructions`, exposed in every session's `initialize` response per the existing "MCP server initialize returns instructions field" requirement) SHALL contain a server-level anti-pattern paragraph that reinforces the per-tool description rules introduced for `list_agents` and `send_message`. The prose may be reworded, but the `instructions` string MUST contain all of:

1. The literal substring `list_agents`.
2. The literal substring `send_message`.
3. The literal substring `unknown_recipient`.
4. A directive forbidding using `list_agents` to pre-verify a recipient before `send_message` (case-insensitive match on `DO NOT` / `MUST NOT` together with `pre` within the same sentence as `list_agents`).
5. A statement that `list_agents` is caller-team scoped and cannot see cross-team agents (case-insensitive match on `caller`'s team or `caller-team` together with prose declaring inability to see other teams).

The directive SHALL appear as part of the existing single `instructions` string — no new instructions slot is introduced. The paragraph SHALL coexist with the previously specified content (xats abbreviation, project_dir team default) without removing or contradicting it.

#### Scenario: instructions string contains the anti-pattern paragraph

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string contains the literal substring `list_agents`
- **AND** the string contains the literal substring `send_message`
- **AND** the string contains the literal substring `unknown_recipient`

#### Scenario: instructions string uses jussive prose for the pre-check ban

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string contains directive prose forbidding pre-verification (case-insensitive match on `DO NOT` or `MUST NOT` together with `pre` within the same sentence as `list_agents`)

#### Scenario: instructions string declares list_agents caller-team scope at server level

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string declares that `list_agents` is scoped to the caller's team and cannot see cross-team agents (case-insensitive match on `caller`'s team or `caller-team`, together with prose stating inability to see other teams)

#### Scenario: instructions string preserves existing required content

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string still contains the literal substring `xats`
- **AND** the string still contains the literal substring `cross-agent-teams`
- **AND** the string still contains the literal substring `project_dir`

### Requirement: Orphan session garbage collection

The daemon SHALL run a periodic ticker that walks the in-memory `sessions` Map maintained by `mountMcp` and force-closes unregistered sessions that exceed the configured idle window, max-age window, or unregistered-session count limit. The daemon MUST also enforce the unregistered-session count limit immediately after a new MCP session is initialized.

Each session MUST track a `lastActivityAt` timestamp. `lastActivityAt` MUST be initialized to the value of `createdAt` inside `onsessioninitialized`, and MUST be set to `Date.now()` whenever a POST, GET, or DELETE request matches that session (i.e. on every successful transport-level interaction). Requests that fail session lookup with the unknown-session rejection MUST NOT bump any timestamp.

A session is "orphan" if and only if:

1. `agentIdHolder.current === undefined` (no successful `register_agent` has bound an agent_id to the session yet).

Orphan-session reaping is **idle-based and cap-based**. An orphan session MUST be reaped when either of these conditions is true:

1. `Date.now() - session.lastActivityAt >= idleMs` (no transport-level client activity within the idle grace window). An orphan whose `lastActivityAt` was bumped by a client POST/GET/DELETE within the last `idleMs` is therefore NOT reaped by this rule: an actively-transacting but not-yet-registered client (for example a codex session mid-setup or immediately after `compact`) is treated as a live client, not a zombie. Zombie sessions that only hold a server→client stream open never bump `lastActivityAt` (heartbeats are server→client and do not count as activity), so they still fall to this idle reap.
2. The number of orphan sessions exceeds `maxSessions`; the daemon MUST reap the oldest orphan sessions first until the number of remaining orphans is at most `maxSessions`. This cap applies regardless of recent activity, so it still bounds the total number of unregistered sessions.

Max-age is NOT an independent reap trigger. Once an orphan with recent client activity is exempt from age-based reaping, a max-age rule would only ever fire on sessions the idle rule already reaps (its condition is a strict subset of the idle rule), so it is redundant and MUST NOT be encoded as a live, separately-reachable branch.

The default idle window SHALL be `300_000 ms` (5 minutes). The default MUST be overridable via the `ORPHAN_GC_IDLE_MS` environment variable or the `orphanGcIdleMs` `ServerOpts` field, both of which accept a positive integer (millisecond) value.

The `ORPHAN_GC_MAX_AGE_MS` environment variable and the `orphanGcMaxAgeMs` `ServerOpts` field MUST still be accepted (a positive integer millisecond value) so existing configuration does not error, but they are now **inert**: no reap decision depends on a max-age window. They are retained only for backward compatibility.

The default orphan-session limit SHALL be `500`. The default MUST be overridable via the `ORPHAN_GC_MAX_SESSIONS` environment variable or the `orphanGcMaxSessions` `ServerOpts` field, both of which accept a positive integer value.

Force-closing an orphan session MUST invoke `session.transport.close()`. Closing the transport MUST propagate to the existing `onclose` chain so the session is removed from `sessions` Map, the SSE fanout binding is detached (if any), the channel-wake fanout binding is detached (if any), and the `sessionOwners` Authorization-hash binding is removed.

Sessions whose `agentIdHolder.current` is set (i.e. that have completed at least one successful `register_agent`) MUST NEVER be touched by this GC, regardless of how long they have been idle.

The GC tick interval MUST be at least 30 seconds (long enough that the GC itself does not contribute meaningful CPU pressure even with thousands of orphans). The default tick interval SHALL be 60 seconds.

The GC ticker MUST be cleared when the Fastify app emits `onClose`, alongside the existing cleanup ticker registered in `buildServer`.

The GC MUST NOT emit orphan-reap log lines by default. When an explicit MCP transport logger is configured by the embedding daemon or test harness, the GC MAY emit a debug-level log line for each orphan it reaps, including the orphan's MCP session id, age in seconds, idle duration in seconds, and reap reason.

#### Scenario: Orphan session past idle grace is reaped

- **GIVEN** an MCP client opens a connection and the daemon assigns session `sess-X`
- **AND** the client never calls `register_agent` and issues no further transport-level requests
- **AND** the GC tick fires more than `idleMs` after `sess-X`'s `lastActivityAt`
- **WHEN** the GC walks the sessions Map
- **THEN** `sess-X` is force-closed (its transport's `close()` method invoked)
- **AND** `sess-X` is removed from the `sessions` Map after the onclose chain settles

#### Scenario: Activity bumps the idle clock and prevents reap

- **GIVEN** session `sess-W` was created and `agentIdHolder.current` is still `undefined`
- **AND** the client issues any matching POST/GET/DELETE on `sess-W` (e.g. a tool call) shortly before the GC tick
- **AND** the orphan count is at or below `maxSessions`
- **WHEN** the GC tick fires within `idleMs` of that activity
- **THEN** `sess-W` is NOT force-closed
- **AND** `sess-W` remains in the `sessions` Map

#### Scenario: Active orphan past max age is NOT reaped

- **GIVEN** session `sess-A` was created more than `maxAgeMs` ago
- **AND** `sess-A` has not completed `register_agent`
- **AND** the client recently issued a matching POST/GET/DELETE so `sess-A` is still within `idleMs` of activity
- **WHEN** the GC tick fires
- **THEN** `sess-A` is NOT force-closed (recent client activity keeps it within the idle window, and there is no independent max-age reap)
- **AND** `sess-A` remains in the `sessions` Map

#### Scenario: Idle orphan past max age is reaped

- **GIVEN** session `sess-B` was created more than `maxAgeMs` ago
- **AND** `sess-B` has not completed `register_agent`
- **AND** `sess-B` has had no client transport activity within `idleMs`
- **WHEN** the GC tick fires
- **THEN** `sess-B` is force-closed by the idle rule
- **AND** no console output is emitted unless an explicit MCP transport logger was configured

#### Scenario: Orphan cap reaps oldest unregistered sessions only

- **GIVEN** the daemon has more than `maxSessions` orphan sessions
- **AND** it also has registered sessions that may be long idle
- **WHEN** the GC tick fires
- **THEN** the daemon force-closes the oldest orphan sessions until at most `maxSessions` orphans remain
- **AND** registered sessions are not force-closed by this cap
- **AND** an active orphan may still be reaped by this cap despite recent activity

#### Scenario: New orphan creation enforces cap immediately

- **GIVEN** the daemon already has `maxSessions` orphan sessions
- **WHEN** a new MCP session is initialized and remains unregistered
- **THEN** the daemon force-closes the oldest orphan session without waiting for the next GC tick
- **AND** the newly initialized session remains available

#### Scenario: Registered session is exempt from GC

- **GIVEN** session `sess-Y` called `register_agent` successfully one second after `initialize` 24 hours ago
- **AND** no further activity has occurred on `sess-Y` since then
- **WHEN** the GC tick fires
- **THEN** `sess-Y` is NOT force-closed
- **AND** `sess-Y` remains in the `sessions` Map

#### Scenario: Orphan session within grace is not yet reaped

- **GIVEN** session `sess-Z` was created 10 seconds ago with no subsequent activity
- **AND** `sess-Z`'s `agentIdHolder.current` is `undefined`
- **AND** the orphan count is at or below `maxSessions`
- **WHEN** the GC tick fires with the default 5-minute grace
- **THEN** `sess-Z` is NOT force-closed
- **AND** `sess-Z` remains in the `sessions` Map

#### Scenario: Reap propagates to fanout and channel bindings

- **GIVEN** an orphan session `sess-O` had registered an SSE fanout sink (e.g. via a half-completed registration path that bound the sink before failing) and a channel-wake sink
- **WHEN** the GC reaps `sess-O`
- **THEN** the SSE fanout no longer holds a sink for `sess-O`
- **AND** the channel-wake fanout no longer holds a sink for `sess-O`'s session id

### Requirement: Handshake-level kimi identity rebind via request headers

When an MCP session is not bound to an agent and a POST request carries the identity header `X-Kimi-Session-Id` (the kimi session id, optionally accompanied by `X-Kimi-Base-Url`, the kimi server base URL), the daemon SHALL attempt to bind the session to the already-registered agent that claims that identity, so that a client reconnect, MCP config hot-reload, or daemon restart does not surface `unknown_agent` to an agent that previously registered. Clients that send these headers attach them to `initialize` and to every subsequent request.

Sending the headers is a CLIENT-SIDE capability that this requirement does NOT assume any kimi build has. It needs a kimi supporting session-scoped MCP entries (`scope: "session"`) plus `${VAR}` interpolation in header values resolved from a per-session environment overlay. A kimi lacking either omits the headers, or would send a literal `${...}`; both land on the "no bind, no error" path below, so the daemon stays correct against any kimi. Nothing here describes kimi's own behaviour in general — do not read it as a claim about upstream kimi.

The bind attempt MUST:

1. Reverse-lookup candidate agent rows on the local device with a `kimi-server` delivery claiming the presented `session_id` — by `(base_url, session_id)` when `X-Kimi-Base-Url` is present, or by `session_id` alone when it is absent (the unique matching row then supplies the base_url to probe). Zero matches → no bind; multiple matches → no bind (fail closed).
2. Probe-validate the live kimi session before binding, reusing exactly the reconnect path's `validateKimiSession` semantics (GET `<base_url>/api/v1/sessions/<session_id>`, payload id must match and must not be archived; bearer resolution is the row's `auth_token_ref`, else the kimi token file). Any probe failure → no bind (fail closed).
3. On success, associate the connection with the agent row using the same semantics as `reconnect`: attach the SSE fanout and set the session's `agentIdHolder` (no registry mutation), and record the connection in the cross-session ledger under the kimi runtime key so it SHARES the identity with live connections of the same kimi session instead of taking them over.

The daemon MUST NOT synthesize identity from any channel other than these explicit headers (no clientInfo sniffing, no source-IP heuristics). A failed or skipped bind MUST NOT produce an error response: the session stays unregistered and the normal `register_agent` / `reconnect` paths remain available, with the `unknown_agent` recovery hint as the fallback guidance.

Bind attempts SHALL be memoized per `(session, presented identity)`: terminal outcomes (`bound`, `no_match`, `ambiguous`) are recorded so each identity is probed at most once per session, while a `probe_failed` outcome MAY be retried by a later request. A non-`initialize` POST on an unbound session MUST await any in-flight bind attempt before the request is dispatched, so the first tool call after reconnect cannot race the probe into a spurious `unknown_agent`.

#### Scenario: Fresh session binds at initialize via identity headers

- **GIVEN** agent `kimi-1` is registered on the local device with a `kimi-server` delivery `{base_url: B, session_id: S}` and the kimi server at `B` reports session `S` as live
- **WHEN** a new MCP client initializes with headers `X-Kimi-Session-Id: S` and `X-Kimi-Base-Url: B`
- **THEN** the new session is bound to `kimi-1`'s `agent_id` without any `register_agent` call
- **AND** a subsequent `get_inbox` on that session succeeds instead of returning `unknown_agent`

#### Scenario: Base-url header absent binds via unique session id reverse lookup

- **GIVEN** exactly one local `kimi-server` agent row claims session id `S`
- **WHEN** a new MCP client initializes with only `X-Kimi-Session-Id: S`
- **THEN** the daemon probes the base_url stored on that row and, on success, binds the session to that agent

#### Scenario: Ambiguous session id fails closed

- **GIVEN** two local `kimi-server` agent rows on different base_urls both claim session id `S`
- **WHEN** a new MCP client initializes with only `X-Kimi-Session-Id: S`
- **THEN** the session remains unbound
- **AND** no kimi server is probed

#### Scenario: Probe failure leaves the session unbound and is retriable

- **GIVEN** one local `kimi-server` agent row claims `(B, S)` but the kimi server at `B` reports `S` missing
- **WHEN** a new MCP client presents `X-Kimi-Session-Id: S`
- **THEN** the session remains unbound and business tools return `unknown_agent` with the recovery hint
- **AND** once the kimi server reports `S` live again, a later request on the same session retries the bind and succeeds

#### Scenario: No identity headers means no bind attempt

- **GIVEN** a new MCP session whose requests carry neither `X-Kimi-Session-Id` nor `X-Kimi-Base-Url`
- **WHEN** it calls any business tool
- **THEN** no reverse lookup or probe is performed and the existing unregistered-session behavior is unchanged
