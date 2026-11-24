# Runtime 类型交接 v1

状态: 2026-11-04 开发合同, 尚未部署到共享 daemon.  本接口面向本机 AoE/helper, 保留原 agent_id, name/team/key, inbox 和 cursor.  xats 不停止任何 pane, 不管理 cwd.  本机 bearer 与 identity_key 由 helper 从受限 pending 文件读取, 不进入模型 prompt, CLI argv 或普通日志.

## 请求

所有路径均为 POST, 仅允许 loopback, 沿用 daemon bearer.  请求严格拒绝未知字段.  identity_key 为非空字符串, name/team 为原身份标签, request_id/handoff_id 为 UUID.  type 支持 codex, claude-code, opencode, source 与 target 可以相同, 同类型 Codex/Claude fresh restart 使用同一受控 renewal 协议.  OpenCode 原同类型恢复协议继续兼容.

POST /api/runtime/handoff/prepare:

```json
{
  "protocol_version": 1,
  "identity_key": "<helper读取原key>",
  "request_id": "<新UUID>",
  "name": "worker",
  "team": "project",
  "source_agent_type": "codex",
  "target_agent_type": "opencode",
  "expected_source": {
    "pane_id": "%44",
    "thread_id": "<已确认thread UUID>",
    "launch_id": "<已确认launch UUID>"
  }
}
```

expected_source 可省略, 其中每个字段也可省略, 已提供的字段必须全部匹配.  source runtime 由 key 在本设备解析, 不使用 AoE 自己的 slot generation.  request_id 全局在本设备不可重用为不同配置.  同请求重试不刷新源 fence, 有另一个 pending 时拒绝.

POST /api/runtime/handoff/commit:

```json
{
  "protocol_version": 1,
  "identity_key": "<helper读取原key>",
  "fence": {
    "handoff_id": "<prepare返回UUID>",
    "register_generation": 4
  },
  "runtime": {
    "agent_type": "opencode",
    "base_url": "http://127.0.0.1:12345",
    "session_id": "ses_example"
  }
}
```

runtime 的三个严格分支:

- OpenCode: agent_type=opencode, base_url, session_id.  session_id 必须为 ses 前缀.  URL 为无凭据, query 或 fragment 的 HTTP(S) 地址.
- Codex: agent_type=codex, thread_id UUID, ws_url.  URL 为无凭据, query 或 fragment 的 WS(S) 地址.  helper 使用 AoE 保存的 endpoint 和目标自身报告的真实 CODEX_THREAD_ID.
- Claude: agent_type=claude-code, ui_pid 正安全整数, channel_session_id 可省略.  daemon 按 PID 查本机 proxy 并核验 live owner, 显式 channel 必须相符.  proxy 尚未就绪返回 runtime_probe_failed, 不部分修改 source.

POST /api/runtime/handoff/status 和 /abort 均接收且只接收:

```json
{
  "protocol_version": 1,
  "identity_key": "<helper读取原key>",
  "fence": {
    "handoff_id": "<prepare返回UUID>",
    "register_generation": 4
  }
}
```

## 固定响应

四个接口 HTTP 200 成功均使用同一完整 envelope, 无其他顶级字段:

```json
{
  "ok": true,
  "protocol_version": 1,
  "state": "committed",
  "fence": {
    "handoff_id": "<prepare返回UUID>",
    "register_generation": 4
  },
  "source": {
    "agent_id": "<原agent id>",
    "name": "worker",
    "team": "project",
    "agent_type": "codex",
    "register_generation": 4,
    "runtime_generation": null,
    "runtime": {
      "agent_type": "codex",
      "thread_id": "<旧thread UUID>",
      "ws_url": "ws://127.0.0.1:8799/"
    }
  },
  "current": {
    "agent_id": "<同一个agent id>",
    "name": "worker",
    "team": "project",
    "agent_type": "opencode",
    "register_generation": 5,
    "runtime_generation": 1,
    "runtime": {
      "agent_type": "opencode",
      "base_url": "http://127.0.0.1:12345",
      "session_id": "ses_example"
    }
  },
  "target_agent_type": "opencode",
  "recovery_prompt": null
}
```

