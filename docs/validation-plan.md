# 验证方案

## 验证目标

这套验证不是为了证明“模型很聪明”，而是为了证明下面这些安全不变量成立：

- 真实写请求不会绕过冻结 plan 直接进入写入
- 未批准 plan 永远写不出去
- 受保护写路径没有显式 read binding 时 fail closed
- ACK 后的状态漂移会被拦住
- 写入成功必须以回读结果为准
- 重复确认不会触发重复写入
- 普通 assistant final 不再被 `reply_dispatch` 吞掉，但 `blockReason` 必须清楚告诉模型写入尚未发生

## 分层验证策略

### L0. 静态校验

目的：先把契约和工程骨架固定住。

执行：

- `npm run typecheck`
- 检查核心对象模型是否都通过类型系统约束

通过标准：

- `ResolvedPatch`、`MutationPlan` 类型稳定
- `ProtectedMutationBinding`、`before_tool_call` guard、adapters、store 都有明确接口

### L1. 纯函数单元测试

目的：验证不依赖 OpenClaw 和外部系统的纯逻辑。

覆盖模块：

- `catalog`
- `protected-write-request`
- `snapshot-normalizer`
- `diff`
- `approval-principal`
- `text-plan-actions`
- `plan-store` 状态迁移规则

必测用例：

- 受保护 `exec` 写命令能被规范化为目标 `storeId` 和冻结 `payload`
- 匹配到 binding 时，`executionContext` 冻结 read/write/verify invocation
- 未匹配 binding 的受保护直接写工具 fail closed
- `beforeHash` 基于规范化快照计算，字段顺序变化不影响 hash
- plan 不能从终态回跳到活跃态
- 可以按 `approvalPrincipal` 过滤待确认 plan

### L2. 集成测试

目的：在不接真实工具的前提下，把完整工作流跑通。

测试夹具：

- fake `ReadAdapter`
- fake `WriteAdapter`
- fake `VerifyAdapter`
- 内存版或文件版 `MutationPlanStore`

必测用例：

1. 成功流
   - read 返回快照 A
   - 生成 plan 并 approve
   - execute 成功
   - verify 返回快照 B
   - 断言 plan 状态是 `succeeded`

2. 冲突流
   - 生成 plan 后把当前快照改掉
   - execute 时 `currentHash !== beforeHash`
   - 断言状态是 `conflict`
   - 断言 write adapter 没有被调用

3. 回读失败流
   - write adapter 返回成功
   - verify snapshot 不等于预期 after
   - 断言状态是 `failed`

4. 幂等流
   - 对同一个 `planId` 连续执行两次 approve / execute
   - 断言底层写入只发生一次

5. 过期流
   - 构造过期 plan
   - 断言不能 approve，也不能 execute

### L3. OpenClaw 接缝测试

目的：验证安全边界没有被框架接缝绕开。

重点：

- `api.on("before_dispatch", ...)` 能消费确认 / 取消文本
- `api.on("before_tool_call", ...)` 能阻断裸写入
- 插件不再注册 `reply_dispatch`
- 受保护直接写工具缺少 read binding 时 block
- unrelated `exec` 命令 allow，匹配 binding 的 `exec` 写命令 block
- 带 `approvedPlanId` 的请求只有在 payload 完全一致时才放行

必测用例：

- 没有 `approvedPlanId` 时直接 block
- 缺 matching binding / read binding 时 block
- `approvedPlanId` 不存在时 block
- plan 状态不是 `approved` 时 block
- `storeId` 不匹配时 block
- payload 少一个字段、多个字段、字段值不同，都必须 block
- payload 完全一致时 allow
- 文本确认在唯一待确认 plan 场景下可以不显式携带 `planId`
- 确认消息已直接发送后，同一 run 内模型重试同一受保护写工具不会重复发送确认消息
- `SAFE_MUTATION_APPROVAL_SENT` 的 blockReason 推荐普通 final 话术为“已生成变更确认单，点击确认后系统会自动执行。”

### L4. 手工干跑

目的：在聊天入口层面验证用户体验和状态流转。

建议顺序：

1. 触发一次受保护写请求
2. 查看系统回推的解释和 diff
3. 取消一次，确认取消后不能再执行
4. 重新触发并确认
5. 在确认前模拟外部配置被别人改掉
6. 再次确认，预期冲突失败

通过标准：

- 用户能看懂系统理解结果
- 用户能在确认前发现误解并取消
- 冲突失败的信息清晰，不会静默吞掉

## 真实适配器接入门槛

在下面条件之前，不接真实写工具：

- L0-L3 全绿
- 至少完成一次手工干跑
- guard 的 block / allow 结果都有日志
- 能证明重复确认不会重复写

## 验收清单

### 安全验收

- 任何裸写路径都能被 `before_tool_call` 拦住
- 每条受保护写路径都有显式 `protectedMutations` binding
- hook 不根据命令名猜读操作
- `allow-always` 不存在
- 执行器只接收 `planId`
- 写前 compare `beforeHash`
- 写后必须 verify

### 功能验收

- 单次受保护写请求能从拦截走到成功执行
- diff 展示包含 before / after
- 重复 ACK 幂等，不会重复写入
- plan 过期后不可执行

### 观测验收

- 每次变更都有 `planId`
- 有状态流转日志
- 有 write / verify 结果记录

## 推荐的第一轮命令

实现开始后，第一轮验证命令固定为：

```bash
npm run typecheck
npm test
```

如果这两个命令都不稳定，不要接真实适配器。
