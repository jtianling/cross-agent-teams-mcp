## Why

AoE 启动 OpenCode Cross Agent Team runtime 时, 当前必须从 `PATH` 额外找到
`cross-agent-teams-mcp` CLI 才能 reserve/commit.  daemon 已经拥有完整的
recovery domain operation, 因此这个全局 binary 依赖既重复又会在 runtime
spawn 前造成不必要的硬失败.

## What Changes

- 在 daemon 现有 HTTP 端口新增 sessionless、loopback-only 的 OpenCode
  runtime reserve/commit REST control endpoint.
- 对请求 body 做 strict schema 校验, 并复用 protocol version 1、现有 service
  outcome、CAS、精确 session probe 和 recovery prompt 逻辑.
- 复用 daemon 的 bearer token 鉴权和真实 socket peer loopback gate.
- 保证 identity key 只进入 JSON body, 不在响应或日志中回显.
- 保持现有 MCP tools 和 CLI 行为兼容, 不改变 agent connection 绑定语义.

## Capabilities

### New Capabilities

- `opencode-runtime-rest-control`: 定义 OpenCode runtime reserve/commit 的薄 REST
  control adapter、请求/响应、协议版本和安全边界.

### Modified Capabilities

- `rest-fallback-api`: 扩展 loopback REST surface, 并把原先覆盖全部 `/api/*` 的
  零 delivery side-effect 约束收窄到 lifeboat endpoint, 为严格受限的 launcher
  control operation 定义例外.

## Impact

- `src/daemon/rest-api.ts`: 新 endpoint、strict schema 和 HTTP adapter.
- `src/daemon/server.ts`: 向 REST mount 传入既有 OpenCode recovery service.
- REST 聚焦测试: 鉴权、remote peer、schema、protocol mismatch、key 脱敏、
  reserve/commit outcome 与既有 service 等价性.
- AoE 后续可以通过普通 HTTP client 调用 daemon, 不再 spawn 全局 xats CLI.
