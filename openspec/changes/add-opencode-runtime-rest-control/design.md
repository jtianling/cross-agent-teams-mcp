## Context

OpenCode runtime recovery 已经由 `OpencodeRuntimeRecoveryService` 实现, MCP
tools 与 CLI 只是其控制面 adapter.  AoE 只有普通 HTTP client, 当前却在 spawn
runtime 之前从 `PATH` 调 CLI, 导致没有全局安装 binary 时直接失败.  daemon 已有
Fastify REST surface、bearer auth、socket peer origin classification 和 loopback
gate, 因此可以用很薄的 REST adapter 消除额外进程与安装依赖.

现有 `rest-fallback-api` 把全部 `/api/*` 描述成无 delivery side-effect 的
lifeboat.  新 endpoint 会有意推进 OpenCode runtime fence 或提交 delivery, 所以
必须明确收窄原约束, 同时继续禁止 REST connection 绑定、takeover 和 session
mutation.

## Goals / Non-Goals

**Goals:**

- 让 AoE 通过普通 HTTP POST 完成 reserve/commit, 不依赖全局 CLI 或 MCP client.
- 让 REST、MCP 与 CLI 复用同一 domain service 和 JSON outcome.
- 维持严格 schema、protocol version、CAS、精确 session probe 和 bounded recovery
  prompt 语义.
- 复用现有 token 与 loopback gate, 并保证 identity key 不进入 URL、响应或日志.
- 保持现有 MCP tools、CLI 与 agent connection 行为兼容.

**Non-Goals:**

- 不修改 AoE 仓库或实现 AoE 的 pid-file client.
- 不新增 Unix socket、daemon 自动发现协议或另一套认证机制.
- 不通过 REST 注册 agent、绑定 REST connection 或选择 latest OpenCode session.
- 不改变 OpenCode runtime recovery service 的业务错误和存储语义.

## Decisions

### 1. 使用两个 sessionless POST endpoint

新增 `POST /api/runtime/opencode/reserve` 与
`POST /api/runtime/opencode/commit`.  POST + strict JSON body 让 identity key 不会
出现在 URL/query/argv, 也避免浏览器 simple GET 触发 mutation.  备选的 Unix
socket 会重复平台、发现、权限和生命周期处理; 手写 MCP lifecycle 则会把
initialize、session header 与响应 framing 泄漏到 AoE, 两者都拒绝.

### 2. REST adapter 只做 schema、HTTP 映射和 service 调用

production server 向 REST mount 注入同一个 `OpencodeRuntimeRecoveryService`
接口.  handler 不直接访问 `AgentsRepo`, 不重写 generation、CAS、probe 或 prompt
逻辑.  MCP tools 与 CLI 保持原调用路径, 因而新增接口是 additive.

reserve schema 复用既有字段约束, 但 REST 必须显式传
`protocol_version`.  commit 在此基础上继续要求 canonicalizable HTTP(S)
`base_url` 和以 `ses` 开头的精确 `session_id`.  所有 object 使用 strict schema,
未知字段以 HTTP 400 拒绝.  400 envelope 固定为 `ok:false`、
`error:"invalid_request"` 与不包含请求字段名或值的稳定 `detail`.

### 3. transport failure 与 domain outcome 分层

JSON/schema、auth、origin 和未处理的内部错误属于 HTTP transport boundary,
分别返回 400、401、403 与 500/503.  一旦请求通过 schema 并进入 service,
无论 outcome 是 `ok:true` 还是业务 `ok:false`, HTTP 均为 200, body 原样返回
service JSON.  这样 stale/conflict/protocol mismatch/probe failure 在三个 adapter
之间保持一个契约, AoE 只按 `ok`/`error` 分支.

unexpected exception 不把 `Error.message` 返回 client, 防止异常文本意外包含
identity key.  storage exception 归一为 503
`{ok:false,error:"storage_unavailable"}`, 其它异常归一为 500
`{ok:false,error:"internal_error"}`.

### 4. 复用现有 auth 与真实 peer loopback gate

endpoint 继续位于 `/api/*`, 所以先经过 daemon 全局 token auth, 再经过从 socket
peer address 派生的 loopback gate.  不信任 `X-Forwarded-For`.  daemon 未配置
token 时保持现有 loopback-only 本地信任模型; 配置 token 时使用相同 bearer
credential.  identity key 仍是 runtime holder 的高熵能力, unknown key 不产生 row.

### 5. REST control 不绑定调用连接

reserve 只推进 fence, commit 只提交 delivery 并调度精确 session recovery prompt.
REST handler 不持有 MCP connection, 不创建或关闭 session, 不触发 takeover.
commit 成功继续返回 `connection_bound:false`; 真正的 OpenCode session 必须按现有
提示自行 `reconnect`.

## Risks / Trade-offs

- [原 REST spec 的零 delivery side-effect 约束与新接口冲突] → 将该约束明确限定
  为 lifeboat endpoint, 并为 control endpoint 列出唯一允许的 fence/delivery
  mutation.
- [tokenless loopback daemon 被浏览器探测] → 仅 POST strict JSON, key 不在网页
  可见范围, unknown key 无 mutation; 高安全部署继续要求 daemon token.
- [异常回显 key] → 400 detail 只使用 schema issue message, 500 不返回 exception
  message, 业务 service 已有 key 脱敏约束.
- [REST 与 MCP 行为漂移] → 注入同一 service, 聚焦测试断言参数透传和 outcome
  原样返回, 不在 handler 复制业务分支.

## Migration Plan

1. 发布同时包含两个 endpoint 与现有 MCP/CLI 的 xats 版本.
2. AoE 改用 pid file/已知 endpoint + bearer token 通过普通 HTTP 调用.
3. 验证 fresh Shift+C 的 `need_register` 分支和 Shift+R 的 reserve/commit 分支.
4. CLI 保留兼容和人工诊断用途; 回滚旧 daemon 时 AoE 根据 404 明确报告协议不支持,
   不回退全局 PATH CLI.

## Open Questions

无.
