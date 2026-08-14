## 1. 存储与迁移

- [x] 1.1 `codex_pane_pre_registrations` 增加可空 `team` / `agent_name` 两列, 迁移对既有行填 NULL 且重复应用幂等
- [x] 1.2 `CodexPanePreRegRepo` 的行类型、写入与读取带上两列; 覆盖写在调用方省略时把两列一并置 NULL (与 `identity_key` 现有语义一致)
- [x] 1.3 保持 full-snapshot currency 比较字段不变 (`pane_id` / `xats_agent_id` / `identity_key` / `expires_at`), 不把声明加进去
- [x] 1.4 测试: 迁移新增列、旧行为 NULL、重复应用无副作用、round-trip、省略即清空

## 2. pre_register_codex_pane 入参与校验

- [x] 2.1 tool schema 增加可选 `team` / `agent_name`, 两者独立可选, 空串与纯空白拒收
- [x] 2.2 复用 `validateNameLabel` / `validateTeamLabel` 校验声明标签, 违规返回 `invalid_arguments` 并在 detail 里点名字段, 不写任何状态
- [x] 2.3 测试: `mvr-coder(monkeys)` 被拒、name 拒冒号、team 收冒号但拒括号、双引号/控制字符/U+2028/U+2029 被拒、空格与单引号合法、trim 后存储、纯空白被拒、半个声明可存储

## 3. CLI flag

- [x] 3.1 `--team` / `--agent-name` 加入 `PRE_REGISTER_FLAGS` 并解析转发, 缺值或下一 token 是 flag 时本地拒绝, 标签校验仍由 daemon 负责
- [x] 3.2 usage 文本同步; 确认命名为 `--agent-name` 而非 `--name` (与既有 `--agent-id` 区分, 且与 `XATS_AGENT_NAME` 一一对应)
- [x] 3.3 测试: 双 flag 转发、单 flag 转发、都不传时调用与变更前一致、daemon 的 `invalid_arguments` 能透传回非零退出

## 4. 排程时的身份解析

- [x] 4.1 `evaluateCodexRecoveryOnPreRegister`: key 命中走现状; key 未命中 (含无 key) 时改用完整声明排程
- [x] 4.2 声明路径的四分支持有者判定 —— 无行→排; 正 pid 死→排; 正 pid 活→不排; pid 空/非正→liveness unknown 不排并记日志
- [x] 4.3 半个声明不排程并记 debug 日志; 无 key 无声明维持现状不排程
- [x] 4.4 key 命中但与声明不一致时以 key 为准, 冲突记 debug 日志 (含两个身份, 不含 key 值)
- [x] 4.5 测试: 上述五种分支各一条, 外加"声明命名一个不存在的身份仍然排程"

## 5. 探测期的重解析

- [x] 5.1 声明来源的排程在每轮 poll 与每次 send 前按 `(device, team, name)` 重解析持有者, 而非按 key
- [x] 5.2 声明身份在窗口内复活或出现 pidless 行 → 取消排程并记原因; 仍缺失或有明确死 pid → 继续轮询
- [x] 5.3 保持 liveness 的保守读法 (正 pid 且在跑=活, EPERM=活); 声明路径下 pid 为空按 liveness unknown 拒发
- [x] 5.4 测试: 窗口内复活取消、持续缺失继续、每轮重读而非只读一次

## 6. 通知文案

- [x] 6.1 声明来源与 key 来源共用同一套固定模板, 内容不含 key 值, 也不暴露身份来自哪条查找
- [x] 6.2 排程日志记录身份来源 (key / declaration), 使区分留在日志而不在文案里
- [x] 6.3 测试: 两种来源文案一致、均不含 key 值、日志能区分来源

## 7. register_agent 工具描述

- [x] 7.1 面向所有 `agent_type` 增加 `XATS_TEAM` / `XATS_AGENT_NAME` 自报指引, 说明它是身份跨座位重建存活的原因
- [x] 7.2 说明 codex 是唯一读不到这两个变量的 runtime (工具跑在共享 app-server), 由 launcher 经 `pre_register_codex_pane` 代传
- [x] 7.3 确认两个变量不进入编号的 `agent_type` DETECTION 序列, 既有四条探测分支不变
- [x] 7.4 测试: `tools/list` 断言两个变量出现、指引非 codex 专属、DETECTION 序列未被污染

## 8. 收尾

- [x] 8.1 `openspec validate add-declared-pane-identity --strict` 通过
- [x] 8.2 typecheck 通过; 相关测试文件全绿 (不跑全量套件 —— 本机有实时 tmux session)
- [x] 8.3 变更集自检: 每一处改动都能追溯到 proposal 的 What Changes 或 specs 的某条 requirement

## 9. 归档前 review 收尾

- [x] 9.1 `holder_liveness_unknown` 的排程时与重解析日志统一写明该身份在带 pid 注册前不会自动恢复, 判据保持不变
- [x] 9.2 声明标签额外拒绝 U+2028 / U+2029 行分隔符, 同步 design/spec scenario 与定向测试
