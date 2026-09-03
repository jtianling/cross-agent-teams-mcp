## Why

launcher (aoe) 已在提交 `68621c6e` 整条删掉 declared identity: New Session 对话框的 xats Team / Name 字段、pane 的 `XATS_TEAM` / `XATS_AGENT_NAME` 环境变量、codex 预注册的 `--team` / `--agent-name` 及为它加的降级重试都不复存在, 之后 aoe 对 xats 只传 `--pane / --agent-id / --identity-key-env / --ttl`.  jt 拍板的理由: pane 重建应靠 identity key 在 xats 侧认回, 不该靠 TUI 上的一次输入.

于是 xats 侧由变更 `2026-08-14-add-declared-pane-identity` 引入的整条消费链路 —— pre-reg 行的两列、`pre_register_codex_pane` 的两个入参与标签校验、CLI 两个 flag、`codex-recovery-poke` 的声明路径 (含四分支持有者判定与 `holder_liveness_unknown` 那套刻意的不对称)、`register_agent` 描述里的自报指引 —— 不再有任何调用方.  它带着一处双向的跨仓耦合 (标签字符集必须与 launcher 同步) 和一段必须被读懂才不会被"统一"掉的不对称规则, 留着只有维护成本.  本变更把它整条移除, 让代码与 spec 回到该变更之前的形态.

## What Changes

- **BREAKING** `pre_register_codex_pane` 不再接受 `team` / `agent_name`; 传入即被 zod strict schema 拒绝.  `declaredIdentityError` 与其标签校验一并删除.
- **BREAKING** CLI `pre-register-codex-pane` 不再认识 `--team` / `--agent-name`, 从 `PRE_REGISTER_FLAGS` 与 usage 中移除; 传入按既有"未知 flag → `exit(2)`"规则本地拒绝.
- `codex_pane_pre_registrations` 表删除 `team` / `agent_name` 两列: `CREATE TABLE` 不再声明它们, 迁移对已有表 `DROP COLUMN` (幂等), `CodexPanePreRegRepo` 行类型与读写同步收窄.
- 恢复通知排程回到"仅按 `identity_key` 查持有者": key 未命中 (含无 key) 即不排程; 删除 `findByDeclaredIdentity` / `declaredHolderRefusal` / 声明路径的每轮重解析 / 半声明与 key-声明冲突日志.  Key 路径的持有者判定 (正 pid 活 → 不排, 其余 → 排) 原样保留.
- `register_agent` 与 `pre_register_codex_pane` 工具描述删除 `XATS_TEAM` / `XATS_AGENT_NAME` 自报指引及 codex 例外说明.
- 由声明路径引入的 `agent_id: string | null` 类型放宽 (`pane-host-verify.ts` / `poke.ts`) 收回为 `string`.
- 相关测试删除或改写; `docs/launchers/free-xats-codex.md` 与 `README.agent.md` 中的 launcher 示例去掉 `declared_identity_args`.

## Capabilities

### New Capabilities

<!-- 无: 本变更只做移除. -->

### Modified Capabilities

- `agent-registry`: 移除四条 ADDED requirement (pre-reg 表两列、声明标签校验、CLI 转发声明、`register_agent` 描述指引); `pre_register_codex_pane tool records pending tmux pane claim` 与 `... overwrites existing entry for same pane` 两条回退到不含 `team` / `agent_name` 的形态.
- `agent-delivery`: 移除 `A declared-identity schedule re-resolves its holder by name, not by key`; `Recovery poke is scheduled when an identity-key pre-registration hits a known identity`、`Recovery poke scheduling follows the pre-reg row lifecycle`、`Recovery poke wording guides re-registration with the recovered identity` 三条回退到"key 未命中即不排程、无声明来源"的形态.

## Impact

代码: `src/storage/schema.ts` (建表语句与迁移)、`src/mcp/codex-pane-pre-register-repo.ts`、`src/mcp/pre-register-codex-pane.ts` 及其 schema、`src/cli.ts`、`src/mcp/codex-recovery-poke.ts`、`src/mcp/tools.ts`、`src/mcp/pane-host-verify.ts`、`src/mcp/poke.ts`.

测试: 整文件删除 `tests/codex-recovery-declared-identity.test.ts`、`tests/pre-register-codex-pane-declared-identity.test.ts`; 局部删改 `tests/codex-pane-pre-register-repo.test.ts`、`tests/codex-prereg-identity-key-schema.test.ts`、`tests/identity-key-tool-descriptions.test.ts`、`tests/pre-register-cli-identity-key.test.ts`、`tests/pre-register-recovery-wiring.test.ts`、`tests/pane-host-verify.test.ts` 及若干只在 deps fixture 里带 `findByDeclaredIdentity` 的 recovery-poke 测试.

文档: `docs/launchers/free-xats-codex.md`、`README.agent.md`.

跨仓: launcher 侧已先行删除, 本变更发布前后 aoe 的调用形态不变 (它已不传这两个 flag), 无需协调切换.  变更 `2026-08-14` 在 proposal 里记下的"标签字符集变更必须通知 launcher"这条双向正确性依赖随之解除.

兼容性: 数据库迁移删列在 SQLite ≥ 3.35 可用 (本机 better-sqlite3 内置 3.53.0).  若回滚到 0.8.6, 其 `ADD COLUMN` 迁移会把两列重新加回, 不会因缺列而启动失败.
