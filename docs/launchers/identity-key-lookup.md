# identity key 持有者查询

AoE 等本机启动器在切换 pane 的 runtime 前, 使用 `POST /api/identity-key/lookup`
查询 daemon 中当前持有某把 `XATS_IDENTITY_KEY` 的身份, 与 pane 当前身份比对.
接口只读, 不注册、不 reconnect、不迁移 key, 也不提供交接写接口.

## 协议 v1

认证与 `/api/codex/binding/lookup` 相同: 沿用 daemon 的 bearer 认证, 仅允许
loopback 来源.  请求严格校验字段, `identity_key` 为 1 到 256 个字符.

```json
{
  "protocol_version": 1,
  "identity_key": "808b3f15-6125-4581-99c3-761da5088484"
}
```

有持有者时返回 HTTP 200:

```json
{
  "ok": true,
  "protocol_version": 1,
  "identity_key": "808b3f15-6125-4581-99c3-761da5088484",
  "holder": {
    "team": "mie",
    "name": "mie-main",
    "agent_type": "codex",
    "active": true
  }
}
```

`active` 与 `list_agents` 的 `online` 同义, 表示进程存活, 不表示正在处理任务.
`agent_type` 可能为 `null` (旧数据未记录).  只查询本机 device 的行.

无持有者同样返回 HTTP 200: `{"ok": false, "error": "not_found"}`.

| 状态 | body | 含义 |
| --- | --- | --- |
| 400 | `{"ok": false, "error": "invalid_request", "detail": "..."}` | 请求不符合 schema |
| 401 | - | 未认证 |
| 403 | `{"error": "remote_forbidden"}` | 非 loopback 来源 |
| 503 | `{"ok": false, "error": "storage_unavailable"}` | 存储异常 |
| 500 | `{"ok": false, "error": "internal_error"}` | 其它内部异常 |

## 使用边界

查询结果与客户端之后的操作不在同一事务内, 只能用于切换前的校验和警告.
持有者不符或 `not_found` 时, 应由用户确认身份后, 让新 agent 自己带 key 显式
`register_agent`, 不能由启动器推断身份.
