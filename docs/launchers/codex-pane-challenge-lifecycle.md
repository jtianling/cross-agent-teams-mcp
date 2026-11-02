# Codex pane challenge 有效期与安全重试

身份注册, 原生投递和 pane 启动绑定是不同结果.  `agent_id` 与 `thread_id` 存在不代表当前启动已形成可持久恢复的精确绑定.  本次修复只增加注册反馈, 不改变 `/api/codex/binding/lookup` v1 的任何成功字段, 失败字段或枚举, 保持严格 schema 消费者兼容.

## 注册返回

`register_agent` 的 Codex 成功结果保留原有字段, 增加 `launch_binding`:

```json
{
  "agent_id": "<登记UUID>",
  "team": "<实际team>",
  "thread_id": "<实际thread UUID>",
  "ws_url": "ws://127.0.0.1:<实际端口>/",
  "launch_binding": {
    "status": "bound",
    "pane_id": "%10",
    "launch_id": "<启动UUID>"
  }
}
```

明确携带 challenge 的绑定未完成时返回以下对象, 并附上提示启动器安全重试的 `hint`:

```json
{
  "launch_binding": {
    "status": "unbound",
    "reason": "challenge_expired",
    "retry": "launcher_pre_register"
  }
}
```

| reason | 含义 |
| --- | --- |
| challenge_expired | 已知 challenge 对应的预登记期限已到 |
| challenge_invalid | 未知, 已消费, 已替换或 daemon 重启前的 challenge |
| pre_registration_missing | challenge 有效但对应预登记已不存在 |
| launch_changed | 当前 pane 的 launch 或预登记期限与签发时不同 |
| verification_failed | 当前 challenge 有效, 但 carrier, 所有权或绑定验证未完成 |
| binding_not_verified | 本次注册没有验证并匹配到已持久化的启动证据 |
| registration_changed | 并发注册或注册代次异常, 不能给当前调用确认旧结果 |

`bound` 只确认本次已验证的 pane/launch 及存储绑定, 不承诺进程未来仍存活, 不证明 UI 后续没有 `/new` 或 `/resume`, 也不等价消息已读.  不使用 tmux 的原生 Codex App 可能正常注册并使用原生投递, 同时没有 pane 启动绑定, 此时 unbound 不表示原生投递失败.  没有携带 challenge 的正常原生注册只报告状态和 reason, 不返回 retry 或要求不存在的启动器执行预登记的 hint.

老 daemon 不含该字段时, 不能据此推断完成或失败, 启动器继续使用精确 lookup.  启动器读取注册结果不替代自己的 launch 代次复核和 CAS 保存.

## challenge 生命周期

seeding 和 recovery 签发的 challenge 同时关联 pane, launch UUID 和预登记截止时间, 不将 identity_key 放入 challenge registry 或响应.  challenge 是一次性授权, 到截止时间即失效, 即使此前已成功送达, daemon 仍不会使用它选择当前 pane 或回填 thread.

原生 carrier 的异步验证若跨过截止时间, 提交也会被拒绝.  同一 pane 被新启动或新预登记替换时, 旧 challenge 不能消费新记录.  已有前台 carrier, launch argv, identity 所有权, generation CAS 和原子提交要求保持.

## 安全重试

仅对尚未完成的启动执行以下步骤:

1. 启动器核对实际 pane, launch UUID 和自己的启动代次, 使用它持有的正确 launcher key 调用既有 `pre_register_codex_pane` 或对应 CLI.  不由共享 app-server 环境读取的 key 代替 pane key.
2. 新预登记触发新 challenge, 模型使用已明确的原 name/team 与本会话实际 thread 回传新 challenge 注册.
3. 确认注册 `launch_binding.status=bound`, 再通过 `/api/codex/binding/lookup` 按 exact pane/launch 验证 thread, 前后核对启动代次并 CAS 保存.

不以旧 challenge, 相同 cwd, 历史 pane, 最新 rollout 或已加载 thread 列表恢复关联.  不向空快照直接写入推测 thread.  不循环对已完成绑定重新预登记, 因为新预登记会按既有协议清空此前完成快照, 等待新证明.

## 激活边界与根因证据

只读生产日志显示 2026-10-27T17:06Z challenge 已送达, 预登记于 17:15Z 到期, 模型到次日 08:16Z 才携带 challenge 注册.  日志仍显示 nonce resolved, 后续有效预登记 `rows=0`.  旧注册响应仅确认原生投递成功, 隐藏了精确启动绑定未完成.

本次不推测模型迟到的原因, 不自动恢复业务线程, 不改生产数据库或凭据.  代码需要正常构建并由操作者安排一次 daemon 重启才生效, 当前会话不重启共享 daemon/app-server/TUI.  重启后旧内存 challenge 不可复用, 需要按正常重新预登记流程取得新 challenge.

## 验证结果

13 个定向测试文件共 157 用例, 类型检查和临时目录 ESM/声明构建通过, 独立代码 review PASS.  没有运行全量测试或宿主 tmux 探针.

独立 tester 的 MCP/HTTP 契约验收为 14 PASS, 0 FAIL, 2 SKIPPED, 另有单独 identity_key 脱敏补验 1 PASS.  使用实际 MCP/HTTP 客户端, 临时数据库和随机 loopback 端口, WS/carrier/投递及时间为隔离模拟.  真实 TUI 长延迟与真实 recovery 签发链未验, 不将模拟结果视为生产端到端通过.  验收源码指纹已与最终实现逐项核对一致.

[本机验收报告](http://127.0.0.1:53340/report.html) 到期为 2026-10-31T16:13:51Z.  [离线报告与证据](../../.e2e-test/runs/codex-pane-challenge-20261029-161116-vtssnxqe/report.html) 包含逐项结果和源码身份.  [脱敏补验证据](../../.e2e-test/runs/20261010-expire-stale-agents/challenge-check/key-result.log) 独立保留, 不改变原报告统计.
