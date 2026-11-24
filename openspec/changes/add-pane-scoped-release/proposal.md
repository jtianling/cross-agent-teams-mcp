## Why

AoE 删除 session 前需要释放各普通 pane 的 xats 身份, 当前按 agent_id 删除的 REST 缺少物理归属与注册代次复核.  先 lookup 再调用旧 DELETE 会在归属转移时误删新持有者.

## What Changes

- 新增本机批量 panes/release, 最多16个活pane, 先验证全部再事务删除.
- 复用精确socket/server代次/pane/carrier证明, 可附原identity key和OpenCode exact session.
- 支持HTTP OpenCode无存量pane字段时从前台attach参数核对native runtime, 不猜session.
- 复用registry删除, 保留消息, 收尾对应MCP session及旧绑定, 未注册/重复释放幂等.

## Capabilities

### New Capabilities

- `pane-scoped-release`: 受物理归属和注册快照约束的launcher批量反注册.

### Modified Capabilities

无.  旧注销工具及REST保留, managed继续要求既有fenced release.

## Impact

增加pane-release模块, 扩展只读pane probes的TTY进程读取, 接入REST和MCP会话清理.  不新增第三方依赖, 不停止runtime或真实pane, 不自动激活共享daemon.
