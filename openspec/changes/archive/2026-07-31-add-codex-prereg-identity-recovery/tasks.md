# Tasks: add-codex-prereg-identity-recovery

## 1. Storage: pre-reg 表 identity_key 列

- [x] 1.1 schema.ts: `codex_pane_pre_registrations` 幂等 ADD COLUMN `identity_key` (可空 TEXT), 补迁移测试 (旧库启动两次不报错, 旧行 NULL)
- [x] 1.2 codex-pane-pre-register-repo.ts: 行类型与 upsert/list 读写带 `identity_key`; 同 pane 覆盖时无 key 的新行清空旧 key, 补 repo 测试

## 2. 入口: tool 与 CLI 接受 identity_key

- [x] 2.1 pre-register-codex-pane.ts: 输入 schema 加可选 `identity_key` (min 1, 空串报 invalid_arguments), 存储透传, 补 service 测试
- [x] 2.2 cli.ts: `pre-register-codex-pane` 子命令加 `--identity-key-env [VAR]` (默认 `XATS_IDENTITY_KEY`, key 从环境变量取值不落 argv); 环境变量缺失/为空本地 fail-fast 不调 daemon; 不带 flag 行为与现状逐字节一致, 补 CLI 测试
- [x] 2.3 tools.ts: `pre_register_codex_pane` tool schema 与 description 更新 (说明 key 只走本通道、不进 argv)

## 3. 恢复调度: pre-register 时刻识别 + 进程探测 gate

- [x] 3.1 新模块 codex-recovery-poke.ts: pre-reg 接受后按 `findByIdentityKey` 查 (team, name); miss 或 holder `runtime_ui_pid` 存活则不调度 (存活跳过记 debug 日志), 补单测
- [x] 3.2 探测轮询: 以 pane_id 为键的内存调度, 复用 autoBindCodexPane 的 listPanes/ttyProcesses/isCodexRemoteProcess/argvContainsUuid 原语, 间隔轮询, 每轮先校验行未过期/未消费/未覆盖, 过期即终止, 补单测 (注入探测桩, 不碰真实 tmux)
- [x] 3.3 首发发送: 探测命中后走 quiet-guard + pane-host-verify + ownership 复查; 瞬态拒绝 (guard_failed / 载体后台化) 同代回到探测轮询按探测间隔续试 (不入长退避梯子), 以行生命周期为界, 补单测
- [x] 3.4 话术模板: 自报恢复通知 + (team, name) + register_agent 指引 (thread_id 用 $CODEX_THREAD_ID); 断言模板不含 identity_key 值
- [x] 3.5 tools.ts: pre_register 处理入口接上调度; 同 pane 覆盖调用取消旧调度并按新行重新决策, 补单测

## 4. auto-bind 消费: 附 key + 取消调度

- [x] 4.1 auto-bind-codex-pane.ts: 消费带 key 的行时按 planIdentityKeyBinding 附 key 到 caller 行 (bind/幂等/migrate); caller 行已持不同 key 时跳过附 key 只记 debug, pane 绑定与消费照常, 补单测
- [x] 4.2 消费成功即取消该 pane 的 pending 恢复调度 (被 poke 过与否均取消), 补单测
- [x] 4.3 附 key 任一失败不腐蚀 register_agent 结果 (沿用既有约束), 补失败注入测试

## 5. Seat-follow: 同 pane 重注册 key 跟随

- [x] 5.1 agents-repo.ts: `findKeyHoldersBySeat` — 按 rebind 后存活的字段 (runtime_ui_pid / runtime_tty) 匹配同 device 其他持 key 行, 排除 caller 与 proxy 行, 补 repo 测试
- [x] 5.2 新模块 codex-seat-follow.ts: 单候选走 planIdentityKeyBinding 四分支 (同进程 rename 迁移 / 死 holder 迁移 / 异进程存活不动只记 debug / caller 已持 key 跳过); 0/多候选 no-op 只记数量; 失败 catch + redacted 日志不腐蚀注册结果, 补单测
- [x] 5.3 tools.ts: autoBindRuntimeIdentity 两条 codex 绑定路径 (autoBindCodexPane 与 detectTmuxPane fallback) 成功后接 seat-follow 钩子, 补 register 集成测试 (fallback 路径触发迁移)
- [x] 5.4 恢复联动: 迁移后 findByIdentityKey 解析到新行, recovery poke 话术指向新 (team, name), 恢复模块零改动, 补测试

