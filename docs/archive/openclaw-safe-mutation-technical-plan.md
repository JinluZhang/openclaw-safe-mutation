# OpenClaw 安全写入工作流技术方案

## 文档目的

这份文档用于承接下一次新 session 的编码与验证工作，目标是为“高风险业务写入”设计一套在 OpenClaw 上可实现、可验证、可演进的技术方案。

本方案解决的问题是：

- 底层写接口有 20 个参数
- 用户实际往往只想改其中 1 到 2 个字段
- 用户输入通常是自然语言，不是结构化参数
- 希望借助大模型理解“用户到底想改哪个字段、改成什么”
- 但不希望大模型直接参与最终写入参数构造和写入执行
- 希望整个关键写入过程具备强确认、强校验、强审计和尽可能接近原子性的工程保证

本文保留了前面讨论中的关键信息，并补充为可直接实施的架构和开发计划。

---

## 一句话结论

最终推荐方案是：

**自然语言输入 + 大模型意图编译 + 确定性字段解析与 payload 冻结 + GUI / 文本 ACK + 写前并发校验 + 纯代码执行写入 + 写后回读验证 + `before_tool_call` 作为最终硬闸门。**

核心原则：

- 大模型可以参与“理解用户想改什么”
- 大模型不能直接生成最终 20 参数写入 payload
- 大模型不能在确认后参与最终写入执行
- 原始写工具必须始终被 hook 保护，不能绕过已批准 plan 直接写

---

## 背景与约束

### 业务背景

- 写接口参数很多，且绝大部分字段在单次变更中不会变
- 用户通常只描述局部业务意图，例如：
  - “把满减从 25-15 改成 20-15”
  - “把营业时间改成 10 点到 22 点”
  - “活动名称不动，只把优惠门槛调低”
- 用户不知道真实参数名，也不应该被要求理解 20 个参数的底层结构

### 必须满足的目标

- 用户可以继续使用自然语言表达修改意图
- 系统能展示修改前后 diff
- 用户必须 ACK 确认
- 最终写入参数必须完全可控、可重放、可审计
- 对于冲突、歧义、写入失败、外部状态漂移，要 fail closed

### 非目标

- 不追求数据库层面的 ACID 事务
- 不要求所有渠道第一版都支持 native GUI 卡片确认
- 不要求大模型零误解；要求的是“误解不能直接进入写入”

---

## OpenClaw 相关事实与结论

### 1. `Internal Hooks` 不适合作为关键写入主机制

`Internal Hooks` 是进程内事件总线，handler 报错只记录日志并继续执行，属于 fail-open 语义，不适合作为关键写入保护。

参考：

- `src/hooks/internal-hooks.ts:286-305`

结论：

- 不要把“关键写入拦截与审批”建立在 `registerHook(...)` / internal hooks 上

### 2. `before_tool_call` 适合作为最终写入硬闸门

Typed Plugin Hook 中的 `before_tool_call` 可以：

- 阻断工具调用
- 要求审批
- 修改即将传给工具的参数

参考：

- `src/plugins/hook-types.ts:310-322`
- `src/agents/pi-tools.before-tool-call.ts:220-357`

同时，全局 hook runner 对 `before_tool_call` 使用 fail-closed：

- `src/plugins/hook-runner-global.ts:42-45`

结论：

- 最终写工具必须由 `api.on("before_tool_call", ...)` 守住

### 3. OpenClaw 支持插件自定义命令

业务插件可以通过 `api.registerCommand(...)` 注册命令型入口，不必把自然语言请求先交给通用 agent。

参考：

- `docs/plugins/building-plugins.md:165-168`
- `src/plugin-sdk/plugin-entry.ts:149-205`

结论：

- 推荐用插件命令承接业务入口，例如 `/mutate`、`/promo-edit`、`/promo-approve`

### 4. OpenClaw 已有 plugin approval 能力，但不适合作为主 diff 展示面

OpenClaw 已经支持：

- `plugin.approval.request`
- `plugin.approval.waitDecision`
- `plugin.approval.resolve`

参考：

- `src/gateway/server-methods/plugin-approval.ts:43-130`

但 plugin approval payload 主要是短文本审批提示：

- `src/infra/plugin-approvals.ts:3-16`
- `src/infra/plugin-approvals.ts:33-36`

限制：

