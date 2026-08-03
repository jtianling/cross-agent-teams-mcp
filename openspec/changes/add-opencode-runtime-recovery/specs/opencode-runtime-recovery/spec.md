## ADDED Requirements

### Requirement: Launcher can reserve an OpenCode runtime generation

daemon SHALL expose unbound control tool `reserve_opencode_runtime`, and CLI SHALL expose `reserve-opencode-runtime --identity-key-env <name> --runtime-generation <N>`.  `runtime_generation` MUST be a positive safe integer.  The lookup MUST use identity key on the daemon local device, MUST exclude channel proxy rows, and MUST require the resolved effective agent type to be `opencode`.

For an unknown key, reserve SHALL return `{need_register:true,state:'unregistered'}` without creating or changing any row, and CLI SHALL exit 0.  For a known key, an incoming generation below the stored fence SHALL return `stale_runtime_generation` with no write, an equal generation SHALL be idempotent success, and a greater generation SHALL advance the fence with CAS.  All outcomes other than unknown-key `need_register` and successful reserve SHALL make CLI exit nonzero.

#### Scenario: Unknown key stays unregistered

- **WHEN** reserve receives an identity key that has no local row and generation 1
- **THEN** it returns `need_register:true` and `state:'unregistered'`
- **AND** no tombstone, name, team or agent row is written
- **AND** CLI exits 0

#### Scenario: Generation ordering is enforced

- **GIVEN** an OpenCode identity whose fence is N
- **WHEN** reserve receives N-1, N, and N+1 in sequence
- **THEN** N-1 returns `stale_runtime_generation` with zero writes
- **AND** N returns idempotent success
- **AND** N+1 advances the fence exactly once with CAS

#### Scenario: Effective type conflict blocks launch

- **GIVEN** an identity key belonging to a non-OpenCode agent
- **WHEN** reserve is called for that key
- **THEN** it returns an explicit agent type conflict
- **AND** CLI exits nonzero without changing the row

### Requirement: Launcher can commit an exact OpenCode runtime delivery

daemon SHALL expose unbound control tool `commit_opencode_runtime`, and CLI SHALL expose `commit-opencode-runtime --identity-key-env <name> --runtime-generation <N> --base-url <url> --session-id <id>`.  `session_id` is REQUIRED and MUST identify an exact OpenCode session; commit MUST NOT choose latest session or infer by cwd.

Commit SHALL validate key, effective agent type and generation before any endpoint request.  Lower generation SHALL return `stale_runtime_generation`; higher generation SHALL return `runtime_generation_not_reserved`; equal generation with a different already committed delivery SHALL return `runtime_generation_conflict`.  These outcomes MUST perform zero probe and zero write.  Equal generation with the identical committed delivery SHALL be idempotent and MAY retrigger the recovery prompt.

For a valid candidate, commit SHALL verify exact OpenCode health and session, then CAS the same identity holder, fence and prior delivery before atomically storing the new delivery and its generation.  Delivery-pair ownership SHALL compare canonical URL semantics, including host case, default ports and trailing slashes, both before probing and in the transaction immediately before the write.  A canonically equivalent delivery pair already owned by another identity SHALL return an explicit conflict.  Commit MUST preserve agent id, name, team, role, model, unread cursor, identity key and stored authentication reference.

#### Scenario: Commit requires the reserved generation

- **GIVEN** an OpenCode identity whose fence is N
- **WHEN** commit receives N-1 or N+1
- **THEN** it returns `stale_runtime_generation` or `runtime_generation_not_reserved` respectively
- **AND** no health/session request and no storage write occur

#### Scenario: Exact same delivery is idempotent

- **GIVEN** generation N is fully committed to `(base_url B, session_id S)`
- **WHEN** commit repeats N, B and S
- **THEN** it returns successful `delivery_committed`
- **AND** it may retrigger the generation-N recovery prompt

#### Scenario: Concurrent identical commits converge

- **GIVEN** two generation N commits for the same identity and exact delivery both pass preflight and probe
- **WHEN** one CAS stores the delivery before the other CAS runs
- **THEN** both calls return successful `delivery_committed`
- **AND** the losing CAS re-reads and recognizes the identical committed state