## 6. Same-thread 证据统一语义: 有证据即决不扫 pre-reg、决不全局探测 (线上事故修复)

- [x] 6.1 agents-repo.ts: `findRuntimeByThread(thread_id, localDevice, excludeAgentId?)` — 同 device codex-appserver thread 相等且仍有 runtime 绑定 (`runtime_ui_pid` / `runtime_tty`) 的行, 返回完整座位字段 (pid / tty / pane / runtime_bound_at); excludeAgentId 可选 (省略时含 caller 复用行), 排除 proxy 行, 补 repo 测试 (单命中 / tty-only / miss / 多命中 / 不排除时含 caller / proxy 与跨设备排除)
- [x] 6.2 tools.ts + same-thread-seat.ts: register 流程在 upsert 前捕获 caller 行的 pre-upsert thread (upsert 保留 runtime 但覆盖 thread); autoBindRuntimeIdentity codex 分支在扫 pre-reg 之前解析 same-thread 证据 (含 pre-upsert thread 相等时的 caller 复用行), 证据行按物理座位折叠 (共享正数 pid / tty 归并, last-writer-wins 持有者胜出); 唯一座位精确继承 (正数 pid 走 bind pid 路径 fresh 校验; pid-less 用记录的 tty/pane 精确绑定, 不探测); 多座位 / 继承失败 / 无可绑定信息一律 fail-closed (不扫 pre-reg、不全局 detect、不绑 runtime, register 照常成功); 继承成功后 seat-follow 照常; 无证据 (新 thread) 才走 pre-reg 扫描与 detect fallback; 决策记 debug 日志 (只记行数/座位数与 agent id); 拆分为 ≤50 行的小函数
- [x] 6.3 register 级集成测试: 事故复现 (同 thread rename + 外来可消费 pre-reg 行 → 外来行不动、rename 继承旧 runtime、K1 迁移、shell 之后自己消费 EECF3E35); 重启流 (同名新 thread 无证据, pre-reg 照常消费); rename 链 A→B→C 共座多行折叠继承; 同名同 thread 重注册跳扫并重绑自己保留的座位; pid-less 座位精确 tty/pane 绑定不探测; 多个不同物理座位 fail-closed 不扫不探测不绑; 继承失败 fail-closed + detect 本会返回外来 pane 的腐坏回归 (断言决不绑上)
- [x] 6.4 spec delta / design.md (D9) / CHANGELOG 记录统一语义
- [x] 6.5 pre-upsert 捕获 CAS 原子化: agents-repo `register` 事务内 SELECT prior → upsert → 原子返回行实际 prior 状态 (`IdentityRowSnapshot`: prior codex thread + pid/tty/pane/runtime_bound_at), 经 RegisterAgentService / RegisterCodexSelfService 结果线程化到 tools.ts (kimi/opencode/generic/codex 全路径对外 envelope 剥离), 补 repo 测试
- [x] 6.6 tools.ts CAS 校验: 探测前快照 vs 事务返回 prior 不等即本次注册 runtime auto-bind fail-closed (无 caller-row 证据、不扫 pre-reg、不全局探测、不绑 runtime, register 照常成功); 相等时以事务返回的 prior thread 为 caller-row 证据输入; 并发回归测试 (可控探测门注入, 两种交错: stale false-negative 不落外来扫描 / stale false-positive 不继承并发会话的座位), RED 验证 (关闭 CAS 时两用例均失败)
- [x] 6.7 统一决策日志: same-thread 全部结局 (none / inherit 成功与失败 / ambiguous / cas_drift) 经单一决策点记录行数、座位数与涉及 agent id (决不含 key 值), 折叠结果全结局携带计数, cas_drift 带独立 reason; 测试断言日志行

## 7. Bind 阶段 late-write 防护: register_generation 条件写 (round-14 CRITICAL)