- `description` 长度上限 256
- 默认 shared approval UX 更适合“是否允许继续”，不适合展示完整业务 diff

结论：

- **不建议**把 OpenClaw 默认 plugin approval 作为本业务的主确认 UI
- 可以把它作为通用审批机制备用，但主流程应使用自定义 `MutationPlan` + 自定义 diff 展示

### 5. 飞书更适合作为第一优先级确认 UI

飞书具备 interactive card 能力：

- `docs/channels/feishu.md:236-249`

Feishu channel 支持发送自定义 card：

- `extensions/feishu/src/channel.ts:657-699`

仓库里已有“确认卡 -> 点击按钮 -> synthetic command”的现成模式：

- `extensions/feishu/src/card-ux-approval.ts:8-65`
- `extensions/feishu/src/card-action.ts:331-405`

结论：

- GUI 卡片确认建议飞书优先

### 6. 微信能力要保守评估

WeChat 当前是外部插件，不在本仓库内：

- `docs/channels/wechat.md:12-45`

本仓库内没有看到与飞书同等级别的 native card / approval / interaction 公开接缝说明。

结论：

- 第一版不要把微信 native card 作为硬前提
- 微信入口可以保留，但确认可先走文本命令或飞书审批

---

## 总体架构

系统拆成 8 层：

1. **业务入口层**
2. **意图编译层（LLM 参与）**
3. **字段解析层（纯代码）**
4. **计划冻结层（纯代码）**
5. **确认展示层**
6. **执行层（纯代码）**
7. **最终写入保护层（hook）**
8. **审计与观测层**

关键分界线：

- 在 **意图编译层之前**，允许自然语言和模型参与
- 从 **计划冻结层开始**，模型彻底退出

---

## 核心设计原则

### 原则 1：大模型只做意图编译，不做最终写入

大模型可以负责：

- 识别用户想改哪个业务字段
- 理解“从什么改到什么”
- 识别潜在歧义
- 产出受控结构 `IntentDraft`

大模型不能负责：

- 构造最终 20 参数写入 payload
- 决定未提及字段的新值
- 直接调用写 CLI
- 在用户 ACK 后继续决定写入行为

### 原则 2：最终写入 payload 必须来自“当前快照 + 确定性 patch”

最终 payload 必须通过纯代码生成：

- 先读当前完整配置
- 再把用户明确想改的字段 merge 进去
- 其余字段保持当前值不变

### 原则 3：ACK 确认的是“系统理解结果 + 最终 diff”

用户必须看到：

- 原始请求
- 系统理解结果
- 修改字段
- 修改前后 diff
- 未修改字段保持不变的声明

### 原则 4：原始写工具永远不能直接暴露

无论是模型、命令还是内部服务，都不应直接裸调底层 20 参数写工具。

必须通过：

- plan
- approvedPlanId
- hook 检查

### 原则 5：写前必须重新确认当前状态未漂移

在用户 ACK 与真正写入之间，外部状态可能已变。

因此执行前必须：

- 重新读取当前配置
- 校验快照 hash / version
- 不一致则 fail closed

---

## 关键对象模型

### 1. `ParameterCatalog`

这是受控参数目录，是整个系统抵御幻觉的第一道结构化边界。

```ts
type ParameterCatalogItem = {
  fieldId: string;
  labels: string[];
  aliases: string[];
  description: string;
  valueType:
    | "string"
    | "boolean"
    | "integer"
    | "decimal"
    | "time-range"
    | "tier-list"
    | "enum"
    | "json";
  apiPath: string;
  requiredInWritePayload: boolean;
  supportsOperations: Array<
    "set" | "replace_item" | "add_item" | "remove_item" | "enable" | "disable"
  >;
};
```

要求：

- 模型只能从 `fieldId` 列表里选字段
- 模型不能自由输出 API path
- 字段目录是纯代码维护的 source of truth

### 2. `IntentDraft`

这是大模型输出的受控中间态，不可信，只能进入下一步解析。

```ts
type IntentDraft = {
  kind: "mutation.intent.draft";
  userText: string;
  targetStoreId?: string;
  candidateChanges: Array<{
    candidateFieldIds: string[];
    operation:
      | "set"
      | "replace_item"
      | "add_item"
      | "remove_item"
      | "enable"
      | "disable";
    from?: unknown;
    to?: unknown;
    value?: unknown;
    confidence: number;
    rationale?: string;
  }>;
  unresolvedAmbiguities: string[];
};
```

