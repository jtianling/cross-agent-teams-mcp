# AoE managed 启动契约 v1

日期: 2026-10-26.  状态: 工作区已实现, 静态代码审查通过, 尚未生产部署.  AoE 已报告隔离 daemon 与 Codex fake provider 联调通过, 不代表所有 runtime 的真实进程验收均完成.  

目标是通过 launcher 和 MCP 握手完成首次身份注册, 不依赖 agent 生成注册 prompt.  所有控制接口只接受本机 loopback, 沿用 daemon 的鉴权策略.  

身份由本机 device、team、name 确定.  identity_key 是管理方持久化的所有权凭据.  instance_id 是每次启动的新 UUID.  claim_id 由 daemon 分配, generation 由 daemon 单调递增.  generation 不能由客户端指定新值.  

## 控制请求

以下字段大小写固定.  JSON 对象拒绝未知字段.  protocol_version 固定为 1.  fence 是下列对象:

```json
{"claim_id":"<UUID>","instance_id":"<UUID>","generation":1}
```

`POST /api/managed/prepare` 首次请求:

```json
{
  "protocol_version": 1,
  "identity_key": "<稳定所有权凭据>",
  "name": "worker",
  "team": "project",
  "agent_type": "codex",
  "instance_id": "<本次启动 UUID>"
}
```

四接口成功响应共有字段如下, 所有字段均存在.  prepare 额外返回 mcp_token, 其余接口不返回该字段.  未绑定时 runtime 明确为 null.  

```json
{
  "ok": true,
  "protocol_version": 1,
  "fence": {"claim_id":"<UUID>","instance_id":"<UUID>","generation":1},
  "state": "prepared",
  "agent_id": null,
  "runtime": null,
  "mcp_token": "<本代 MCP 凭据, 仅 prepare 返回>"
}
```

首次 prepare 返回 prepared.  同实例同请求重试返回相同 fence/token, 状态可为已进入的 bound.  name/team/key/type 不一致必须冲突, 不采用隐式改名或覆盖.  已有非 managed 注册身份也不自动接管.  instance_id 一旦使用即保留墓碑, release 后重放旧 prepare 也不能复活它.  新建必须使用新 UUID.  

重启请求在上述字段之外传 `previous: <旧 fence>`, instance_id 改为新值.  服务端原子核对旧 fence 和 key 后递增 generation.  旧绑定从此不能作为新实例的就绪证据, 旧控制请求也不能回写.  相同重启请求重试必须返回同一新 fence.  AoE 应先持久化返回结果, 再停止旧进程和启动新进程.  

`POST /api/managed/bind` 请求:

```json
{
  "protocol_version": 1,
  "identity_key": "<稳定所有权凭据>",
  "fence": {"claim_id":"<UUID>","instance_id":"<UUID>","generation":1},
  "runtime": {"agent_type":"codex","thread_id":"<准确线程 UUID>","ws_url":"ws://127.0.0.1:8799"}
}
```

runtime 坐标必须来自对应实例的创建响应或握手, 不使用最近线程、cwd 或时间邻近推断.  bind 验证运行时后, 在原子提交中再次检查 fence 和坐标唯一性.  同 fence 同坐标幂等, 同 fence 不同坐标冲突.  bind 完成只表示 `bound`, 尚不表示 MCP 客户端已经可用.  

runtime 字段已冻结, 不接受额外字段:

- codex: thread_id 和 ws_url.  AoE 隔离实测采用 thread/start、thread/name/set 持久化、bind、pane resume 顺序, 不发模型 turn.  managed 启动跳过旧 pre-register-codex-pane, 不依赖 tmux pane 绑定.  探测采用短连接 thread/read, 不持有 thread 订阅.
- opencode: base_url 和明确 session_id.  禁止自动选择最近 session.
- kimi-code: base_url 和明确 session_id.  daemon 支持坐标协议; AoE 当前未确认 shared engine 的每会话 token 配置通路, 因此 launcher 应明确拒绝该组合, 不得只设置 pane 环境后声称就绪.
- claude-code: ui_pid 和 channel_session_id, 必须与 channel proxy 的实际订阅 owner 和存活 PID 相符.  可由下述 proxy 握手自动提供, AoE 无需猜测 channel ID.