state 为 prepared, committed, aborted 或 stale.  fence 永远为原准备 fence, 不随 current.register_generation 改变.  source 固定为准备时快照, current 为当前 authoritative 身份, 身份已删除或 key 已迁移时 current=null.  source/current 的 agent_type 为字符串或 null, 不保证未知 future type 属于三个已支持交接类型.  runtime 为上述三种完整 canonical runtime 或 null, Claude 未知 PID/未绑定 native delivery 时可能为 null.  runtime_generation 仅在对应 row 为 opencode 时是整数, 其他类型为 null.  不输出 auth_token_ref 或 key.

commit 给 OpenCode 分配严格递增的 xats runtime_generation, 返回 current.runtime_generation.  AoE 必须保存该值, 后续同类型 reserve 使用更大的代次, 不能使用独立 slot counter 推测.  OpenCode 连接通过 reconnect 带原 key, exact base_url/session_id, agent_type=opencode 和返回的 runtime_generation 绑定; 不用缺省 session 的 legacy register 覆盖受控坐标.  Codex/Claude helper commit 后按原 name/team 和当前 exact runtime 正常 register_agent.

recovery_prompt 固定 null: xats 不自动向模型发交接凭据或启动新会话.  commit 成功仅证明 native delivery 提交, 不证明 MCP 连接已绑定或任务已执行.  Codex pane/launch 绑定独立依赖 launcher pre-register/challenge, 不将 native thread proof 当 pane proof.

四个接口的业务失败 envelope 固定如下, 不附加其他字段:

```json
{
  "ok": false,
  "protocol_version": 1,
  "error": "stale_fence",
  "detail": "Source changed during handoff",
  "retryable": false
}
```

| HTTP | error | 处理 |
| --- | --- | --- |
| 400 | invalid_request | 修正请求/schema, 不停止旧pane |
| 404 | not_found | key/handoff不存在或不匹配 |
| 409 | request_conflict | request_id被不同配置占用 |
| 409 | source_mismatch | source身份/类型/给定坐标不匹配 |
| 409 | handoff_in_progress | 先检查或结束已有pending |
| 409 | managed_control_required | 改用managed协议 |
| 409 | stale_fence | 不自动刷新, status/abort后从当前源重新prepare |
| 409 | target_mismatch | runtime类型不符 |
| 409 | runtime_conflict | 该fence已提交其他runtime或目标地址已被占用 |
| 409 | already_committed | 已提交不能abort |
| 409 | generation_exhausted | 代次无法安全递增 |
| 502 | runtime_probe_failed | retryable=true, 启动就绪后重试同commit |
| 500 | internal_error | 读取daemon具体脱敏日志, 不假定是否已提交, 先status |

外层 daemon 鉴权的401及统一非loopback403沿用既有格式, 不属于上述业务envelope.  无匹配新版本路由的404也不能当业务not_found解析.  网络中断时用status辨别结果, 不通过再次停止进程重试.  status 返回ok=true/state=stale不是交接成功.

## 状态与恢复

prepare持久化且不修改源type/delivery/客户端.  源snapshot包括身份和key所有权, 类型, register_generation, OpenCode generation, delivery和pane/runtime绑定字段.  不包括last_seen_at, cursor, 消息或在线状态.  正常断连只释放连接/fanout, 不使snapshot失效; 真正的控制面地址/绑定更新使fence stale.  任意异步probe返回后在事务中重验.  新注册, 目标冲突或managed接管均不得被旧commit覆盖.

相同已提交fence和相同runtime重试幂等.  已提交身份后续换到其他地址或更高交接epoch时, 旧handoff的status为stale.  abort只终结未提交pending, 不把已提交状态回滚为旧runtime, 重复abort幂等.  当前源已变化时可以abort旧pending后用新的request_id重新prepare.  daemon重启恢复pending与终态.

