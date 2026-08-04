## 1. Shared Contract

- [x] 1.1 Export shared OpenCode runtime reserve/commit schemas and derive REST variants that require `protocol_version`.
- [x] 1.2 Add a narrow injectable runtime-control service interface for the REST adapter while keeping the production path on `OpencodeRuntimeRecoveryService`.

## 2. REST Adapter

- [x] 2.1 Implement `POST /api/runtime/opencode/reserve` with strict validation, HTTP boundary mapping and unchanged service outcome.
- [x] 2.2 Implement `POST /api/runtime/opencode/commit` with the same boundary and no REST connection binding.
- [x] 2.3 Ensure unexpected and storage failures return stable envelopes without identity key or exception text.

## 3. Focused Tests

- [x] 3.1 Cover reserve/commit field forwarding, fresh reserve and successful/failed domain outcome HTTP 200 behavior.
- [x] 3.2 Cover strict schema, required/mismatched protocol version, bearer auth and remote peer rejection before service invocation.
- [x] 3.3 Cover identity key absence from normal and exceptional responses and verify existing MCP/CLI tests remain green.

## 4. Documentation And Verification

- [x] 4.1 Document the final REST request/response contract and discovery boundary in English and Chinese README files.
- [x] 4.2 Run focused REST/runtime-control tests, typecheck, build, strict OpenSpec validation and `git diff --check`.
