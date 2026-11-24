# 非目标 dead pane 导致 inventory 解析失败

2026-11-13, AoE报告当前10/11号删除失败.  本轮只读确认当前共享daemon PID36939, 9100端口, 本仓库dist入口, 已启用panes/release路由.  空targets schema请求返回400, 没有提交任何成员.  本地日志有多条target=0/1的tmux_response_invalid.  之前的未激活记录仅代表历史时点, 不能继续套用.

## 根因与修复

AoE使用显式socket只读取得原始六字段输出, 四个目标pane字段正常, 同一server另有四条非目标记录为pane_pid=0且TTY为空.  原parser把server PID与pane PID共用正整数schema, 且强制所有行TTY非空, 任意一条未运行pane使整个inventory失败.

仅将pane PID扩展为非负整数, PID=0视为未运行并允许TTY为空.  socket, server PID/启动代次和pane ID仍严格验证, 活PID仍必须有TTY, 负值或缺字段仍失败关闭.  dead目标在lookup和release中明确不可验证, 不执行process(0), 不当作already_unregistered.  活目标TTY去重只检查其他活pane, 保留dead行的server代次校验.  格式错误日志现在带字段名和原因, 不输出原始行或argv.

## 验证与版本定位

新增回归在修复前复现3个失败, 修复后14文件174项定向测试通过, tmux/ps宿主护栏零调用.  默认probe以自建Unix socket和假可执行文件覆盖alive+四条PID0/空TTY的原始格式, 活目标成功/死目标拒绝/不查pid0.  类型检查, 隔离ESM与声明构建, strict OpenSpec和独立干净上下文review通过.  未注销真实成员, 不清理无关pane, 未运行本机全量测试.

候选和证据: .e2e-test/runs/dead-pane-inventory-20261113/, 包含manifest.json, source-sha256.json, live-comparison.json, before/及各检查日志.  candidate/dist/cli.js是完整构建入口, 不按package版本号区分本轮未提交修复.

当前磁盘dist全部源码映射的129个本项目源文件已逐项比较, 候选相对它仅以下三个生产文件变化: src/pane-lookup/probes.ts, src/pane-lookup/service.ts, src/pane-release/carrier.ts.  没有额外引入其他工作区行为.  先前handoff与release实现已在当前磁盘dist中, 本轮不是再次加入它们.

## 备份和待确认切换

本轮受限备份位于 /Users/jtianling/.cross-agent-teams-mcp/backups/dead-pane-inventory-20261113T111858Z, previous-dist与candidate-dist保留完整构建, preflight.json记录每文件hash/当前PID/允许输出的启动参数.  data.db使用SQLite在线备份, integrity_check和临时隔离恢复及逐表计数核验通过, 数据库和元数据0600, 根目录0700.  没有读取或输出数据库内容及token.  备份后新增消息在数据库恢复时可能丢失, 本轮不授权生产数据库恢复.

若jt明确同意本轮daemon-only更新, 执行前重新核对PID/入口/两个dist hashes及Node可执行文件, 避免凭旧PID或版本号操作.  仅停止该xats daemon, 等9100释放后替换完整dist, 用原Node/数据库/host0.0.0.0/port9100/device jt/原本地token启动同一服务并按原格式更新PID文件.  原token文件已在脚本内核对与运行参数相同, 值不进入文档或消息.  不运行会连带重启app-server的start-xats, 不停止TUI, tmux或原生runtime.

重启会短暂断开所有现有xats MCP连接, 当前观察约32个已注册连接, 客户端需重连/重注册.  变更只涉及只读probe解析及失败关闭, 无数据库schema变化.  新实例健康及只读lookup检查失败时, 先停止新daemon再恢复本轮previous-dist和同一原启动配置.  不自动回滚数据库或恢复已由用户实际删除的成员.  待激活后只读复查四个目标lookup, 不需要真实release验收.

本轮尚未停止或更新共享daemon/dist.  激活确认由aoe-main统一向jt询问一次, xats侧不重复请求, 不把跨会话旧授权当作本轮重启同意.
