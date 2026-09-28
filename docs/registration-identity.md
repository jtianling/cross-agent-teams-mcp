注册身份来源与 pane token 边界

- 新注册的 name 必须由用户明确指定.  缺少 name 时先询问, 不能从运行时类型, thread ID, cwd 或角色生成名字.
- 用户已指定 name 的新注册仍可使用 project_dir 默认 team.  恢复旧身份必须保留完整旧 name/team, 不得用 cwd 默认值替代未知的旧 team.
- pane token 只证明 pane 归属, 本身不发起注册或重连.  已知完整旧身份时可附带 token 重新注册, 否则保留 token 并询问身份.
- 用户明确要求 reconnect 时可通过现有运行时绑定查找旧身份.  need_register 表示没有找到旧身份, 必须询问缺失信息, 不授权创建新身份.

2026-09-24 调查记录: aoe-main 和 tester 都在仅收到 pane token 后调用 reconnect, 随后受返回值中的 `call register_agent to register a new identity` 引导, 分别自行选择 `codex` 和 `codex-<thread 前缀>`.  两者均确认名字不是用户指定的.  修复覆盖 pane 通知, MCP 通用说明, register_agent/reconnect 描述, name schema 描述及无匹配返回文本.

项目经验: 只在工具长描述中要求询问不够.  直接返回给模型的失败提示也必须表达身份授权边界, 避免把恢复失败写成创建身份的行动指令.
