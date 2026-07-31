## 1. Schema

- [x] 1.1 在 `src/storage/schema.ts` 的建表语句加 `identity_key TEXT` 列, 并加 `CREATE UNIQUE INDEX IF NOT EXISTS agents_identity_key_idx ON agents(device, identity_key)`
- [x] 1.2 在既有幂等 healing 路径 (`migrateAgentsDeliveryColumns` 同一套机制) 里补该列与该索引, 覆盖"遗留库被修补"和"已修补库二次启动无变化"两个用例
- [x] 1.3 加测试: 新库含列与索引; 遗留库启动后被修补且旧行 `identity_key` 为 NULL; 同一设备多行 NULL 键不触发唯一约束

## 2. Repo 层

- [x] 2.1 `AgentsRepo` 的 `RegisterInput` / `AgentRow` / 各 SELECT 增加 `identity_key`, 并在 upsert 中按"传了才写、没传保留"的语义处理 (与 delivery 的 `preserveExisting` 同形)
- [x] 2.2 新增 `findByIdentityKey(identity_key, localDevice)`, 条件为 `device = ? AND role != '__channel_proxy__' AND identity_key = ?`
- [x] 2.3 新增 `clearIdentityKey(agent_id)`, 供迁移分支清空旧行
- [x] 2.4 加 repo 层确定性测试: 写入 / 保留 / 反查 / 清空四条路径

## 3. 注册期四分支

- [x] 3.1 在 `src/mcp/tools.ts` 的 `register_agent` zod schema 增加可选 `identity_key`, 空串在 schema 层拒绝
- [x] 3.2 实现进程存活判定小工具 (`process.kill(pid, 0)`), 单独可测, 并处理 EPERM 视为存活
- [x] 3.3 在 `src/mcp/register-agent.ts` 实现四分支: 未知 → 绑定; 命中同一行 → 幂等; 命中异行且旧行 pid 为空/等于本次/已死 → 迁移并清空旧行; 命中异行且旧行 pid 活着且不同 → 返回 `identity_key_conflict` 且不写任何行
- [x] 3.4 冲突错误体带上旧行的 `team` 与 `name`
- [x] 3.5 绑定与迁移必须与 `repo.register` 在同一个事务内完成, 避免半写状态
- [x] 3.6 加测试覆盖四个分支 + "不传键时保留既有键" + "不传键时现有路径行为不变"

## 4. reconnect 第四个 resolver

- [x] 4.1 在 `src/mcp/reconnect.ts` 加 `resolveIdentityKeyReconnect`, 复刻现有三个 resolver 的 0/1/N 分支形状
- [x] 4.2 调整 `reconnect` 的 zod: `identity_key` 可选且**不进** `ui_pid`/`thread_id`/`base_url` 的 exactly-one 互斥组; 保持三者之间原有的互斥校验不变
- [x] 4.3 在 tools 层接线: 有 `identity_key` 时优先用它解析身份, 随后把 `ui_pid` (claude) 或 `thread_id` (codex) 交给现有 `executeRegister` 做 pane / delivery 重绑
- [x] 4.4 加测试: restart 恢复保留 `agent_id` 与未读游标; 未知键返回 `need_register`; 跨设备行不匹配; `__channel_proxy__` 行不匹配; 键优先于同时传入的 `ui_pid` 所指向的另一行
- [x] 4.5 加 codex 形状测试: `{identity_key, thread_id}` 无 `ui_pid` 时 delivery 被改写为新 thread, 且 pane 绑定走 pending pre-reg 回落路径

## 5. 提示词面

- [x] 5.1 `plugins/cross-agent-teams-channel/src/cli.ts` 的 `parseCliArgs` 读取 `XATS_IDENTITY_KEY` (仅 env, 不加 flag)
- [x] 5.2 `buildStartupHint` 增加有键分支: 把键的字面值内联进 `reconnect({identity_key: '<值>', ui_pid: $PPID})`, 排在"记得身份"/"不记得身份"两支**之前**, 并说明 `need_register` 时向用户要 `(team, name)` 且在随后的 `register_agent` 里带上同一个键
- [x] 5.3 无键时 hint 输出与改动前**逐字节相同** —— 加快照式断言把这条锁住
- [x] 5.4 proxy 自身的 `register_agent` 调用不得携带 `identity_key`, 加断言
- [x] 5.5 `register_agent` tool description 增加独立说明段: 读 `XATS_IDENTITY_KEY` 并在**每次**注册 (含首次) 传 `identity_key`; 明确它不是 `agent_type` 的 first-match-wins 探测项
- [x] 5.6 加测试: 有键时 hint 含字面值且分支顺序正确; 无键时不提及身份键; tool description 含 `XATS_IDENTITY_KEY` 且四个 `agent_type` 探测项未被改动

## 6. 验证

- [x] 6.1 `pnpm exec tsc --noEmit` 与 `pnpm -C plugins/cross-agent-teams-channel exec tsc --noEmit`
- [x] 6.2 `pnpm exec vitest run` 与 `pnpm -C plugins/cross-agent-teams-channel exec vitest run` 全绿
- [x] 6.3 `openspec verify add-identity-key-recovery`, 确认每个 scenario 都有对应实现与覆盖
