## 1. 把 nonce 选中这一事实传到判定点

- [x] 1.1 让 `autoBindCodexPane` 的入参携带"本次 `targetPaneId` 来自已消费的 recovery nonce", 而不是让 `classifyRowClaim` 从 `targetPaneId` 是否存在去反推
- [x] 1.2 `classifyRowClaim` 增加该入参: 命中时把 caller-key 矛盾从终态拒绝改判为 rotate, holder 相关的两条拒绝保持不变
- [x] 1.3 `reArbitrateClaim` 传入同一事实, 保证 candidacy 允许的行不会在 commit 内被同一条理由拒掉
- [x] 1.4 验证: 无 nonce 路径的所有既有拒绝行为逐条不变

## 2. attach 通道放行轮换

- [x] 2.1 `attachConsumedIdentityKey` 在 nonce 授权下不再以 `caller_holds_different_key` 拒绝, 改为执行轮换
- [x] 2.2 `planIdentityKeyBinding` 的 live-holder 判定保持原样 —— 轮换只丢弃 caller 自己的旧 key, 不夺取他人的
- [x] 2.3 验证: 轮换后 caller 行只持有一把 key, `(device, identity_key)` 唯一索引不冲突

## 3. 轮换日志

- [x] 3.1 实际替换了非空旧 key 时打一行 debug, 含 caller id、pane、旧/新 key 各前 8 位
- [x] 3.2 幂等重写同一把 key 不算轮换, 不打日志
- [x] 3.3 验证: 全量日志中不出现完整 key 值 (沿用现有 redact 测试的断言方式)

## 4. register_agent 工具描述

- [x] 4.1 codex 分支补一句: 你能读到的 `XATS_IDENTITY_KEY` 属于 app-server 的启动 shell, 不是你 pane 的那把
- [x] 4.2 指明 codex 应省略 `identity_key`, 依赖 launcher 的 `pre_register_codex_pane` 通道
- [x] 4.3 验证: `tools/list` 描述断言, 且既有四条 `agent_type` 探测分支不变

## 5. 回归测试

- [x] 5.1 nonce 定向 + caller 持不同 key → 轮换成功 (本次缺陷的直接回归用例)
- [x] 5.2 同样形状但无 nonce → 仍然 `identity_key_contradiction`
- [x] 5.3 nonce 定向但 key 的持有者是另一个活着的 `(team, name)` → 仍然拒绝
- [x] 5.4 nonce 定向但持有者 `runtime_ui_pid = NULL` → 仍然 `identity_key_holder_liveness_unknown`
- [x] 5.5 双 pane 同时携各自 nonce 重启 → 各自轮换到各自的 key, 不互相夺取
- [x] 5.6 verification 窗口内出现真正持有者 → 整事务回滚, 原住民保住 pane 绑定

## 6. 真实现场验收

- [ ] 6.1 找 aoe-main 要 coders 双 codex pane 现场, 做一次真实 Shift+C 重启
- [ ] 6.2 判据不是 `identity_key` 非空, 而是端到端比对: agents 行的 key == `ps -wwEp <pane_pid>` 里 launcher 注入那个 pane 的 key
- [ ] 6.3 对照 daemon 日志确认走的是轮换而非再次 `identity_key_contradiction`
