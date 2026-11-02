## Context

生产只读证据显示 2026-10-27T17:06Z 发出的 pane challenge, 对应预登记于 17:15Z 到期, 直到 10-28T08:16Z 注册才回传.  旧 nonce 仍解析为 pane, 而有效预登记行数已为零.  身份和原生投递注册独立成功, 使调用者误认启动绑定完成.

## Goals / Non-Goals

目标是使 challenge 的授权期限和 launch 与预登记一致, 对注册后的启动绑定给出机器可读反馈, 并验证安全重新预登记的恢复路径.  不自动恢复历史线程, 不代替模型选择身份, 不删除现有身份, 不操作生产服务或实时 tmux.

## Decisions

- nonce 签发必须携带 pane_id, xats_agent_id 和 expires_at, registry 不保存 identity_key.  resolve, delivered 判定及消费都校验期限.  过期 nonce 不提供有效 pane 授权, 消费时可返回明确 expired 分类.  覆盖启动, 消费和 shutdown 继续清理旧 nonce.
- 注册保持原有 agent_id/team/thread 等成功字段, Codex 附加 launch_binding: bound 或 unbound, 以及 reason.  只有当前注册确认并匹配已持久化的 launch 快照才返回 bound, 原生投递成功不替代该状态.  明确 challenge 绑定失败时给出 launcher 重新预登记提示; 没有 challenge 的正常原生注册只给状态, 不增加 retry/hint, 保持 Mac Codex App 等无 launcher 流程兼容.
- 迟到, 未知, 启动被替换或缺少预登记均不回退到猜测 pane.  失败日志只包含 agent/pane/launch 与机器原因, 不含 nonce 或 key.
- 提交前再次确认预登记未到期, 防止异步 carrier 验证跨过截止时间后仍提交.  原有 UUID, 前台进程, generation CAS 和原子消费要求保持.
- 安全重试复用已有 pre_register_codex_pane, 由持有 launcher key 的启动器针对实际当前启动重新预登记, 取得新 challenge 后模型以明确旧身份注册, 完成 lookup 后再由 AoE CAS 保存 thread.  不因迟到 token 自动延长 TTL 或直接回填空快照.

## Risks / Trade-offs

- 启动器尚未识别新增字段时仍能读取旧成功字段, 必须继续用精确 binding lookup 作为恢复能力完成证据.
- 旧进程内存里的无范围 nonce 不会迁移, 部署需重启 daemon, 由操作者自行安排.  本轮仅临时目录构建和隔离测试.
- 无法从日志推断模型为何迟到, 本次修复解决失效授权和不明确反馈, 不以延长窗口掩盖迟到.
