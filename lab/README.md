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
`__LAB_PORT__`; 启动 codex 前 `export CODEX_HOME=$LAB/codex-home` 与
`export CROSS_AGENT_TEAMS_MCP_TOKEN="$(cat $LAB/token)"`.  凭证按整文件复制
(`cp ~/.codex/auth.json $LAB/codex-home/`), 不读内容.

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
它们**, 于是所有"绑没绑对 pane"的断言都会因为候选集为空而通过 —— 而那个 socket
文件确实存在, 所以写错**不会报错**, 只会安静地把场景建到另一台 server 上.
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
