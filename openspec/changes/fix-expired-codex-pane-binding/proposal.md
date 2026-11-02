## Why

真实现场中 pane challenge 已送达, 但模型在预登记十分钟有效期结束后才回传.  身份注册成功掩盖了启动绑定失败, 启动器无法据此保存精确 thread, 后续恢复失去可靠依据.

## What Changes

- challenge 关联具体 pane, launch 和预登记截止时间, 到期后不得继续作为绑定授权.
- Codex 注册结果增加独立 launch_binding 状态, 明确过期, 无效或未完成绑定及安全重试提示, 保持身份注册结果和已有字段.
- 继续通过启动器重新预登记, 新 challenge 和既有 carrier/launch 校验重试, 不接受旧 challenge 推断当前启动.
- 补 delivered 后到期, 迟到注册, 更新启动及安全重试回归, 不操作生产 daemon 或业务 thread.

## Capabilities

### New Capabilities

- `codex-pane-challenge-lifecycle`: 有期限的启动 challenge, 明确绑定结果与安全重试.

### Modified Capabilities

无, 现有精确启动绑定验证保持不变.

## Impact

修改 nonce registry, seeding/recovery 的 challenge 签发和 Codex 注册结果, 补充本机启动器文档.  不放宽前台 carrier, launch UUID, 注册代次或事务校验.  不新增生产控制 API, 不重启服务.
