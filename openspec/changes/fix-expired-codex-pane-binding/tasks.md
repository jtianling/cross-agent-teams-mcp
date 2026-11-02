## 1. 根因与回归

- [x] 1.1 将真实 delivered→TTL 到期→迟到注册链路转为隔离 RED 回归.
- [x] 1.2 实现 challenge 的 pane/launch/期限作用域, 保持一次性和替换隔离.

## 2. 明确状态与安全重试

- [x] 2.1 Codex 注册附加 launch_binding 与具体原因, 不改 binding lookup v1.
- [x] 2.2 提交前校验 TTL, 验证重新预登记新 challenge 的安全重试, 不放宽 carrier/CAS.
- [x] 2.3 更新启动器契约, 根因记录与部署激活边界.

## 3. 独立验证

- [x] 3.1 运行隔离定向测试, 类型检查与临时目录构建, 不运行全量或操作实时 tmux.
- [x] 3.2 完成独立代码评审与 tester 验收, 明确真实环境限制.