首次交接后原身份的普通注册只接受当前类型和exact地址, 旧类型/旧地址被拒绝.  后续 Codex/Claude fresh restart 先以同类型 source/target 准备新 handoff, 新 runtime 验证提交后才正常注册, 不会锁死后续重启.  旧MCP连接按handoff epoch失效.  已发出的网络请求无法撤回; 后续迟到写入必须受代次或类型门禁拒绝.  sibling身份不受影响.

## Managed 扩展

原 POST /api/managed/prepare 增加可选 previous_agent_type.  跨类型必须带当前 previous fence, 新的且不同的 instance_id, previous_agent_type=当前claim类型, agent_type=目标类型.  其他请求和响应完全沿用原managed v1, 不加入handoff envelope.  同类型原请求兼容.

新instance首次成功后, 精确相同 previous, previous_agent_type, instance_id 与目标类型重试返回相同fence/token, 不多推进代次; 即使bind已经完成也保持幂等.  改变任何这些字段必须冲突.  prepare保留原agent_id和inbox, 使旧token失效并清空旧delivery/绑定, 推进agent注册fence.  新runtime验证后bind才改agent.type/delivery.  失败使用新fence重试, 恢复旧类型也需当前fence和新instance, 不重放旧token.

## AoE helper 时序

先从真实key lookup/source解析当前身份, 即使AoE上次失败已改tool或清native, 也不能猜xats类型.  prepare成功并持久化后只停止目标pane, 保留原cwd.  OpenCode wrapper创建exact ses后可直接helper commit再attach.  Codex/Claude启动后首条提示只给原name/team, handoff_id及本地helper命令, helper从0600 pending读取key/fence并补充endpoint.  Claude把自身CLI PID交helper, Codex交真实thread UUID.  helper只输出非敏感状态, 不输出key/token.  AoE轮到status committed后才finalize slot/native; source mismatch或stale不修改存档来伪造成功.

## 当前验证结果

23 个定向测试文件共 260 用例通过, 护栏记录零宿主 tmux 调用.  TypeScript 检查, 隔离 ESM/声明构建, OpenSpec strict 及独立代码 review 均通过.  已覆盖六方向交接, 同类型 renewal, prepare/commit/abort 并发与幂等, inbox cursor 保留, 旧类型/endpoint/连接拒绝, proxy自动重绑与channel订阅旁路, Codex recovery/seeding迟到, Claude离线提交重试及0代次/opaque身份兼容.

新默认 OpenCode proof 使用真实 loopback HTTP fixture 验证 exact session错误时保留source, 正确时提交.  其他新runtime分支使用注入probe, 不声称真实Codex/Claude/OpenCode产品端到端验收通过.  AoE客户端隔离HTTP/CLI联调5项通过, 原生产品与真实pane生命周期仍未验收, 不操作用户现场pane或共享daemon.  本轮未提交或发布.

候选与证据位于 `.e2e-test/runs/runtime-handoff-20261104-182944/`, 包括 `manifest.json`, `source-sha256.json`, `targeted-final.log`, `guard-final.log` 及静态/构建检查日志.  `candidate/dist/cli.js` 仅供显式临时db, pid-file, 独立device和loopback随机端口的隔离联调, 不替换共享dist.

AoE 于 2026-11-04 使用本轮候选启动独立 daemon, 实际执行本地 `aoe __complete-runtime-handoff`, Codex proof 采用本地 WebSocket JSON-RPC fixture.  5/5 结果已回读原始 result.json 核对: 拒绝旧 attempt 且源未变, OpenCode 到 Codex 保留原身份/cursor/cwd, 同类型 renewal 的 commit 响应丢失后通过 status 确认且仅一次 commit, 错 thread proof 失败后明确 abort 并保留源 delivery/清空可重试目标.  临时 daemon/fixture 已由 AoE 清理, 未调用 tmux 或真实 agent, 不算原生产品 E2E.

证据为 AoE 仓库 `.e2e-test/runs/aoe-handoff-contract-20261104/result.json`.  AoE 第二轮独立审查已通过, 新增同 runtime stale fence 退出回归通过.  xats 共享 daemon 和现场 pane 未更新.  本机激活准备见 [切换说明](runtime-handoff-activation.md).