#### Scenario: Same generation cannot switch delivery

- **GIVEN** generation N is fully committed to `(B1, S1)`
- **WHEN** commit receives generation N with `(B2, S2)`
- **THEN** it returns `runtime_generation_conflict`
- **AND** it performs zero write

#### Scenario: Older probe cannot overwrite a newer reserve

- **GIVEN** generation N commit has started an endpoint probe
- **AND** generation N+1 is reserved before the probe completes
- **WHEN** the generation N probe later succeeds
- **THEN** its storage CAS fails as stale
- **AND** the generation N delivery is not committed

#### Scenario: Commit control connection remains unbound

- **WHEN** a transient CLI MCP session successfully commits an OpenCode delivery
- **THEN** the response contains `delivery_committed:true` and `connection_bound:false`
- **AND** `get_inbox` on that transient session still returns `unknown_agent`

### Requirement: Commit triggers bounded exact-session recovery

After a delivery commit, daemon SHALL send a fixed recovery prompt to the exact committed OpenCode session via existing `prompt_async` with `noReply:false`.  The prompt MUST NOT contain the identity key value.  It MAY contain `base_url`, `session_id` and `runtime_generation`, and SHALL instruct the OpenCode agent to read the key from its own environment and call `reconnect({identity_key,agent_type:'opencode',base_url,session_id,runtime_generation})`.

Successful scheduling SHALL return `{ok:true,state:'delivery_committed',delivery_committed:true,connection_bound:false,recovery_prompt:'scheduled'}`.  Exact probing and prompt sending SHALL each have a finite wall-time bound.  If delivery commits but prompt scheduling, timeout or sending fails, commit SHALL return `connection_bind_trigger_failed` with `delivery_committed:true` and `connection_bound:false`, and CLI SHALL exit nonzero without rolling back delivery.  A probe timeout SHALL write no delivery.  Repeating the same generation and delivery SHALL safely retrigger the prompt.

Prompt work SHALL be bounded and keyed by agent id plus generation.  Every send SHALL recheck current holder, fence and delivery.  Prompt timeout, successful reconnect, reserve N+1 and daemon shutdown SHALL abort any in-flight recovery request and clear its schedule.  A late response or rejection MUST NOT retrigger the prompt or mutate runtime state.

#### Scenario: Prompt contains no key and permits a reply

- **WHEN** generation N delivery is committed
- **THEN** the exact session receives `prompt_async` with `noReply:false`
- **AND** the prompt contains no identity key value

#### Scenario: Prompt failure is explicit partial success

- **GIVEN** delivery commit succeeds and prompt sending fails
- **WHEN** commit returns
- **THEN** it reports `connection_bind_trigger_failed`, `delivery_committed:true` and `connection_bound:false`
- **AND** repeating the identical commit can schedule the prompt again without rewriting identity fields

#### Scenario: New reserve cancels old prompt work

- **GIVEN** prompt work exists for generation N
- **WHEN** generation N+1 is reserved
- **THEN** generation N work is cancelled and its in-flight request is aborted
- **AND** a stale generation N reconnect is rejected

### Requirement: CLI keeps identity key secret and reports daemon endpoint

Both OpenCode runtime CLI commands SHALL read the key only from the environment variable selected by `--identity-key-env`, defaulting to `XATS_IDENTITY_KEY`.  The key value MUST NOT appear in process argv, stdout, stderr, structured result or daemon logs, including when it contains quote, backslash or control characters and is echoed inside a nested daemon result string.  Commands SHALL reuse daemon pid-file/port/token resolution and SHALL include the resolved `host:port` endpoint in every remote success or failure outcome.  Unknown flags, missing values and invalid generations SHALL fail before a remote call.

#### Scenario: Key is absent from observable CLI surfaces

- **WHEN** either command runs with key K in its selected environment variable
- **THEN** K is absent from argv, stdout, stderr and daemon logs

#### Scenario: Remote error still names endpoint

- **WHEN** daemon returns a reserve or commit error
- **THEN** CLI output includes the resolved daemon `host:port`
- **AND** the key value is absent

#### Scenario: Unknown flag hard-fails

- **WHEN** either command receives an unknown flag
- **THEN** it exits nonzero before connecting to daemon