要求：

- 不允许直接包含最终 payload
- 不允许包含未在目录中的字段 id
- 允许低置信度和歧义，但歧义必须显式输出

### 3. `ResolvedPatch`

这是纯代码解析后的确定性 patch。

```ts
type ResolvedPatch = {
  kind: "mutation.resolved.patch";
  storeId: string;
  fieldChanges: Array<{
    fieldId: string;
    operation:
      | "set"
      | "replace_item"
      | "add_item"
      | "remove_item"
      | "enable"
      | "disable";
    normalizedInput: unknown;
  }>;
};
```

如果无法确定，不能生成 `ResolvedPatch`，而应进入歧义处理。

### 4. `MutationPlan`

这是系统真正可信的冻结对象。

```ts
type MutationPlanStatus =
  | "draft"
  | "pending_ack"
  | "approved"
  | "executing"
  | "succeeded"
  | "failed"
  | "conflict"
  | "cancelled"
  | "expired";

type MutationPlan = {
  planId: string;
  mutationKind: string;
  status: MutationPlanStatus;

  storeId: string;
  userText: string;
  interpretationText: string;

  beforeSnapshot: Record<string, unknown>;
  beforeHash: string;

  resolvedPatch: ResolvedPatch;
  writePayload: Record<string, unknown>;

  diffItems: Array<{
    fieldId: string;
    label: string;
    before: unknown;
    after: unknown;
  }>;

  requestedBy: string;
  approvedBy?: string;
  sessionKey?: string;
  channel?: string;

  createdAtMs: number;
  expiresAtMs: number;
  approvedAtMs?: number;
  executedAtMs?: number;
  finishedAtMs?: number;

  idempotencyKey: string;

  result?: {
    writeSucceeded?: boolean;
    verifySucceeded?: boolean;
    writeStdout?: string;
    writeStderr?: string;
    verifySnapshot?: Record<string, unknown>;
    error?: string;
  };
};
```

要求：

- 一旦 `writePayload` 冻结，后续任何步骤都不能让模型修改它
- 执行器只接受 `planId`，不接受自然语言

---

## 自然语言到写入的完整流程

## 阶段 A：自然语言入口

推荐入口形式有两种：

### 方案 A1：插件命令入口

示例：

- `/mutate store=123 把满减从25-15改成20-15`
- `/promo-edit store=123 把营业时间改成10点到22点`

优点：

- 明确进入“业务写入工作流”
- 不与通用 agent 对话混淆
- 便于权限和审计

### 方案 A2：飞书卡片或表单入口

让用户通过卡片提交自然语言修改说明，或更半结构化的输入。

优点：

- 用户体验更好
- 适合高频运营操作

### 不推荐

- 直接在任意普通聊天消息中让通用 agent 决定是否触发写入

原因：

- 风险面更大
- 更难限制模型乱用工具

---

## 阶段 B：意图编译（模型参与）

### 输入

- 用户原话
- 业务上下文
- `ParameterCatalog`
- 可选的当前状态摘要

### 输出

- `IntentDraft`

### 模型提示的硬约束

必须写进 prompt 或 schema 约束中：

- 只能从给定 `fieldId` 列表中选择候选字段
- 不能输出写接口原始参数路径
- 不能补全未提及的字段
- 如果存在多个可能字段，必须写进 `unresolvedAmbiguities`
- 如果不确定具体值含义，也必须写进 `unresolvedAmbiguities`

### 典型例子

用户输入：

`把满减从 25-15 改成 20-15`

模型输出：

```json
{
  "kind": "mutation.intent.draft",
  "userText": "把满减从 25-15 改成 20-15",
  "targetStoreId": "123",
  "candidateChanges": [
    {
      "candidateFieldIds": ["full_reduction_tiers"],
      "operation": "replace_item",
      "from": "25-15",
      "to": "20-15",
      "confidence": 0.95,
      "rationale": "用户显式提到满减档位"
    }
  ],
  "unresolvedAmbiguities": []
}
```

### 歧义例子

用户输入：

`把活动力度调低一点`

模型输出可能是：

