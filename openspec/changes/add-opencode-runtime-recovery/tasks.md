## 1. 数据模型和迁移

- [x] 1.1 为 agents 增加独立 `opencode_runtime_generation` fence 列和兼容旧 row 的迁移
- [x] 1.2 扩展 `opencode-server` delivery 校验、序列化和读取, 支持兼容基线 0 的 `runtime_generation`
- [x] 1.3 在 repository 增加按本机 identity key 读取 OpenCode row 和 reserve/commit CAS 方法
- [x] 1.4 添加迁移、delivery round-trip、身份字段和 cursor 保持测试

## 2. Reserve 控制面

- [x] 2.1 实现 launcher-only `reserve_opencode_runtime` MCP 工具和正安全整数/schema 校验
- [x] 2.2 实现 unknown key、type conflict、stale、equal idempotent 和 greater CAS 语义
- [x] 2.3 在 N+1 reserve 时使旧代次恢复提示任务失效
- [x] 2.4 添加 reserve 零写、代次排序、legacy baseline 和并发 CAS 测试

## 3. Commit 控制面

- [x] 3.1 实现 launcher-only `commit_opencode_runtime` 工具, 在网络探测前完成 key/type/generation/conflict 预检
- [x] 3.2 复用 OpenCode 认证和 canonical URL 逻辑, 验证 exact health 与 exact session
- [x] 3.3 实现 holder/fence/delivery CAS 和 delivery pair collision 检查, 且不绑定控制面 MCP connection
- [x] 3.4 添加 lower/higher 零探测、同代冲突、反向探测完成、双 pane 隔离和字段保持测试

## 4. 恢复提示调度

- [x] 4.1 通过 exact-session `prompt_async` 和 `noReply:false` 发送固定无 key 恢复提示
- [x] 4.2 实现以 agent id 与 generation 为键的有界调度、发送前状态复检和取消
- [x] 4.3 实现 commit 完全成功、提示部分失败和同代同 delivery 重试收敛响应
- [x] 4.4 添加提示内容、partial error、重试、N+1 取消和 stale queued prompt 测试

## 5. OpenCode 自连接重连

- [x] 5.1 扩展 reconnect schema, 仅接受完整 key-based OpenCode 形状并拒绝缺字段或混合 arm
- [x] 5.2 按 key 唯一定身份并校验 exact committed delivery/generation, 使用存储的 auth reference
- [x] 5.3 复用现有注册成功路径绑定调用方 MCP connection、原 agent id 和 fanout, 成功返回 `connection_bound:true`
- [x] 5.4 添加 unknown key 零 HTTP、type conflict、stale generation、幂等重连和同连接 `get_inbox` 测试

## 6. 首次 OpenCode 注册与派发隔离

- [x] 6.1 扩展普通 OpenCode `register_agent`, 接受 exact `session_id` 和 `runtime_generation` 并原子写入 fence/delivery generation
- [x] 6.2 在 fence 大于 delivery generation 时保留 mailbox 写入, 返回 `runtime_recovering` 且不访问旧 endpoint
- [x] 6.3 添加首次注册存储、recovering mailbox/poke 和恢复后正常派发测试

## 7. Launcher CLI 和协议握手

- [x] 7.1 按现有 pre-register CLI 模式实现 reserve/commit 子命令、pid/port/token 解析和 unknown flag hard-fail
- [x] 7.2 仅从 `--identity-key-env` 指定环境变量读取 key, 默认 `XATS_IDENTITY_KEY`, 所有远端结果报告 endpoint
- [x] 7.3 为 paired CLI/daemon 加入协议/schema 版本握手并在不匹配时 fail closed
- [x] 7.4 添加退出码、endpoint、argv/输出/日志密钥隔离、unknown flag 和版本不匹配测试

## 8. 回归验证

- [x] 8.1 运行 OpenCode runtime recovery 的定向单元和集成测试
- [x] 8.2 运行现有 no-key OpenCode reconnect 与 Claude、Codex、Kimi reconnect 回归测试
- [x] 8.3 运行类型检查和 OpenSpec strict validation

## 9. 复审补强

- [x] 9.1 让 legacy no-key reconnect 对 runtime-aware row 直接绑定且零写入, 并阻止 no-generation register 覆盖或迁移该 identity
- [x] 9.2 保证单个 MCP connection 只存在于一个 identity ledger, 改绑后不再被旧 identity takeover 关闭
- [x] 9.3 添加 delivery generation 保持、probe snapshot 竞态、writer 降级、key migration 和跨 identity ledger 回归测试

## 10. 第三轮复审补强

- [x] 10.1 统一 effective agent type 和 generation-aware OpenCode 判定, 兼容 `agent_type=NULL` 的既有 OpenCode delivery
- [x] 10.2 在 `bind_channel`、channel auto-bind、reactive rebind 和低层 type/delivery writer 中拒绝改写 runtime-aware OpenCode row
- [x] 10.3 在 identity key 低层 writer 的事务内重读并拒绝迁移 runtime-aware OpenCode holder 或 target
- [x] 10.4 添加手工 bind、自动 bind、reactive rebind、seat-follow 和 effective-type legacy reconnect 回归测试
