# MVP 细化

## 目标

第一版不是要把所有 20 个参数场景做完，而是先验证下面这条安全链路是闭合的：

`自然语言 -> IntentDraft -> ResolvedPatch -> MutationPlan 冻结 -> 文本 ACK -> 执行器 -> before_tool_call guard -> 写后回读`

只要这条链路对一个高风险字段族成立，后续扩字段就是重复工程，不再是架构赌博。

## 范围冻结

### 本仓库默认 MVP

- 只支持一个 mutation kind：`promotion.full_reduction_tiers`
- 一次 plan 只允许一个 `storeId`
- 一次 plan 只允许一个字段族变更
- 只支持文本入口：`/mutate`
- 只支持文本确认：`/mutate-approve <planId>`、`/mutate-cancel <planId>`
- 只支持单审批人
- 只支持同会话确认
- 只做 fake adapters 验证，不直接接真实写工具

### 明确排除

- 多字段联合写入
- 飞书 interactive card
- 微信 native card
- 多审批人会签
- 自动重试写入
- 模型确认后再次参与 payload 决策

## 关键技术决策

### 1. 模型边界

- 模型只产出 `IntentDraft`
- 模型不能产出最终 `writePayload`
- 模型不能在 ACK 后参与执行

### 2. 冻结边界

`MutationPlan` 是唯一可信对象，冻结后至少包含：

- `beforeSnapshot`
- `beforeHash`
- `resolvedPatch`
- `writePayload`
- `diffItems`
- `requestedBy`
- `channel`
- `sessionKey`
- `expiresAtMs`
- `idempotencyKey`

### 3. 执行边界

执行器只接受 `planId`，不接受自然语言，也不接受临时拼出来的 payload。

### 4. guard 边界

底层写入工具必须满足四个条件才允许放行：

- 存在 `approvedPlanId`
- plan 状态是 `approved`
- 当前 actor / session 与计划上下文一致
- 当前 tool params 与冻结 `writePayload` 完全一致

### 5. 并发边界

同一 `storeId` 在这些状态下视为占用：

- `pending_ack`
- `approved`
- `executing`

第一版直接拒绝同店第二个活跃 plan，不做合并。

### 6. 过期策略

第一版建议：

- plan TTL：15 分钟
- 超时状态：`expired`
- 过期 plan 不允许再确认或执行

## 目录与模块职责

### `src/intent-types.ts`

维护系统核心对象模型和状态枚举，避免实现先于契约。

### `src/catalog.ts`

维护 `ParameterCatalog`，作为模型和 resolver 的字段白名单。

### `src/field-resolvers/`

维护字段族解析器。第一版只实现一个 resolver，不并行铺开。

### `src/patch-resolver.ts`

只做确定性解析，不兜底猜字段。

### `src/plan-store.ts`

抽象计划存储接口，当前骨架不绑定具体实现。实现阶段优先考虑 SQLite；如果只是本地超快验证，可临时用文件存储，但要保证接口不变。

### `src/executor.ts`

封装批准后的执行状态机，唯一入口是 `planId`。

### `src/hooks/before-tool-call.ts`

只守门，不做业务理解。

### `src/adapters/`

隔离读、写、回读验证适配层，先 fake，后真实。

## 推荐落地顺序

1. 先把核心类型和接口补齐
2. 再做 fake adapter 驱动的成功流
3. 再补冲突流、幂等流、回读失败流
4. 最后才接 OpenClaw 命令与 `before_tool_call`

## 阶段完成定义

MVP 只有在下面条件同时满足时才算完成：

- 可以从自然语言生成冻结 plan
- 用户能看到 before/after diff 并确认
- 未批准 plan 无法写
- 批准后如状态漂移会冲突失败
- 写入成功后必须回读验证
- 重复确认不会重复写