```json
{
  "candidateChanges": [
    {
      "candidateFieldIds": [
        "full_reduction_tiers",
        "discount_rate",
        "subsidy_cap"
      ],
      "operation": "set",
      "confidence": 0.41
    }
  ],
  "unresolvedAmbiguities": [
    "无法确定用户想改的是满减档位、折扣率还是补贴上限"
  ]
}
```

这时必须进入澄清，不得直接生成 plan。

---

## 阶段 C：字段解析与确定性 patch 生成（纯代码）

这一层的职责是把不可信的 `IntentDraft` 变成可信的 `ResolvedPatch`。

### 纯代码校验逻辑

必须检查：

- `candidateFieldIds` 是否都在目录内
- 是否存在唯一高置信候选字段
- 值类型是否合法
- 对复杂字段是否存在唯一变更目标
- 是否涉及不允许的字段组合

### 对复杂字段使用 `FieldResolver`

对于如“满减档位”这类复杂字段，不应直接把模型输出当成最终值，应使用字段级解析器：

```ts
type FieldResolver = {
  fieldId: string;
  resolve(params: {
    currentValue: unknown;
    change: {
      operation: string;
      from?: unknown;
      to?: unknown;
      value?: unknown;
    };
  }):
    | { ok: true; normalizedChange: unknown }
    | { ok: false; reason: string; needsClarification: boolean };
};
```

示例：

- `full_reduction_tiers`
  - 支持 `replace_item`
  - 在当前 tiers 中查找唯一 `25-15`
  - 生成替换后的新 tiers
- `business_hours`
  - 解析时间区间
- `discount_rate`
  - 解析百分比或小数

### 如果任何一步不确定

返回：

- `needs_clarification`
- 或 `ambiguous`

绝不生成 `ResolvedPatch`

---

## 阶段 D：冻结 `MutationPlan`（纯代码，进入安全原子区）

一旦有了 `ResolvedPatch`，就进入可信区。

### 步骤

1. 调读 CLI 获取当前完整配置
2. 规范化当前快照
3. 计算 `beforeHash`
4. 将 `ResolvedPatch` merge 到当前快照
5. 生成完整 `writePayload`
6. 生成 diff
7. 生成 `interpretationText`
8. 持久化 `MutationPlan(status=pending_ack)`

### 重要约束

- `writePayload` 一旦生成后，后续任何路径都只读，不允许模型或用户继续修改
- 同店铺同类变更不应允许无限并发 plan

---

## 阶段 E：确认展示

## 用户必须看到什么

确认面必须展示：

- 原始请求
- 系统理解
- 门店
- 将修改的字段
- 修改前 -> 修改后
- 其余字段保持当前值

### 推荐文案结构

- 原始请求：`把满减从 25-15 改成 20-15`
- 系统理解：`修改字段「满减档位(full_reduction_tiers)」`
- 门店：`123`
- 变更：
  - `25-15 -> 20-15`
- 说明：`其余 19 个参数保持当前值不变`

### 确认按钮建议

- `确认修改`
- `取消`
- `重新读取当前值`
- `查看完整 payload 摘要`

### 关键结论

ACK 确认的对象不是“继续执行”这件抽象动作，而是：

**“我确认系统对我意图的理解是正确的，且我确认最终 diff 是正确的。”**

---

## 阶段 F：执行（纯代码）

点击确认后，绝不能回到模型对话继续推进。

必须进入一个确定性执行器，例如：

- `/mutate-approve <planId>`
- 内部 RPC：`executeMutationPlan(planId)`

### 执行步骤

1. 加载 `MutationPlan`
2. 检查状态必须为 `approved`
3. 检查未过期
4. 再次调用读 CLI
5. 重新规范化并计算当前 hash
6. 比较当前 hash 与 `beforeHash`
7. 若不一致，标记 `conflict` 并终止
8. 若一致，进入 `executing`
9. 调用写 CLI，传入冻结好的 `writePayload`
10. 写完立刻再次读 CLI
11. 验证回读结果是否等于预期 after
12. 成功则 `succeeded`，失败则 `failed`

### 写后验证

必须做回读验证，不能只信：

- 进程 exit code
- CLI stdout
- 接口返回 `ok=true`

真正的成功标准是：

**回读状态等于 plan 的预期 after。**

---

## 阶段 G：最终硬闸门（`before_tool_call`）

这层的目标不是理解业务，而是确保任何直接写入都写不出去。

### Hook 位置

在业务插件中注册：

