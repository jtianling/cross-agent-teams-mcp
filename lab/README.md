# xats codex 身份恢复实验室 — daemon 侧夹具

与生产完全隔绝的 daemon 环境, 用于脚本化复现 codex pane 认领 / 身份恢复问题.
联合规格见 `agent-of-empires/discuss/xats-codex-lab.md` (场景 S1-S5 与 aoe 侧
bootstrap 复刻形态以那份为准), 本目录只负责 **daemon 这一侧**: 隔离启停、MCP
调用入口、断言口径.

## 边界

| 维度 | 生产 | 实验室 |
| --- | --- | --- |
| daemon 数据目录 | `~/.cross-agent-teams-mcp/` | `$LAB/xats-home/` |
| 端口 | 9100 | 9199 |
| token | `xats` | `$LAB/token` (首次自动生成) |
| device | `jt` | `jtlab` |
| tmux socket | 共享 server | `$LAB/tmuxtmp/tmux-$(id -u)/default` (私有) |
| codex 配置 | `~/.codex/` | `$LAB/codex-home/` (`CODEX_HOME`) |

`$LAB` 默认 `~/.xats-lab`, 可用 `XATS_LAB_HOME` 覆盖.  `lab-env.sh` 里的
`lab_guard_isolation` 会在每个脚本启动时拒绝任何等于生产值的配置.

## 用法

```sh
lab/start-lab-daemon.sh --fresh --rebuild   # 全新库 + 重新构建 dist
lab/lab-facts.sh all                        # 看 daemon 侧事实
lab/stop-lab-daemon.sh
```

**src/ 改过之后复跑必须带 `--rebuild`**: 启动脚本默认只在 `dist/` 缺失时才构建,
不带这个标志复跑测的是**旧 dist**, 会得到"修复没生效"或"修复生效了"两种同样不可信
的结论.  搭配 `--fresh` 用全新库, 免得上一轮的行残留改变判据.

启动脚本会在 `/health` 通过之后, **再核对 pid 文件里的实际端口**: daemon 在
请求端口被占时会退到 port+1/port+2, 只看 `/health` 通不代表这个 daemon 占着
9199, 端口不符直接失败, 免得场景对着别的进程做断言.

注册动作 (替身快路径, 或需要精确控制时序时):

```sh
node lab/lab-mcp.mjs --hold register_agent '{"agent_type":"codex","name":"a","team":"lab","thread_id":"<uuid>"}'
```

`--hold` 会把 MCP 会话挂住不退.  daemon 是按 **MCP session** 认调用者身份的,
替身注册完就退出等于会话立刻断开, 与真实 codex (会话长驻) 的行为不一样 —
凡是涉及 takeover / unknown_session / poke 路由的场景都必须 `--hold`.

pre-register 用仓库 CLI, 实验室内一律显式带端口与 token (不走 pid 文件解析):

```sh
XATS_IDENTITY_KEY=<key> node dist/cli.js pre-register-codex-pane \
  --pane '%1' --agent-id <uuid> --identity-key-env XATS_IDENTITY_KEY \
  --ttl 600 --port 9199 --token "$(cat $LAB/token)"
```

key 只经环境变量, **决不落 argv** (`ps` 全机可见) — 实验室脚本必须守这条,
否则测出来的安全属性是假的.

## codex 侧

`codex-config.toml.template` 装到 `$LAB/codex-home/config.toml`, 替换
`__LAB_PORT__`; 启动 codex 前 `export CODEX_HOME=$LAB/codex-home`.  凭证按整文件
复制 (`cp ~/.codex/auth.json $LAB/codex-home/`), 不读内容.

**token 不要 export 在 codex 客户端这一侧** —— `--remote` 形态下 codex 的工具调用
在 **app-server 进程内**执行 (见下), 于是 `bearer_token_env_var` 这类 `*_env_var`
配置**全部解析在 app-server 的环境里**.  在客户端 pane 里 export 毫无作用, 而
app-server 会拿它启动时那个 shell 的 token —— 通常就是生产 token —— 去敲实验室
daemon, 现象是 codex 侧 `HTTP 401` 而实验室 daemon 侧毫无痕迹.
`start-lab-appserver.sh` 已在 app-server 环境里显式设好实验室 token.

### `--remote` 的工具在 app-server 进程内执行

2026-07-31 实测 (aoe 侧 tester, 实验室内): `--remote` pane 的工具 shell 祖先链是
`tool shell → vendor codex → codex app-server → launchd`, **该 pane 自己的进程一个
都不在链上**; 两个不同 pane 的工具调用父进程是**同一个** app-server; 而不带
`--remote` 的对照组工具是 pane 本地的, 一路上溯到建 pane 的 tmux.  另有正向对照:
pane 启动行上的唯一 marker 在该 pane 进程环境里确实存在, 在工具里读到 `<unset>`,
排除了"app-server 按会话注入 pane 环境"这个例外.

