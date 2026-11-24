## 1. 合同与持久化

- [x] 1.1 固定 JSON 合同和 helper 时序, 实现 schema 与持久源 fence.
- [x] 1.2 实现 prepare/status/abort 幂等, 冲突及重启恢复.

## 2. 受控交接

- [x] 2.1 实现 exact runtime probe, 提交 CAS, 原位身份及消息保留.
- [x] 2.2 实现旧注册/连接/回调隔离及 managed 显式跨类型 fence.
- [x] 2.3 接入本机鉴权 REST, 记录具体失败且不泄露 key/token.

## 3. 验证

- [x] 3.1 完成双向交接, 异步竞争, 协议和旧路径定向测试.
- [x] 3.2 完成类型检查, 隔离构建, OpenSpec 和独立 review.
- [x] 3.3 提供 AoE 联调候选与证据, 如实记录未部署边界.

验证边界: 23 个定向文件, 260 用例通过, tmux 护栏零调用.  类型检查, 隔离 ESM/声明构建和 OpenSpec strict 通过, 独立 review PASS.  HTTP/MCP 使用随机 loopback 与临时 DB, 新 runtime proof 使用 fake 或本地 HTTP fixture.  已将隔离候选和固定合同交 aoe-main 联调, AoE helper 对隔离候选的 HTTP/CLI 联调 4/4 通过, 真实 AoE pane/三类原生产品生命周期尚未验收, 共享 daemon/dist 未修改.