```ts
api.on("before_tool_call", ...)
```

### 拦截策略

如果命中的工具是“底层写工具”，例如：

- `merchant_write_config`
- `mock-full-reduction-config`

则执行以下策略：

#### 情况 1：没有 `approvedPlanId`

直接 `block`

返回理由：

- `This write path requires an approved mutation plan`

#### 情况 2：有 `approvedPlanId`

检查：

- plan 是否存在
- plan 是否 `approved`
- 是否未过期
- plan 的 `storeId` 与当前请求是否匹配
- 当前 actor / session 与审批上下文是否匹配
- 当前 tool params 是否与 plan 冻结的 `writePayload` 完全一致

若全部通过：

- 放行

否则：

- `block`

### 不建议把主 ACK 流程建立在 `requireApproval`

原因：

- 业务 diff 需要 rich UI
- plugin approval `description` 太短
- 默认 shared approval 还包含 `allow-always`

因此建议：

- 主审批状态机使用自定义 `MutationPlan`
- `before_tool_call` 负责强制检查 `approvedPlanId`
- 对于裸写入尝试，直接阻断，不走通用 plugin approval

---

## 关于 `allow-always` 的明确决策

对于这类高风险业务写入，不建议允许：

- `allow-always`

原因：

- 用户确认的是一次具体 diff
- 不存在“后续同类写入都自动信任”的合理安全语义

因此本方案的业务 ACK 只允许：

- `confirm`
- `cancel`

如果后续要接入 OpenClaw 通用 approval renderer，也必须把允许动作裁剪为：

- `allow-once`
- `deny`

不能暴露 `allow-always`

---

## 推荐的实现形态

## 推荐主方案：自定义 `MutationPlan` 工作流 + hook 守底层写入

这是推荐的主实现。

优点：

- diff 展示完全可控
- 状态机可控
- 不受 plugin approval 短文本限制
- 可以自然支持复杂业务校验
- 可以严格禁止 `allow-always`

### 实现组成

- 自定义命令：
  - `/mutate ...`
  - `/mutate-approve <planId>`
  - `/mutate-cancel <planId>`
  - `/mutate-status <planId>`
- 自定义 plan store
- 自定义 diff renderer
- 自定义 executor
- `before_tool_call` 硬闸门

## 备选方案：主流程接入 plugin approval

仅当你明确希望复用 OpenClaw 的统一审批分发机制时再考虑。

缺点：

- diff 展示面受限
- 审批文案长度受限
- 更适合“是否继续执行”，不适合“完整业务变更确认”

结论：

- 仅作为 Phase 2 或补充能力，不作为主方案

---

## 渠道设计

## 飞书

### MVP

优先实现：

- 文本/markdown diff 展示
- 文本命令确认：`/mutate-approve <planId>`

原因：

- 能最快完成端到端编码与验证
- 不依赖跨插件私有能力

### Phase 2

实现 native interactive card：

- diff card
- Confirm / Cancel button

### 重要边界风险

虽然飞书插件内部已有 card action 能力，但**业务插件不能直接 import `extensions/feishu/src/*` 私有实现**。

原因：

- 违反插件边界
- 未来不可维护

如果要实现飞书 native card 按钮确认，推荐二选一：

1. 给飞书插件增加公开 seam
2. 在飞书插件自身实现一个通用“业务确认卡命令封装”能力，再由业务插件调用公开接口

不要在业务插件里直接 deep-import：

- `extensions/feishu/src/card-interaction.js`
- `extensions/feishu/src/card-ux-approval.ts`
- 其他 `extensions/feishu/src/**`

相关边界参考：

- `docs/plugins/sdk-channel-plugins.md:67-101`

## 微信

### 第一版策略

- 允许微信作为请求发起面
- 确认走文本命令或转飞书审批

### 原因

- `openclaw-weixin` 是外部插件
- 当前本仓库没有看到成熟的 native card / approval capability 公共接缝

### 第二版策略

若后续掌握微信插件代码，可再补：

- native card
- structured callback
- channel approval capability

---

## 插件与模块划分建议

建议新建一个非 channel 业务插件，例如：

- `extensions/safe-mutation/`

仅为示意，具体 id 可根据业务命名调整。

### 文件结构建议

