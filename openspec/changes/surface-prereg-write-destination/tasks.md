# Tasks: surface-prereg-write-destination

## 1. Daemon-side reporting

- [ ] 1.1 Success result reports the field names actually received (omitted optionals absent)
- [ ] 1.2 Success result reports whether `pane_id` is visible on the daemon's own tmux server
- [ ] 1.3 Visibility probe failure reports "unknown", never blocks and never throws — the write path must not acquire a new way to fail
- [ ] 1.4 Reported, never enforced: no code path refuses on visibility

## 2. CLI-side reporting

- [ ] 2.1 `runPreRegisterCodexPane` prints the resolved `host:port` alongside the daemon's response
- [ ] 2.2 No token, no token length, no token hash in any output (handover 6.1: one leak already exists, do not add a second)
- [ ] 2.3 The error paths report the endpoint too — a connection refused against the wrong endpoint is the same diagnosis problem

## 3. Tests

- [ ] 3.1 Received-field echo: all three fields present; optional omitted → absent
- [ ] 3.2 Invisible pane → row still written, flag reports not visible
- [ ] 3.3 Probe throwing → result reports unknown, call still succeeds
- [ ] 3.4 CLI output contains host:port and no token material
- [ ] 3.5 Mutation: making visibility enforce (refuse) turns 3.2 red

## 4. The withdrawn predicate change

- [ ] 4.1 A test asserts the EXISTING behaviour: an unexpired row for a pane whose codex has not started yet still blocks the fallback bind.  This is the case the withdrawn narrowing would have broken, and nothing currently asserts it directly.
- [ ] 4.2 Mutation: narrowing the predicate to require the uuid on the carrier turns 4.1 red

## 5. Regression

- [ ] 5.1 Full unit suite + typecheck
- [ ] 5.2 No behavioural change to binding, scanning, or refusal — diff review, not just green tests

## 6. Left open (recorded)

- [>] 6.1 Cross-server `pane_id` collision.  Needs socket + server generation as a scope key; revisit criterion is an OBSERVED foreign overwrite of a legitimate row during the pre-`exec` window.
- [>] 6.2 Fixture isolation (`CROSS_AGENT_TEAMS_MCP_HOME` unset in the e2e lab) is the actual cause of lab-writes-production and belongs to the fixture owner.  This change only makes it visible.
