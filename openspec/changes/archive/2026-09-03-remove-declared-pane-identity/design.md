## Context

变更 `2026-08-14-add-declared-pane-identity` 在 xats 侧接入了 launcher 声明的 `(team, name)`: pre-reg 行持久化两列, 恢复通知在 key 未命中时改用声明排程, 并为此写下一套只对声明路径生效的保守判定 (无 pid → liveness unknown → 拒发).  launcher 侧现已整条删除该声明 (aoe `68621c6e`), xats 侧这条路径没有调用方.

现状是: 代码里有两条并行的持有者解析路径 (key / 声明), 一套必须靠 design 文档才守得住的不对称规则, 一处双向跨仓耦合 (标签字符集), 以及为让"无持有者的排程"过类型检查而放宽的 `agent_id: string | null`.

## Goals / Non-Goals

**Goals:**

- 代码与 spec 回到变更 `2026-08-14` 之前的形态, 恢复通知只有 key 一条来源.
- 移除是完整的: 入参、flag、列、判定、描述、类型放宽、测试、文档一个不留.  不留"列还在但不读写"这类半拆状态.
- key 路径行为逐字节不变.

**Non-Goals:**

- 不改 `identity_key` 的语义、四分支仲裁或恢复通知模板.
- 不为"座位换代后 key 重铸"这个原始问题提供替代方案 —— jt 已决定该问题由 launcher 侧靠 identity key 稳定性解决, 不在 xats 侧再引入身份来源.
- 不动 `validateNameLabel` / `validateTeamLabel` 本身 (它们服务于 `register_agent`, 与本变更无关).

## Decisions

### D1: 删列而不是留列

`codex_pane_pre_registrations` 的 `team` / `agent_name` 用 `ALTER TABLE ... DROP COLUMN` 删掉, 迁移对不存在的列跳过 (幂等).  `CREATE TABLE` 语句同步去掉两列.

理由: 留列意味着 spec 要多写一条"两列存在但永不读写"的 requirement, 且 repo 层的 `SELECT *` 类读法会继续把它们带进行类型.  半拆状态是下一个人最容易读错的形态.  SQLite `DROP COLUMN` 自 3.35 可用, 本机 better-sqlite3 内置 3.53.0; 两列无索引、无约束、无外键, 满足 `DROP COLUMN` 的限制条件.

**Alternative considered**: 留列, 只删读写.  否决, 理由如上.

回滚方向: 0.8.6 的迁移是 `if (!existing.has('team')) ADD COLUMN`, 对删过列的库会原样加回, 不会启动失败.

### D2: key 路径的持有者判定一个字不动

移除只删除声明分支, 不"顺手"把 key 路径的无 pid 读法改成 unknown.  原 design D3 明确写过两条路径不对称是刻意的; 现在声明路径没了, key 路径保持"无正数 pid → 视为可恢复 → 排程"的既有读法, 与变更前一致.

### D3: 收回 `agent_id: string | null`

声明路径可能在无持有者时排程 (首次分配), 所以 `pane-host-verify.ts` 的 `PaneHostRow.agent_id`、`FindPaneClaimantsFn.excludeAgentId`、`stillOwnsPane` 的 `agentId` 都被放宽成 `string | null`.  key 路径必有持有者, 放宽失去存在理由, 收回为 `string`.  若 typecheck 揭示别处也依赖 `null` (排除声明路径之外), 则保留放宽并在 tasks 里记录原因.

### D4: 测试按"整文件只测声明"与"fixture 顺带带上"两类处理

- 整文件只覆盖声明路径的 (`codex-recovery-declared-identity.test.ts`、`pre-register-codex-pane-declared-identity.test.ts`) 直接删除.
- 在 deps fixture 里带了 `findByDeclaredIdentity: () => undefined` 之类桩子的 recovery-poke 测试只删那一行.
- 断言"描述包含 `XATS_TEAM`"的测试 (`identity-key-tool-descriptions.test.ts`) 改为断言不包含, 因为描述里残留这两个变量名会让 agent 去读一个 launcher 不再设置的变量.
- CLI 与 schema 测试删除 `--team` / `--agent-name` / `team` / `agent_name` 的正向用例, 保留"未知 flag 被拒"的既有用例覆盖负向.

## Risks / Trade-offs

- **删列迁移在老 SQLite 上失败** → 本机与 CI 的 better-sqlite3 均内置 ≥ 3.35; 迁移前查 `sqlite_version()` 不做, 因为项目其他迁移也未做版本探测, 保持一致.
- **有人仍在传 `--team` / `--agent-name`** → CLI 按既有规则 `exit(2)` 并打印未知 flag, 与变更 `2026-08-14` 发布前 launcher 撞到的行为完全相同, 可识别.  已知唯一调用方 aoe 已不传.
- **描述删掉 `XATS_TEAM` 指引后, 环境里仍残留这两个变量的旧 pane** → agent 不再读它们, 首次注册回到问人; 这正是 jt 接受的形态 (channel proxy 开场白 "Do NOT register automatically").

## Migration Plan

单次发布.  迁移在 daemon 启动时执行; 已有 pre-reg 行 TTL 以分钟计, 删列不丢有意义的数据.  回滚即回滚代码 (见 D1).

## Open Questions

无.
