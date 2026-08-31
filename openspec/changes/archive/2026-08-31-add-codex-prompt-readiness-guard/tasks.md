## 1. 形态标记 (已确定, 见 design D3)

- [x] 1.1 确认标记: composer 的 prompt 行, 即首个非空白字符为 `›` 的行。  已对生产在跑的 codex 0.151.0 二进制核对 (原始 UTF-8 字节存在), 并对较新源码核对渲染点 `bottom_pane/chat_composer.rs` 仍在渲染它
- [x] 1.2 否决 placeholder 文案方案: `Ask Codex to do anything` 在 0.151.0 中存在, 但较新 codex 已改为从 `PLACEHOLDERS` 8 条中随机取 (`chatwidget.rs:1981` + `chatwidget/constructor.rs:40`), 该文案不在其中 —— 按文案锁定等于给自己排定一个必然到期的失效日
- [x] 1.3 确认捕获范围足够, 并订正对它的理解: `capturePaneTail` 跑的是 `capture-pane -p -S -8`, 语义是"整个可见 pane + 8 行 scrollback", 不是"最后 8 行" (对生产 pane `%9` 实测: 高 51, 返回 59 行)。  composer 必定在范围内, 判据复用既有捕获, 不单独取行
- [x] 1.4 对生产在跑的 codex v0.151.0 只读采样两个 pane (`%9` / `%10`), 确认 composer prompt 行为行首无缩进、无边框的 `› Ask Codex to do anything` —— 排除"边框导致判据对所有 pane 判否"的风险
- [x] 1.5 判定假阳性的处理方式: codex 用同一 `›` 前缀渲染已提交的用户消息, 判据只问存在性、不问行位置; 否决"尾部 N 行内命中"的收窄 (理由见 design D3 末段)

## 2. 判据模块

- [x] 2.1 新增就绪形态判据模块, 导出一个纯函数 `(paneTail: string) => boolean`, 不做任何 I/O
- [x] 2.2 导出供 codex 侧调用方复用的判据实例与其 refusal reason 常量 (拟名 `prompt_not_ready`)
- [x] 2.3 单元测试: codex 空闲 composer 形态判是 (含 prompt 行前有缩进的情形), 阻塞式更新菜单形态判否, bash 模式 (`!` 前缀) 判否, 行内出现 `›` 但不在行首判否, 空串与仅空白判否

## 3. 接入注入原语

- [x] 3.1 `tmuxPokeImpl` (`src/mcp/poke.ts`) 增加可选参数 `requireReady?: (paneTail: string) => boolean`
- [x] 3.2 在 `capture_before` 取得 `pane_tail_before` 之后、`load_buffer` 之前求值; 判否直接返回 `prompt_not_ready` 且不加载 buffer、不粘贴、不发 Enter
- [x] 3.3 确认 `capture_before` 抛错/超时仍走既有 `classifyTmuxError` 路径, 天然不写入 (design D5)
- [x] 3.4 单元测试: 未传 `requireReady` 时逐阶段行为与改动前一致 (回归); 传入且判否时零 tmux 写入调用
- [x] 3.5 确认 `runQuietGuard` / `poke-guard.ts` 一字未改

## 4. 接入 codex-recovery

- [x] 4.1 `codex-recovery-poke.ts` 的 `sendAfterGuard` 在调 `tmuxPoke` 时传入判据
- [x] 4.2 把 `prompt_not_ready` 加为第三种 transient refusal: 归还 `resumeProbePolling`, 保持同一 generation token, 不进任何 backoff 阶梯
- [x] 4.3 扩展 `TransientReason` 与 `logTransientResume`, 使该 reason 独立于 `guard_failed` 打印, 并沿用"每条连续 streak 一行、通过后清零"的节流
- [x] 4.4 单元测试: 菜单形态下不粘贴且 generation 未退休; 连续判否只打一行; 判据通过后再判否会重新打印

## 5. 接入 codex-seeding

- [x] 5.1 `codex-seeding-poke.ts` 调 `tmuxPoke` 时传入同一判据
- [x] 5.2 把 `prompt_not_ready` 并入其既有 transient 分类 (与 `guard_failed` 并列, 复用同一归还路径)
- [x] 5.3 单元测试: 菜单形态下不粘贴, 且不消耗/不作废 seeding nonce

## 6. 验证

- [x] 6.1 `pnpm typecheck` 通过
- [x] 6.2 `pnpm test` 全绿 (tmux 全部 mock, 不起真实 tmux server)
- [x] 6.3 `openspec validate add-codex-prompt-readiness-guard --strict` 通过
- [x] 6.4 复核 diff: 每一行都能追溯到本变更, 未顺手改动相邻代码