```text
extensions/safe-mutation/
  index.ts
  openclaw.plugin.json
  package.json

  src/
    catalog.ts
    intent-types.ts
    intent-compiler.ts
    field-resolvers/
      index.ts
      full-reduction-tiers.ts
      business-hours.ts
      discount-rate.ts
    patch-resolver.ts
    snapshot-normalizer.ts
    diff.ts
    plan-store.ts
    plan-locks.ts
    executor.ts
    tools.ts
    commands/
      mutate.ts
      mutate-approve.ts
      mutate-cancel.ts
      mutate-status.ts
    hooks/
      before-tool-call.ts
    channels/
      feishu-render.ts
      text-render.ts
    adapters/
      read-cli.ts
      write-cli.ts
      verify-cli.ts
    audit.ts
    errors.ts

  src/**/*.test.ts
```

### 模块职责

- `catalog.ts`
  - 参数目录与字段元数据
- `intent-compiler.ts`
  - 调模型，将自然语言编译为 `IntentDraft`
- `patch-resolver.ts`
  - 确定性解析 `IntentDraft` -> `ResolvedPatch`
- `plan-store.ts`
  - 计划持久化
- `executor.ts`
  - 执行批准后的 plan
- `hooks/before-tool-call.ts`
  - 保护底层写工具
- `adapters/*`
  - CLI 交互隔离层

---

## 对 CLI 的适配设计

建议不要让业务逻辑直接拼 shell 命令。

应封装成 adapter：

```ts
type ReadAdapter = {
  readCurrentConfig(storeId: string): Promise<Record<string, unknown>>;
};

type WriteAdapter = {
  writeConfig(params: { storeId: string; payload: Record<string, unknown> }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
};

type VerifyAdapter = {
  verifyCurrentConfig(storeId: string): Promise<Record<string, unknown>>;
};
```

这样好处：

- 单元测试容易 mock
- CLI 改成 HTTP 接口时迁移容易
- hook 检查可以稳定对接统一 payload

---

## 状态存储与幂等性

## 存储建议

推荐：

- 使用 SQLite 作为 `MutationPlan` 持久化层

原因：

- 状态机清晰
- 方便唯一约束
- 方便 TTL 清理
- 崩溃恢复更稳

如果下一 session 为了快速交付，也可以先用：

- JSON 文件 + 原子写 + 单进程锁

但这只建议作为 MVP。

## 幂等性要求

每个 plan 必须有：

- `planId`
- `idempotencyKey`

执行器对同一个 `planId`：

- 重复点击确认不应重复写
- 已成功 plan 重放只应返回已有结果

---

## 并发控制

### 同店铺并发

同一 `storeId` 在如下状态下应视为占用：

- `pending_ack`
- `approved`
- `executing`

当新请求进入时：

- 若已有活跃 plan，可拒绝、合并或提示用户处理旧 plan

### 执行锁

执行 plan 时需要：

- per-store mutex
- 或持久层唯一活跃约束

### 状态漂移检测

执行前必须 compare：

- `currentHash === beforeHash`

不一致：

- `status = conflict`

---

## 失败模式与处理策略

### 1. 模型误解字段

处理：

- 不允许直接写
- 用户在确认卡上看到“系统理解结果”
- 用户可取消

### 2. 字段解析歧义

处理：

- 不生成 plan
- 返回澄清问题或选择卡片

### 3. ACK 后状态已漂移

处理：

- `conflict`
- 终止写入
- 提示重新读取并重新确认

### 4. 写 CLI 成功但回读不一致

处理：

- `failed`
- 标记需要人工复核
- 保留写入 stdout/stderr 与回读快照

### 5. 卡片重复点击

处理：

- 幂等化
- 第二次点击返回“该 plan 已处理”

### 6. plan 超时

处理：

- 自动 `expired`
- 不能继续执行

---

## 审计与观测

每次变更至少记录：

- `planId`
- `storeId`
- 原始请求
- 模型解释结果
- 审批人
- 审批时间
- beforeHash
- diff 摘要
- 写入执行结果
- 写后回读结果

建议输出：

- 结构化日志
- plan 状态流转日志
- 关键失败告警

---

## 测试与验证计划

## 1. 单元测试

覆盖以下模块：

- `catalog`
- `field resolvers`
- `patch-resolver`
- `snapshot-normalizer`
- `diff`
- `plan-store`
- `executor`
- `before_tool_call` guard

关键 case：