- [x] 7.1 schema.ts: agents 表幂等 ADD COLUMN `register_generation` (INTEGER NOT NULL DEFAULT 0), 沿用既有 ALTER 模式; 补迁移测试 (fresh 库带列 / 旧库启动补列旧行 0 / 二次启动幂等)
- [x] 7.2 agents-repo.ts: register upsert 同一事务内自增 generation 并随 prior_snapshot 一起返回; setRuntimeBinding 加可选 `expected_register_generation`, UPDATE 变 `WHERE agent_id = ? AND register_generation = ?`, 0 行时跳过在位 pane 驱逐并返回 changes; 补 repo 测试 (递增 / stale 0 行不动行不驱逐 / 无 generation 保持无条件)
- [x] 7.3 generation 经 RegisterAgentService / RegisterCodexSelfService / RegisterOpencodeSelfService 结果线程化到 tools.ts, 对外 envelope 全路径剥离 (与 prior_snapshot 同点)
- [x] 7.4 BindRuntimeIdentityService.bind 加 `expectedRegisterGeneration`; 四条 register-time 路径 (显式 ui_pid / same-thread 继承 / pre-reg auto-bind 消费 / detect fallback) 全部传入; 0 行改动即 `stale_registration_bind` fail-closed (不写 runtime、不跑 seat-follow), 独立 reason 日志只记数量与 id (显式 bind_runtime_identity tool 的处置后被 round-15 收紧, 见 7.7)
- [x] 7.5 bind 阶段并发回归 (register 级): 门控验证 await — A 过 CAS 后挂起在 bind 验证, B 完成同名注册 (thread U + 座位 S2), 释放 A → 行保持 B 的 thread U 与座位 S2, A 零 runtime 写零 seat-follow, 结局为 stale_registration_bind 日志
- [x] 7.6 spec delta (generation 条件写要求 + late-bind 场景) / design.md (D9 扩展) / CHANGELOG 更新
- [x] 7.7 (round-15) CAS drift 残留座位条件清空: agents-repo 加 `clearRuntimeBinding` (全部 runtime 座位字段, `WHERE agent_id AND register_generation`), tool 层 drift 检出后以本次铸出 generation 调用, 0 行 (generation 已推进) 不扰动; 两个 drift 测试终态断言翻转为全 NULL + 清空日志; dispatch 侧补 "appserver 普通失败且无 pane 决不 tmux fallback" 测试
- [x] 7.8 (round-15) 手动 bind capture-at-call-start: BindRuntimeIdentityService 未显式传 generation 时默认取 caller 行当前 generation 作条件写期望, 调用前历史注册不挡、调用期间新注册 `stale_registration_bind` fail-closed; 新增 stage-gate 并发测试 + 历史注册不阻塞测试; spec 的 "手动 bind 无条件" 场景改写
- [x] 7.9 (round-15) 注册成功结果 `register_generation` 类型必填 (RegisterResult / RegisterCodexSelfResult); tool 层对畸形内部结果记 invariant error 并让 runtime auto-bind fail-closed
- [x] 7.10 (round-16 warnings) 内部契约收口: `prior_snapshot` 类型必填, codex 结果缺字段按 CAS drift 处理 + invariant 日志; generation 校验收紧为正 safe integer, drift 清空无有效 generation 时跳过并记 skipped 日志; register-time 入口 (tools.ts helper + AutoBindCodexPaneInput) generation 参数必填, call-start capture 仅留在显式 rebind service 可选参数
- [x] 7.11 (round-17 warnings) service 边界 generation mode 改 discriminated 二选一 (`expectedRegisterGeneration` / `captureCurrentGeneration: true`), 手动 tool 显式选 capture; invalid generation + drift 的注册响应改专用 invariant hint (不复用 no-pane hint); 补 W1/W2 相互独立的判别测试 (缺 prior + 合法 generation → 按 drift 处理且清空仍执行; 表驱动 NaN/Infinity/-1/0/1.5 → skipped 日志 + 专用 hint + 清空不执行)

## 8. key 矛盾行不作候选 (联测现场事故)