**已知与生产的差异**: `codex-config.toml.template` **没有设**
`[shell_environment_policy]`, 所以实验室跑的是 codex 默认继承策略, 而生产
`~/.codex/config.toml` 是 `inherit = "core"`.  上面那组测量因此只能证明"默认策略下
模型看得到 app-server 的环境", 不能直接推到生产.  凡是结论依赖"模型能/不能看到某个
环境变量"的场景, **必须在配置里显式写死该策略**并在报告里注明取值, 否则等于把一个
未受控变量当成了常量.

由此产生两条对实验室有直接后果的性质:

1. **模型看到的环境是 app-server 的环境**, 不是自己 pane 的.  所以
   `XATS_IDENTITY_KEY` 到不了模型 (pre-registration 通道正是为此存在), 所有
   `*_env_var` 配置也一样.
2. **模型读到的 `$TMUX_PANE` 是固定的错值** —— app-server 从启动它的那个 shell
   继承而来 (生产上是 `%39`).  这不是"值缺失"而是"值是错的且看起来很真":
   每个 caller 都会自信地报同一个错 pane.  实验室里若从 jt 的生产 pane 起
   app-server, 模型读到的就是生产 pane id —— `start-lab-appserver.sh` 因此用
   `env -u TMUX -u TMUX_PANE` 起进程.  **任何"让模型自报自己 pane"的断言在这里
   都是假的**, 座位归属只能由 daemon 侧探测证据决定.

## tmux 红线

`lab-env.sh` 提供 `lab_tmux` / `lab_tmux_kill_server`, 内部固定

```sh
env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$LAB/tmuxtmp" \
  tmux -S "$LAB/tmuxtmp/tmux-$(id -u)/default" ...
```

**只用这两个包装**, 不要裸调 tmux: 只设 `TMUX_TMPDIR` 不算隔离 (进程里 `$TMUX`
有值时客户端直连当前 server 并无视它), 而裸 `tmux kill-server` 会端掉 jt 全部
实时 session — 这条是被两次真实事故写出来的.

**socket 路径必须落在 `TMUX_TMPDIR` 解析得到的位置上, 不能自己另取一个**
(例如 `$LAB/tmux.sock`).  daemon 内部是**裸调 `tmux`** 的, 没有地方传 `-S`,
它只能靠 `TMUX_TMPDIR` 找 server; pane 若建在另一个 socket 上, daemon **看不见
它们** —— 而那个 socket 文件确实存在, 所以写错**不会报错**, 只会安静地把场景建到
另一台 server 上.

失效方式**取决于断言的方向**, 分清楚才知道哪些结论要作废:

