Codex 改名后的身份恢复

同一 Codex thread 重新注册为另一个 name/team 时, 当前 pane 的 identity key 应跟随最后一次成功绑定的注册身份.  目标名字对应的历史记录即使已有另一把旧 key, 也不能阻止本次迁移.

只有同一 thread 的运行位置继承已成功, 且 key 持有者与调用者的 thread 再次匹配时, 才允许替换调用者已有的 key.  普通绑定, thread 缺失或不匹配时继续保留既有保护.  迁移沿用现有事务, 保证清除原持有者和绑定新身份同时成功或同时回滚.

2026-09-29 核实日志: 2026-09-28T03:50:24.859Z 的 `seat-follow skip ... already holds a key; seat key not moved` 紧接同 thread 的 `outcome=inherit`, 说明恢复旧名字来自 key 未迁移, 不是 agent 再次自行命名.

项目经验: 恢复身份的名字可能复用历史记录, 不能把目标记录已有 key 当作当前 pane 已正确关联的证据.

回归覆盖已有历史 key 和无历史 key, 同 thread 与不匹配 thread, 改名并更换 team 后的恢复通知.  实时 tmux 会话期间不运行测试套件.  类型检查通过不代表 c/r 的运行验收通过.

加载修复后需要在原 Codex thread 中再次明确注册最终 name/team, 才会触发 key 迁移.  修复不会自动更改现有注册数据.  start-local-xats 会构建并重启 daemon 和 Codex app-server, 应在允许中断会话时执行.