- [x] 8.1 auto-bind 候选资格加 key 归属仲裁 (载体探测之后, 复用 `planIdentityKeyBinding`): caller 行已持不同 key → `identity_key_contradiction`; 四分支返回 identity_key_conflict (holder 是另一身份且存活, 覆盖 caller 无 key 的情形) → `identity_key_live_holder_conflict`; 两者都跳过该行 (不绑不消费不附 key), debug 日志决不含 key 值; caller 行惰性读取, 行内无 key 时完全不触碰 attach deps
- [x] 8.2 测试: 事故形态 (外来带 key 行不被绑不被消费、行与 key 原样保留、无 bind 调用) / 双行过滤后自己的行成为唯一候选并绑定 / 无 key 行仍可被持 key 的 caller 消费 / 存活 holder + 无 key caller 也被剔除; 既有 "mismatch 仍消费" 与 "live holder 仍消费" 两个用例按新语义改写
- [x] 8.3 spec delta (候选排除要求 + 场景) / design D4 改写 (含事故根因) / proposal 表述 / CHANGELOG 更新
- [x] 8.4 (实验室 S1/S1b 补) holder 为另一身份且无正数 pid 时按 liveness UNKNOWN 剔除候选 (`identity_key_holder_liveness_unknown`); detect fallback 拒绝绑定仍挂未过期 pre-reg 行的 pane (`pane_has_pending_prereg`); 各配单测 + spec 场景
- [x] 8.6 (R19 CRITICAL-1) 候选资格不再复用 planIdentityKeyBinding: 候选 pane 的载体 pid 不得充当 caller 所有权证据 (holder pid === 候选 pid 时旧实现自我豁免); 改为只认正面证据 — 另一身份的 key 一律 foreign, 除非有正数 pid 且探测为不在运行; 配同-pid 回归
- [x] 8.7 (R19 CRITICAL-2) 仲裁与提交共享前提: bind 之后于同一同步事务内重新仲裁 + 条件消费 + 附 key; 判定 foreign 时不消费不附 key —— **本条的"事后按 generation 条件回滚绑定 + `stage=post_bind` 日志"已被 8.9 推翻**: 事后回滚无法还原 LWW 驱逐掉的在位 pane, 现语义是绑定根本不落地, 日志串为 `stage=post_verify`
- [x] 8.8 (R19 WARNING) proposal.md 表述同步为候选剔除语义; auto-bind 测试按 identity_key 主题拆出独立文件 (两文件均回到 800 行上限内)
- [x] 8.5 实验室夹具 (daemon 侧): `lab/` 隔离启停 + MCP 调用入口 + 只读事实口径 + S1/S1b 场景脚本; 实跑发现并堵上两个隔离漏洞 (codex app-server 默认指向生产 8799; daemon 裸调 tmux 会连共享 server, 需 TMUX_TMPDIR + 清空 $TMUX)

- [x] 8.9 (R20 CRITICAL-1/3/4) bind 拆分为异步 verify (不落库) 与同步 commit; auto-bind 的"重仲裁 + runtime 写 + 条件消费 + 附 key"进同一事务, 拒绝或抛错整体回滚 (在位 pane 驱逐一并回退, 附 key 失败连带回滚消费); `runAtomic` 改必填, 不留无事务降级; 配三条回归 (真实 repo 断言在位 pane 存活 / 验证期间 holder 出现时 commit 零调用 / 事务内抛错后行与 key 原样并记 rolled back)
- [x] 8.10 (R20 CRITICAL-2) detect fallback 的 pane_has_pending_prereg 检查压进最终写的同一事务, pid 与 tty 两条形态共用同一提交前提 (早退检查仅用于省探测, 非权威)
- [x] 8.11 (R20 WARNING) proposal Modified Capabilities 表述同步; autoBindCodexPane 拆为 autoBindCodexPane/collectCandidates/evaluateRow/commitClaimedPane/runClaimCommit (191 行 → 40/51/34/33/54)
- [x] 8.12 (R21 CRITICAL) 附 key 的三条**返回式拒绝** (caller 行不存在 / caller 持另一把 key / planner 判定 holder 在线) 改为返回判别式结果并统一抛错回滚 —— 原实现 log + return 后仍报 `bound_consumed`, 提交的是最坏状态 (在位 pane 已驱逐、恢复行已消费、key 没附上, 而该行是这把 key 的唯一载体); 配 CRITICAL-1b 回归 (真实 commit 落地后才拒绝, 断言 caller/在位/行/key 全恢复), 并实测 RED 基线
- [x] 8.13 (R21 WARNING) fallback TOCTOU 真覆盖: 用第二个 MCP client 在 runtime verify 的 await 窗口内 announce pane, pid/tty 两形态表驱动, 各自钉死 bind 输入形态 (R22 WARNING); 修 `{g}` 强转 number 的夹具缺陷; `tryDetectFallbackBind` 89 → 34 行 (拆 paneHasPendingPreReg/commitFallbackBind/verifyFallbackIdentity), runClaimCommit 54 → 29, collectCandidates 51 → 41
- [x] 8.14 (全量回归) `tests/agents-schema.test.ts` 的精确列名断言补 `register_generation` —— 该断言自本变更加列起就红着, 被"按关键词筛选测试文件"的做法漏掉 (`agents-schema` 不匹配 `agents-repo`); 此后回归一律跑全量

