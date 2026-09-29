# Codex 启动与 thread 精确绑定

AoE 等本机启动器使用 `POST /api/codex/binding/lookup` 查询某次启动已经验证的
Codex thread.  禁止用相同 cwd, 启动时间或 rollout 遍历顺序推断 pane 归属.

## 协议 v1

接口沿用 daemon 的 bearer 认证, 仅允许 loopback 来源.  请求严格校验字段,
`pane_id` 必须为 `%` 加十进制数字, `launch_id` 必须为 UUID.

```json
{
  "protocol_version": 1,
  "pane_id": "%10",
  "launch_id": "00000000-0000-4000-8000-000000000010"
}
```

成功返回 HTTP 200:

```json
{
  "ok": true,
  "protocol_version": 1,
  "pane_id": "%10",
  "launch_id": "00000000-0000-4000-8000-000000000010",
  "thread_id": "11111111-1111-4111-8111-111111111111"
}
```

业务拒绝同样返回 HTTP 200, 严格只有 `ok` 和 `error`, 不携带历史 thread:

```json
{"ok": false, "error": "pending"}
```

| error | 含义 |
| --- | --- |
| pending | 当前启动仍在有效预登记期内, 尚未完成精确绑定 |
| not_found | 没有该 pane 的启动记录 |
| stale | 启动已替换或过期, agent 绑定已变化, 或当前 carrier 不匹配 |
| ambiguous | launch UUID 被多个 pane 使用, 或 carrier 无法唯一确定 |

无效请求返回 400 `invalid_request`, 未认证返回 401, 非 loopback 返回 403.
存储异常返回 503 `storage_unavailable`, 探测或其它内部异常返回 500
`internal_error`.  这些响应同样不返回 thread 或异常原文.

## 证据与代际

1. 每次启动复用启动器生成的 `xats_agent_id` 作为 `launch_id`.  该值同时写入
   `pre_register_codex_pane` 和实际 Codex argv, 不使用身份的 `register_generation`
   充当启动代际.
2. 接受预登记时, 同一事务清除该 pane 的旧完成快照.  新快照未完成期间查询
   不会退回旧 thread, 预登记过期清理也不会恢复旧快照.
3. 单 pane 和多 pane 都需要本窗格 challenge.  只有回传该 challenge 后通过
   carrier/pane 验证的注册, 才在绑定原子事务内保存完成快照.
4. 携带 challenge 的注册优先于同 thread 旧 seat 继承.  绑定失败且预登记快照
   未变时重新安排 challenge, 已消费的令牌不复用.
5. 查询复核 agent 的 thread/pane/pid/tty, 再读取当前 pane 的 carrier UUID 和
   pid.  同进程组 wrapper/native 视为一个 carrier.  异步探测后再次检查数据库
   快照, 任何变化均不能返回先前结果.

客户端仍须在 lookup 前后复核实际 pane, launcher UUID 和自己的启动代际,
并通过 CAS 保存结果.  HTTP 查询与客户端稍后的写入并非同一事务.

## 支持边界

查询只读, 不注册、不 reconnect、不触发恢复、不修复历史数据.  旧数据库迁移
只创建空的完成快照表, 不将已有猜测绑定升级成精确证据.  未启用 xats 或未完成
注册的 Codex 不提供 thread, 客户端不得退回 cwd/time 猜测或静默创建新会话.

本接口证明本次启动已经完成登记的 thread, 不证明 UI 当前选中的 thread.
新启动器通过会话级 `XATS_CODEX_LAUNCH_ID` 支持显式
`reconnect({launch_id, thread_id})`.  `/clear` 后调用成功时, agent delivery
与本接口的绑定快照会在同一事务中更新.  fork 和子代理线程不能走此路径.
在同一个 Codex 进程内执行 `/new` 或 `/resume`, 且切换后未重新登记时,
launcher UUID, pid 和注册表可能全部不变, 现有 xats 无法检测该切换.
此场景需要 Codex CLI 提供与 launch 关联的 thread-selection 信号或独立选择代际,
不能用 app-server 的已加载 thread 列表或重复查询本接口替代.

## 验证

`tests/register-agent-recovery-nonce.test.ts` 通过本机临时 HTTP server 与注入的
carrier 探针验证预登记, 双 pane 逆序注册, 精确快照和 HTTP 查询完整链路.
`tests/codex-binding-lifecycle.test.ts` 覆盖代际切换, 在途变更, 回滚及 carrier 漂移.
`tests/codex-binding-lookup.test.ts` 覆盖请求 schema, 认证, loopback 和错误净化.
`tests/codex-seeding-poke.test.ts` 使用 fake timers 与模拟 tmux 验证 challenge
调度和写入确认.  验证不操作实时 tmux pane, 不执行全量测试.
