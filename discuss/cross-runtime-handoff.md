# 跨 agent 类型交接接口讨论

当前固定开发合同见 [runtime-handoff.md](../docs/runtime-handoff.md).  下方为讨论历史, completion_token/register 扩展已被本地 helper + 原 REST commit 替代, 不按旧草案实现.

状态: 2026-11-04, 已与 aoe-main 交换当前实现与 fence 能力, 接口待双方核对.  本文不是已实现或已部署承诺.  本机真实 pane, daemon 和 AoE 工作树均未操作.

## 问题与边界

OpenCode reserve, commit 与 reconnect 只接受当前类型为 opencode 的身份.  managed prepare 不允许 claim 类型变化.  因此不能仅修改 reserve 的类型判断, 更不能删除原身份重新注册.  必须保留 agent_id, name, team, identity key, inbox 和已读 cursor, 并明确隔离旧 runtime 与迟到回调.

AoE unmanaged slot 当前保存 native session, cwd, pane, identity key 和自己的 runtime generation.  该 generation 不等于 xats register_generation, 不作为 xats 注册 fence.  managed 路径保存完整 claim fence 和 runtime, 可直接使用现有协议扩展.  cwd 与 pane 生命周期由 AoE 负责, xats 不负责停止进程.

## Unmanaged 两阶段交接

新增本机 REST 路径, 复用 daemon bearer 和 loopback 门禁, 不增加 agent-facing MCP 工具.  支持 codex, claude-code 和 opencode 双向交接.

prepare 输入:

```json
{
  "protocol_version": 1,
  "identity_key": "<原 key>",
  "request_id": "<新的 UUID>",
  "name": "<原 name>",
  "team": "<原 team>",
  "source_agent_type": "codex",
  "target_agent_type": "opencode",
  "expected_source": {
    "pane_id": "<已确认 pane>",
    "thread_id": "<已确认 thread UUID>",
    "launch_id": "<已确认 launch>"
  }
}
```

路径为 POST /api/runtime/handoff/prepare.  expected_source 可省略, 已提供字段必须全部核对.  key 在本设备解析唯一 row, name/team/source_type 必须一致.  prepare 持久化源快照, 不改当前 type/delivery, 不停止或撤销旧客户端.  request_id 与完整配置相同则幂等返回同一结果, 配置不同则冲突, 不能在源状态漂移后静默刷新旧 fence.

响应包含 state=prepared, fence={handoff_id,register_generation}, source 的 agent_id/name/team/agent_type/register_generation/runtime_generation/已知 runtime 坐标和 target_agent_type.  不返回 secret, token 或完整进程 argv.

POST /api/runtime/handoff/commit 接收 protocol_version, identity_key, fence 和目标 runtime.  runtime 复用当前 managed schema 的确切地址:

- Codex: agent_type, thread_id, ws_url.
- OpenCode: agent_type, base_url, session_id.
- Claude: agent_type, ui_pid, channel_session_id.

先验证新 runtime, 再在事务内复核源 snapshot, register fence, 身份和目标地址唯一性.  原位更新同一 agent 的 type/delivery, 推进代次并清除旧 pane/thread/channel 状态.  两个阶段之间的新注册或 runtime 变化使旧 fence 失效.  同一已提交 fence 和同 runtime 幂等成功, 不同 runtime 冲突.

POST /api/runtime/handoff/status 和 /abort 接收 protocol_version, identity_key 和 fence.  status 返回 prepared/committed/aborted/stale 和当前非敏感状态.  abort 只终结 pending, 不恢复旧快照, 已提交的交接不能 abort.  commit 探测失败或 CAS 冲突不得部分更新身份.  pending 在 daemon 重启后可继续检查和重试.

AoE 时序: prepare -> 核对源身份并持久化 pending -> 只停止目标 pane -> 启动新 runtime -> commit -> finalize slot/native.  先前失败现场可以按真实存量 source type 重新 prepare, 不能以 AoE 已改写的 tool 字段反推 xats type.

## Managed 扩展

