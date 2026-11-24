## 1. 协议与证明

- [x] 1.1 固定请求响应合同并与AoE协调, 复用schema和物理pane证明.
- [x] 1.2 实现OpenCode exact attach载体与无key登记支持, 不猜已停止pane.

## 2. 原子删除

- [x] 2.1 实现两轮probe和事务中完整归属/竞争者CAS, 批量原子移除.
- [x] 2.2 接入REST门禁与MCP收尾, 保留消息及旧注销兼容.

## 3. 验证与交付

- [x] 3.1 完成归属转移, 晚到注册, 存储回滚和HTTP/MCP定向测试.
- [x] 3.2 完成类型检查, 隔离构建, OpenSpec严格验证和独立review.
- [x] 3.3 给AoE隔离联调候选与证据, 明确共享服务未激活.

验证结果: 14个定向文件170项通过, 宿主tmux/ps护栏零调用, TypeScript/隔离ESM与声明构建/OpenSpec strict通过, 独立review PASS.  默认探针还通过自建Unix socket与假tmux/ps可执行文件验证显式socket和子进程环境清理.  未操作真实成员/共享daemon, 未提交或发布.  候选交AoE联调, 客户端独立mock smoke不冒充已激活.

## 4. 上一 server 代次的历史 pane 别名

- [x] 4.1 复现不同 key 的旧物理别名阻断, 实现窄范围历史证明, 不删除历史身份.
- [x] 4.2 保留逻辑 runtime owner, 补充旧 PID 复用, 归属变化, 晚到 managed 与 peer 原子失败测试.
- [x] 4.3 补充 HTTP 历史消息及 MCP 连接保留和脱敏 409 日志, 完成独立 review.
- [x] 4.4 完成最终隔离构建, 定向回归与 OpenSpec strict, 交付候选及激活限制.

历史物理别名修复验证: 4 个定向文件共 64 项通过, typecheck, 隔离 ESM/声明构建, OpenSpec strict 和独立 review PASS.  原 API 未放宽全局未知 Codex logical owner 检查, 当前存量删除另走用户明确授权的 AoE 准确物理 pane 关闭流程.  交付与激活边界见 `docs/historical-pane-release-fix.md`, 本轮没有激活共享服务.

## 5. 显式 dead key 缺席证明

- [x] 5.1 固定原批target的strict opt-in flag和独立响应状态, 服务端独立采集pane_dead.
- [x] 5.2 实现含proxy的agent/key/pane缺席, prepared/bound managed和旧binding关联快照同事务复核.
- [x] 5.3 完成核心TDD, respawn/晚到归属/存储回滚/真实loopback HTTP和默认probe隔离回归.
- [x] 5.4 完成最终独立复审, 类型检查, 隔离构建, strict验证及候选交付; 不自行激活.

显式dead key缺席证明验证: 6 个定向文件共 102 项通过, typecheck, 隔离 ESM/声明构建, OpenSpec strict和独立review PASS.  编译CLI的真实隔离HTTP合同验证旧dist400且probe零调用, 候选200有序混合响应, prepared managed反例409且peer保留.  完整候选相对当前dist仅9个生产文件变化, 包含未激活历史别名窄修复; 不新增ticket/DB schema.  证据和待批准激活流程见 `docs/dead-pane-key-absence.md`, 本轮未切换共享服务.