- **反向 / 缺席类断言** (\"A 没抢到 B 的座位\"、\"没有匹配\") 会**真空通过** —— 候选集
  为空时它们天然成立, 这是真正的静默假绿;
- **正向绑定类断言** (\"绑到的 pane 等于本场景那个\"、\"`kill -0` 得通且 argv 含本
  pane 的 uuid\"、\"必须命中 `reason=pane_has_pending_prereg\"` 这类以 daemon **看见了**
  该 pane 为前提的 reason) 会**红**, 挡得住.

所以只有"全靠反向断言"的场景需要担心; 正反混合的场景 socket 走错会直接失败.
`-S` 传的是解析出来的同一个绝对路径, 目的只是让"只按绝对 socket 路径杀"这条
红线仍然成立.

## 断言口径 (daemon 侧)

`lab-facts.sh` 输出三类 **daemon 状态** 事实, 状态断言只应落在这三类上
(投递内容另有第 4 类, 见下):

1. **agents 行**: `identity_key` / `tmux_pane_id` / `runtime_ui_pid` /
   `runtime_tty` / `runtime_verification_mode` / `register_generation` /
   thread.  座位是否被抢、key 是否附对、绑定是否条件写成功, 都看这行.
2. **pre-reg 行**: `pane_id` / `xats_agent_id` / `identity_key` / `expires_at`.
   行还在 = 没被消费; 行没了 = 被消费 (或过期后被 GC 顺手清掉).
   **过期是惰性的**: ttl 到点行不会自动消失, 只是 `expires_at` 变成过去, 要等下一次
   触碰该 pane 的写路径才 GC.  所以断言"已过期"必须比时间
   (`julianday(expires_at) < julianday('now')`), **决不能按行数变 0** —— 那条永远
   不成立, 而且是静默永假.
3. **决策日志**: daemon 每条身份决策都有独立 reason, 断言认这些字符串:

| 日志片段 | 含义 |
| --- | --- |
| `same-thread decision ... outcome=none` | 无同 thread 证据, 允许进入 pre-reg 扫描 |
| `outcome=inherit` / `inherit_fail_closed` | 同 thread 证据命中座位并继承 / 继承失败已 fail-closed |
| `outcome=ambiguous` | 多个不同物理座位, fail-closed |
| `outcome=cas_drift` | 探测窗口内行被并发注册改写, fail-closed |
| `cas drift runtime clear (debug)` | drift 后残留座位已按代条件清空 |
| `auto-bind skip (debug) ... reason=identity_key_contradiction` | 行的 key 与 caller 已持 key 矛盾, 整行不作候选 |
| `auto-bind skip (debug) ... reason=identity_key_live_holder_conflict` | 行的 key **归属另一在线身份** (holder 有正数 pid 且探测在运行), 整行不作候选 |
| `auto-bind skip (debug) ... reason=identity_key_holder_liveness_unknown` | 行的 key 归属另一身份但 **holder 没有正数 pid, 存活性未知** (tty/pane 绑定本就不记 pid); 未知不等于已死, 同样不作候选 |
| `auto-bind skip (debug) ... reason=pane_has_pending_prereg` | detect fallback 拒绝绑定仍挂未过期 pre-reg 行的 pane |
| `auto-bind skip (debug) ... stage=post_verify` | 异步验证之后、提交事务之内重新仲裁, 发现行是别人的 → 整个事务回滚, **绑定根本没落地** (不是事后撤销), 未消费未附 key |
| `auto-bind commit rolled back: ... error=...` | 提交事务内抛错 → 全部回滚: 无 runtime 写、无在位 pane 驱逐、行未消费、key 未附; 错误信息已 redact key 值 |
| `auto-bind commit rolled back: ... error=identity_key attach refused: reason=...` | 同上, 但触发者是**附 key 阶段的拒绝** (`caller_row_missing` / `caller_holds_different_key` / `identity_key_live_holder_conflict`).  拒绝一律抛错回滚 —— 若在这里 return, 提交的会是最坏状态: 在位 pane 已被驱逐、恢复行已消费、key 却没附上, 而那行是这把 key 的唯一载体 |
| `auto-bind stale runtime bind` | bind 期间行被覆盖, 未消费新行 |
| `runtime bind stale (debug) ... reason=stale_registration_bind` | 迟到的 bind 被 generation 条件写挡下 |
| `seat-follow ...` | 改名跟随的迁移 / 跳过 / 冲突 |
| `codex-recovery ...` | 恢复 poke 的调度 / 探测 / 发送 / 取消 (带 ISO 时间戳, 供 S4 分段计时).  **连字符**, 代码里就是 `codex-recovery`; 写成空格会静默漏掉全部恢复日志 |

4. **投递内容 (仅投递类场景)**: `lab_tmux capture-pane -pJ -t <pane>` 抓到的
   pane 文字.  日志只证明 daemon 把 holder 解析对了, **话术里写的是谁**只有
   pane 内容能证 —— 那是重启后的 codex 真正读到的东西, 从"代码用同一个 holder
   拼话术"推出来的不算观察.  必须带 `-J` 合并折行: 恢复话术是一条约 350 字符的
   长行, 窄 pane 下 `name="x"` 会被折断, 不带 `-J` 会产生偶发假 FAIL.

### 真实 codex 必须带 `--remote` 才会被认领

daemon 识别 codex 载体的判据里**硬性要求 argv 含 `--remote`**
(`isCodexRemoteProcess`): 它认的是 aoe 托管的 `codex --remote <app-server>` 形态.
实验室里若按"不用 --remote 直接跑 codex CLI"起真身, 进程对 daemon **完全不可见** —
现象是注册成功、key 也附上了, 但 `pane=- ui_pid=- tty=-`, pre-reg 行残留, 日志只有
`reason=no_match matches=0`.  这不是 daemon 缺陷 (设计上只认托管形态), 但真身跑必须
照生产形态起: `codex --remote ws://127.0.0.1:$LAB_APPSERVER_PORT ... -c
"xats.agent_id=\"<uuid>\""`, 配合 `lab/start-lab-appserver.sh`.  替身形态照抄了生产
argv, 所以替身一直匹配得上 —— 这条差异只有真身跑才暴露得出来.

**S1 (抢占) 的验收判据**: A 注册后日志出现三个 identity-key 拒绝 reason 之一
(`identity_key_contradiction` / `identity_key_live_holder_conflict` /
`identity_key_holder_liveness_unknown` — 具体哪一个取决于 caller 是否持 key、
holder 是否在线、holder 有无正数 pid),
B 的 pre-reg 行**仍在**且 key 不变, A 的 agents 行**没有** B 的 pane/pid;
随后 B 注册拿到自己的 key 并绑自己的 pane.  这正是 2026-07-31 生产事故的
最小复现.