- 满减档位唯一替换成功
- 满减档位匹配多个候选时报歧义
- 未知字段被拒绝
- 未批准 plan 被 hook 拦截
- 已批准 plan 且 payload 一致时允许放行
- payload 与冻结 plan 不一致时拒绝

## 2. 集成测试

使用 fake read/write adapters：

- read 返回快照 A
- 生成 plan
- approve
- execute
- verify 返回快照 B

验证：

- 成功流
- 冲突流
- 回读失败流
- 幂等重复确认流

## 3. OpenClaw 接缝测试

重点覆盖：

- `api.registerCommand(...)` 的业务命令入口
- `api.on("before_tool_call", ...)`
- 对底层写工具的阻断/放行

## 4. 渠道测试

### MVP

- 飞书文本/markdown 展示
- 同聊命令确认

### Phase 2

- 飞书 interactive card 按钮

### 微信

- 只验证入口与文本回执，先不把 native card 作为完成条件

## 5. 手工验证清单

- 同一门店发起修改 -> 看到 diff -> 确认 -> 生效
- ACK 前人为修改门店配置 -> 确认后应冲突失败
- 重复点击确认 -> 不应重复写
- plan 过期 -> 不应再执行
- 模型误解字段 -> 用户能在确认前识别并取消

---

## 推荐分期

## Phase 0：范围冻结

先只做一个高价值场景，例如：

- 满减活动配置

不要第一版就把 19 个 optional 字段全部打平做完。

## Phase 1：可交付 MVP

范围：

- 自然语言入口命令
- LLM -> `IntentDraft`
- 1 到 3 个字段 resolver
- `MutationPlan`
- 文本/markdown diff 展示
- 文本确认命令
- 执行器
- `before_tool_call` 硬闸门
- 单元/集成测试

这是下一 session 推荐优先完成的范围。

## Phase 2：飞书 GUI 卡片确认

范围：

- diff card
- Confirm / Cancel button
- 卡片重复点击幂等

前提：

- 明确飞书公开接缝，不违反插件边界

## Phase 3：多字段、多业务面扩展

范围：

- 补更多字段 resolver
- 风险分级
- 多审批人
- 更多渠道

---

## 推荐的明确技术决策

以下决策建议在下一 session 中直接采用，不再重新讨论：

1. **入口允许自然语言**
2. **模型输出必须是受控 `IntentDraft`，不能是最终 payload**
3. **必须维护 `ParameterCatalog`**
4. **必须维护字段级 `FieldResolver`**
5. **主审批状态机使用自定义 `MutationPlan`**
6. **不把 OpenClaw plugin approval 作为主 diff UI**
7. **不允许 `allow-always`**
8. **底层写工具必须由 `before_tool_call` 强制拦截**
9. **执行器只接收 `planId`，不接收自然语言**
10. **写前必须 compare `beforeHash`**
11. **写后必须回读验证**
12. **飞书优先，微信第一版不以 native card 为完成条件**

---

## 下一 session 的建议实施顺序

### 第一批必须完成

1. 新建业务插件骨架
2. 实现 `ParameterCatalog`
3. 实现 1 个关键字段 resolver
4. 实现 `IntentDraft` schema
5. 实现 `MutationPlan` store
6. 实现 `/mutate` 入口
7. 实现 diff 展示
8. 实现 `/mutate-approve <planId>`
9. 实现执行器
10. 实现 `before_tool_call` guard
11. 补单元和集成测试

### 第二批可选

12. 飞书 card UI
13. 多字段扩展
14. 更多业务对象

---

## 对下一 session 的直接提示

下一 session 编码时，请优先记住以下几点：

- 不要把最终 payload 交给模型生成
- 不要让确认后的写入再回到模型
- 不要让业务插件 deep-import `extensions/feishu/src/*`
- 不要把主审批流程建立在 `plugin.approval.description`
- `before_tool_call` 只负责守门，不负责业务意图解析
- 第一版先用文本确认命令也可以，只要 plan 冻结、hook 守门、写前后校验完整，就已经满足核心安全目标

---

## 附录：建议的伪代码骨架

### `/mutate` 命令