## 9. 回归与收尾

- [x] 8.1 全量类型检查与构建 (`npm run build` / `tsc`); 单测套件通过 (注意: 有实时 session, 不跑依赖真实 tmux 的用例, 全部走注入桩)
- [x] 8.2 无 key 路径回归: 不带 identity_key 的 pre-register/auto-bind/poke 现有测试全绿, 行为零变化
- [x] 8.3 CHANGELOG 更新; 与 aoe 的配对契约点记录 (--identity-key-env 可选、key 走环境变量不落 argv、降级、ttl_seconds、发布顺序 xats 先发)

## 10. 同 thread 座位的载体已死时不再 fail-closed (实验室 S7 发现)

- [x] 10.1 缺陷: same-thread 证据此前是**终点** — 唯一座位要么继承要么 fail-closed.  座位记录的 pid 属于已死载体时继承不可能, 而 fail-closed 恰好掐死恢复本身要救的场景: pane 被 recovery 叫醒却无处落地, pre-reg 行无人消费, key 附不上.  S7 双形态 (in-pane 保 pty / `respawn-pane -k` 换 pty) 红在同一条 reason 上, 且 recovery 链路 (schedule/detect/deliver) 全绿并已解析出新 carrier — 断点严格在下游重注册的仲裁
- [x] 10.2 语义改为"证据**指向**而非**终结**": 座位载体**确证已死**时继续走 pre-reg 扫描, **且只到扫描** — 决不到全局 pane 探测 (座位没了不代表知道 caller 现在在哪个 pane); 无证据路径的落到探测的行为不变; 新 outcome `inherit_seat_vacated`, 日志尾巴写明"pre-reg scan only, no pane detection"
- [x] 10.3 护栏一 — "确证已死" = 记录了**正数 pid 且该 pid 不在运行**; 无 pid 的座位 (tty/pane 绑定本就不记 pid) 是**存活性未知**, 不是死, 仍 fail-closed (与 identity_key 仲裁、seat-follow 同一条规矩)
- [x] 10.4 护栏二 — bind 因**注册已被取代** (`stale_registration_bind`) 而失败时**仍然终止**, 与存活无关: 行已推进过的注册不得据此获得任何新路径; 把这一条交给扫描自身的 generation 条件写去挡是纵深防御, 不能顶替规则本身.  **本条由既有并发用例抓出** — 第一版修复只判存活, 会把被取代的注册送进扫描并在决策日志里贴错标签
- [x] 10.5 测试: 座位确证已死 → 走扫描并重绑新 carrier、消费行、附 key、`detectTmuxPane` 零调用; 无 pid 座位 → 仍 fail-closed 且可消费的行原样保留.  双向变异验证 — 钉死放行 → 新用例红在 `inherit_fail_closed`; 存活判据改恒真 → **三个**用例红 (含两个既有); 全量 191 文件 / 1222 用例绿
- [x] 10.6 实验室验收: S7 双形态由红转绿, 且绿是**正向**断言 (重绑到 carrier #2、pre-reg 行被消费), `--respawn` 跨 pty 后仍绑对; 其余 8 格与基线一致.  换根作为混淆项已先用旧 dist 同根对照消掉; 唯一差异格 (S1 多一条 `pane_has_pending_prereg`) 经因果实验归因于**共享实验室里别人的 pane**, 非本次修复