原 POST /api/managed/prepare 增加可选 previous_agent_type.  跨类型时必须同时提供当前 previous fence, 新且不同的 instance_id, 与当前 claim 类型匹配的 previous_agent_type, agent_type 为目标类型.  同类型原请求兼容, 不将类型参数变成任意覆盖开关.

沿用 managed prepare 的旧 token 失效和旧 delivery 隔离语义.  推进 claim fence 的同时推进旧 agent register fence, 使旧异步绑定无法提交.  新 bind exact runtime 验证成功后才改 agent type/delivery.  失败沿新 fence 重试, 恢复旧类型需要新的 instance 和当前 fence, 不重新激活旧 token.

## 待完成的防护核对与验证

- 首次交接后的普通注册/重连必须匹配当前类型及确切地址, 否则旧进程可重新覆盖原身份.  不能只校验控制面 commit.
- 旧 unmanaged MCP 连接应按交接 epoch 失效, 防止继续读取新 runtime 的 inbox 或执行控制工具.  managed 继续使用现有 token/fence 规则.
- OpenCode 保留同类型 reserve/commit/reconnect 的代次验证, 迟到 commit 在新类型或 register_generation 下不得提交.  Codex 旧 recovery/seeding 与 pane challenge 也必须失效或失败关闭.
- 验证请求严格 schema, loopback/token, 同名冲突, 幂等重试, 取消, daemon 重启恢复, 异步探测期间 CAS 漂移, 类型来回切换, 旧 session/回调拒绝, inbox/cursor 与 sibling 保留.
- 所有测试使用隔离数据库, 注入 runtime probe 和随机端口.  本机不跑全量测试, 不探测或操作真实 tmux.  独立 review 后才提供联调候选, 不自动重启共享 daemon.

## 目标启动 proof 补充

源码核对确认: CodexBindingLookup 在 binding.thread_id 为 null 时只返回 pending/stale, 不能在新目标注册前给 AoE 新 thread.  禁止改用 cwd 或全局 loaded thread 猜测.  Claude AutoBindChannelService.lookup 可在 CLI/channel proxy 启动后由准确 ui_pid 解析 channel, 提交仍需核对 proxy owner 存活且订阅有效.

拟在 prepare 返回独立 completion_token, 其范围限定为该 handoff, 源身份快照和目标类型, 与 identity_key 分离.  AoE 将 token 保存在 pending 中, 通过新 Codex/Claude 的首条启动提示提供给目标, 不依赖 Codex 共享 app-server 环境.  register_agent 拟增 runtime_handoff 参数, 目标提交真实自身 thread_id 或 ui_pid, xats 验证 capability 与 exact runtime 后才提交交接并绑定请求会话.  普通 register 不能绕过交接.  此路径能否由 AoE 启动器提供首条提示正在核对, 尚不视为最终实现合同.

OpenCode wrapper 已持有新 base_url/session_id, 可以先 REST commit 再 attach.  Codex 的 handoff commit 与 pane/launch 绑定分别记录, native thread 验证不冒充 pane proof; 后者继续需要正常 launcher pre-register 与 challenge.  AoE 从 handoff status 读取已提交 runtime 后 finalize.

## 源快照边界

已核对 RegisterAgentService.releaseConnection 和 MCP finalizeSessionClose: 正常 WS/MCP 断开仅释放会话和 fanout, 不更新 agents 的 type/delivery/register_generation.  所以正常停止旧进程无需放宽这些 authoritative 字段的 CAS.

源 fence 应包括 agent_id/device/name/team/key 所有权, agent_type, register_generation, OpenCode runtime generation 和 exact delivery, 以及源 pane/runtime 绑定证据.  last_seen_at, inbox cursor, 消息追加, 会话在线状态不属于交接 CAS 输入, 允许心跳与正常查收.  若其他控制操作确实清空或改写 runtime 地址/绑定, 该交接应 stale, 不能将其当作普通离线而覆盖新状态.  abort 只结束 pending, 然后按 authoritative 当前身份重新 prepare.
