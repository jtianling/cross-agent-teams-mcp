## 1. 存储与迁移

- [x] 1.1 `src/storage/schema.ts`: `CREATE TABLE codex_pane_pre_registrations` 去掉 `team` / `agent_name`; 迁移改为对已有两列 `DROP COLUMN` (列不存在时跳过, 幂等)
- [x] 1.2 `src/mcp/codex-pane-pre-register-repo.ts`: 行类型、insert/upsert、select 去掉两列
- [x] 1.3 测试: `tests/codex-pane-pre-register-repo.test.ts` 删除声明相关用例, 新增"迁移删列且重复应用无副作用"

## 2. pre_register_codex_pane 入参

- [x] 2.1 `src/mcp/pre-register-codex-pane.ts`: schema 去掉可选 `team` / `agent_name`, 删除 `declaredIdentityError` 及 trim/写入逻辑
- [x] 2.2 `src/mcp/tools.ts`: `pre_register_codex_pane` 描述删除声明段落
- [x] 2.3 测试: 删除 `tests/pre-register-codex-pane-declared-identity.test.ts`; `tests/codex-prereg-identity-key-schema.test.ts` 与 `tests/pre-register-codex-pane-service.test.ts` 删除声明用例, 补一条"传 `team` / `agent_name` 被 strict schema 拒绝"

## 3. CLI flag

- [x] 3.1 `src/cli.ts`: `--team` / `--agent-name` 从 `PRE_REGISTER_FLAGS` 与 usage 移除, 删除 `parseDeclaredIdentityFlag` 及转发
- [x] 3.2 测试: `tests/pre-register-cli-identity-key.test.ts` 删除声明转发用例, 补一条"`--team` 作为未知 flag `exit(2)` 且不联系 daemon"

## 4. 恢复通知排程

- [x] 4.1 `src/mcp/codex-recovery-poke.ts`: 删除 `findByDeclaredIdentity` dep、`declaredHolderRefusal`、声明路径排程分支、半声明/冲突日志、每轮按名重解析; key 未命中即 return
- [x] 4.2 `src/mcp/tools.ts`: 删除 `findDeclaredIdentityHolder` 与 deps 注入
- [x] 4.3 `src/mcp/pane-host-verify.ts` / `src/mcp/poke.ts`: `agent_id` / `excludeAgentId` / `stillOwnsPane` 的 `string | null` 收回为 `string`; 若 typecheck 揭示声明路径之外的依赖, 保留并在此记录
- [x] 4.4 测试: 删除 `tests/codex-recovery-declared-identity.test.ts`; `codex-recovery-poke` / `codex-recovery-final-confirm` / `codex-seeding-poke` / `codex-prompt-readiness-callers` / `poke-retry-shutdown` / `codex-seat-follow-recovery` / `auto-bind-codex-pane` / `pre-register-recovery-wiring` / `pane-host-verify` 各测试去掉 `findByDeclaredIdentity` 桩与 null 用例; 保留并确认"Unknown key schedules nothing"用例存在

## 5. register_agent 工具描述

- [x] 5.1 `src/mcp/tools.ts`: `register_agent` 描述删除 `XATS_TEAM` / `XATS_AGENT_NAME` 指引与 codex 例外说明, DETECTION 序列不动
- [x] 5.2 测试: `tests/identity-key-tool-descriptions.test.ts` 改为断言两个描述均不含 `XATS_TEAM` / `XATS_AGENT_NAME`, DETECTION 断言保留

## 6. 文档

- [x] 6.1 `docs/launchers/free-xats-codex.md`: 去掉 `declared_identity_args` 与 `XATS_TEAM` / `XATS_AGENT_NAME` 说明
- [x] 6.2 `README.agent.md`: launcher 示例去掉 `declared_identity_args`

## 7. 收尾

- [x] 7.1 全仓 grep (排除 `.worktrees` 与 `openspec/changes/archive`) 确认 `findByDeclaredIdentity` / `declaredHolderRefusal` / `XATS_AGENT_NAME` / `--agent-name` / `agent_name` (pre-reg 语境) 零残留
- [x] 7.2 `openspec validate remove-declared-pane-identity --strict` 通过
- [x] 7.3 typecheck 通过; 本变更触及的测试文件全绿 (不跑全量套件 —— 本机有实时 tmux session)