```ts
async function handleMutateCommand(input: {
  storeId: string;
  userText: string;
  actor: string;
  sessionKey?: string;
}) {
  const intentDraft = await compileIntentWithModel({
    storeId: input.storeId,
    userText: input.userText,
    catalog: PARAMETER_CATALOG,
  });

  const resolved = resolveIntentDraft({
    intentDraft,
    catalog: PARAMETER_CATALOG,
  });

  if (!resolved.ok) {
    return renderClarification(resolved);
  }

  const beforeSnapshot = await readAdapter.readCurrentConfig(input.storeId);
  const beforeHash = hashSnapshot(normalizeSnapshot(beforeSnapshot));
  const writePayload = buildWritePayload({
    currentSnapshot: beforeSnapshot,
    resolvedPatch: resolved.patch,
  });
  const diffItems = buildDiff({
    beforeSnapshot,
    afterSnapshot: writePayload,
    catalog: PARAMETER_CATALOG,
  });

  const plan = await planStore.create({
    storeId: input.storeId,
    userText: input.userText,
    interpretationText: renderInterpretationText(resolved.patch),
    beforeSnapshot,
    beforeHash,
    resolvedPatch: resolved.patch,
    writePayload,
    diffItems,
    requestedBy: input.actor,
    sessionKey: input.sessionKey,
  });

  return renderPendingAck(plan);
}
```

### `/mutate-approve <planId>`

```ts
async function handleApproveCommand(planId: string, actor: string) {
  const plan = await planStore.get(planId);
  assertPlanCanBeApproved(plan, actor);
  await planStore.markApproved(planId, actor);
  return await executeMutationPlan(planId, actor);
}
```

### `executeMutationPlan(planId)`

```ts
async function executeMutationPlan(planId: string, actor: string) {
  const plan = await planStore.get(planId);
  assertPlanApproved(plan, actor);

  const current = await readAdapter.readCurrentConfig(plan.storeId);
  const currentHash = hashSnapshot(normalizeSnapshot(current));
  if (currentHash !== plan.beforeHash) {
    await planStore.markConflict(planId, {
      error: "Current store config changed after approval",
    });
    return renderConflict(plan);
  }

  await planStore.markExecuting(planId);

  const writeResult = await writeAdapter.writeConfig({
    storeId: plan.storeId,
    payload: plan.writePayload,
  });

  const verifySnapshot = await verifyAdapter.verifyCurrentConfig(plan.storeId);
  const verifyOk = snapshotsEqual(
    normalizeSnapshot(verifySnapshot),
    normalizeSnapshot(plan.writePayload),
  );

  if (!verifyOk) {
    await planStore.markFailed(planId, {
      writeSucceeded: writeResult.exitCode === 0,
      verifySucceeded: false,
      writeStdout: writeResult.stdout,
      writeStderr: writeResult.stderr,
      verifySnapshot,
      error: "Post-write verification failed",
    });
    return renderVerifyFailed(planId);
  }

  await planStore.markSucceeded(planId, {
    writeSucceeded: true,
    verifySucceeded: true,
    verifySnapshot,
  });
  return renderSuccess(planId);
}
```

### `before_tool_call` guard

```ts
api.on("before_tool_call", (event, ctx) => {
  if (!isProtectedWriteTool(event.toolName, event.params)) {
    return;
  }

  const approvedPlanId = getApprovedPlanId(event.params);
  if (!approvedPlanId) {
    return {
      block: true,
      blockReason: "This write tool requires an approved mutation plan.",
    };
  }

  const plan = planStore.getSync(approvedPlanId);
  if (!plan || plan.status !== "approved") {
    return {
      block: true,
      blockReason: "Approved mutation plan not found or not in approved state.",
    };
  }

  if (!toolParamsExactlyMatchPlan(event.params, plan.writePayload)) {
    return {
      block: true,
      blockReason: "Write payload does not match the approved frozen plan.",
    };
  }

  return;
});
```

---

## 最终结论

这套方案的关键不是“彻底把模型排除掉”，而是：

**把模型严格限制在意图理解阶段，并在进入真正写入前建立一个完全确定性的冻结边界。**

从这个冻结边界开始：

- payload 只来自当前快照与纯代码 patch
- ACK 确认的是系统理解和 diff
- 写入只由 plan 驱动
- hook 阻止一切绕过 plan 的直接写入
- 写前和写后都有强校验

如果这一边界守住了，即使模型有时理解错字段，也最多生成一个错误的候选 plan，而不会直接把错误参数写进生产系统。