`POST /api/managed/status` 传 protocol_version、identity_key、fence, 可传预期 runtime 以严格比较.  返回 `prepared`、`bound`、`ready` 或 `released`, 并返回当前 fence 和非敏感运行坐标.  旧 fence 返回错误, 不返回新实例 ready 来冒充旧实例就绪.  ready 要求本代运行时验证及 MCP 连接关联, Claude 还要求对应 channel 订阅存在.  不能以 online、last_seen 或进程存活代替.  

`POST /api/managed/release` 传 protocol_version、identity_key、fence.  原子释放本代注册和占位, 不停止任何进程或 pane.  同 fence release 可重复, 旧 fence 不能删除新实例.  不得使用现有无 fence 的 `DELETE /api/agents/:agent_id` 代替.  

bind 返回 bound.  status 可返回 ready.  release 返回 released, agent_id 和 runtime 均为 null.  重启后的 prepare 可以保留稳定 agent_id, 但 runtime 为 null, 不表示旧进程已停止.  AoE 的总体就绪必须结合自己持有的进程状态.  

## MCP 连接

prepare 返回的 mcp_token 只属于本代实例.  launcher 将其配置为会话独立的 `X-Xats-Managed-Token` HTTP header.  daemon 用当前 token 关联已绑定身份, 每次请求核对 fence, 重启或释放后旧连接不能继续以该身份操作.  token 不写日志, 不放共享 app-server 全局环境.  

业务 MCP URL 为 daemon 的 `/mcp`.  同一个 MCP session 禁止换 token 或从业务连接切换到 proxy 连接.  非 managed 客户端不能用已有运行坐标或 Kimi 握手绕过该保护.  

Claude launcher 给自己的进程树设置 `XATS_MANAGED_MCP_TOKEN`.  本仓 channel proxy 读取后发送 `X-Xats-Managed-Proxy-Token`, 继续以 proxy 身份登记和订阅.  daemon 从该 proxy 登记与实际订阅中提取 ui_pid/channel_session_id, 自动 bind 对应 claim.  proxy 会抑制原注册提示, 不通过 prompt 补注册.  Claude 的业务 MCP 必须另行配置普通 `X-Xats-Managed-Token`; 仅 proxy 连接成功不构成 ready.  

同代坐标不可更改.  若 Claude proxy 进程重建产生新的 channel_session_id, AoE 必须推进新 fence, 不允许新 proxy 绕过代次直接覆盖.  Codex 已加载线程的 token 轮换也需要卸载旧 MCP 配置并以新配置 resume; 仅调用 resume 改 config 不保证重建 MCP.  这些进程操作归 AoE 管理, daemon 不停止进程.  

MCP 可以先于 bind 建立, 但此时不能报告 ready.  bind 后必须能重新尝试关联, 不能把一次尚未绑定的结果永久缓存.  daemon 重启后 ready 需要重新取得连接证据.  

现有 register_agent、reconnect、runtime commit、删除及运行时改绑入口必须尊重 managed 所有权, 不能绕过 fence.  管理通道以外的调用不能夺取 managed 身份或修改它的运行坐标.  

## 错误与验收

错误格式为 `{"ok":false,"error":"<稳定错误码>","detail":"<脱敏具体原因>"}`.  参数无效返回 HTTP 400, 所有权或 fence 冲突返回 409, 不存在返回 404, 运行时验证失败返回 502.  第三方返回的具体失败原因必须保留到脱敏日志, 不能仅记录通用失败.  

必须验证首次并发抢占、幂等 prepare/bind、重启请求重放、旧 bind 的延迟返回、旧 release、同一 runtime 重复占用、daemon 重启、MCP 先于 bind 和非 managed 入口绕过.  运行中生产 session 不参与测试, 不启动 tmux 探针或运行全量测试.  

生产重启由 jt 安排.  隔离验收须显式使用临时 db、pid-file 和独立端口, 禁止 discovery 回落到生产 daemon.  `--port 0` 的准确端口从监听日志获取, 不依赖旧 CLI pid 文件中的端口值.  
