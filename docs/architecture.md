# OpenClaw Safe Mutation 架构说明

## 1. 真实目标

这个项目的真实目标，不是为某一个 skill 设计一套专用写流程，而是在 OpenClaw 实例侧提供一层统一的“写操作安全兜底”。

真实场景是：

- OpenClaw 上长期运行着几十个人贡献的上百个 skill
- 不能假设所有 skill 都会按统一高标准实现写保护
- 不能要求每个 skill 作者都理解并接入一整套 `/mutate` 风格流程
- 因此需要一套平台侧、集中式、最低接入成本的 hook 机制

当前仓库只是用 `mock-full-reduction-config` 作为测试 skill 来验证这套机制是否可行。它是验证样本，不是最终目标本身。

## 2. 目标使用方式

目标中的最低成本接入方式应该是：

1. 新 skill 提交进来
2. 如果它包含真实写操作，识别出它对应的写工具
3. 为该写路径增加一条 `protectedMutations` binding，显式声明写入口匹配、目标对象抽取、读 invocation、字段映射和验证规范化
4. 从此匹配该 binding 的写请求，都必须先经过审批，再允许真正执行

也就是说，系统希望依赖“中心化变更配置”，而不是“分散的 skill 作者自觉”。只登记写工具名不够，因为 hook 还必须知道如何读取当前状态来生成 diff、检测 conflict 和回读验证。

## 3. 设计前提

这套方案成立的前提是：

- 写行为必须最终表现为一个可识别的 OpenClaw 工具调用
- 这个工具调用要携带结构化参数，至少能识别目标对象和最终写入 payload
- 对每类受保护写路径，平台配置里必须有确定性的读路径，不能靠 hook 猜“对应的 read 命令”

只要满足这个前提，平台就可以在 skill 不改流程、作者不额外配合的情况下统一兜底。

这也是为什么“第一次被 hook 拦截的请求已经携带完整 payload”不是问题，反而正是目标设计：

- 系统不需要自己猜最终写入参数
- 系统直接冻结 skill 原本就准备提交的真实 payload
- 用户确认的就是这次真实将要发生的写入

## 4. 核心思路

核心设计只有一句话：

**第一次写请求先拦下，把它原本要写的精确 payload 冻结成 plan，发出确认；当前文本 ACK 链路在用户确认后由系统直接执行冻结 plan，不再让模型重试原写工具。**

这里真正关键的不是命令形式，而是这四个动作：

1. 拦截
2. 冻结
3. 确认
4. 执行

其中：

- `before_tool_call` 是最终硬闸门
- `protectedMutations` registry 是写入口到读/写/验证路径的显式配置
- `MutationPlan` 是唯一可信的冻结对象
- ACK 是把 plan 从“待确认”推进到执行链路的一种事件

## 5. 为什么要做 hook-first，而不是 skill-first

### 5.1 不依赖 skill 作者质量

平台侧 hook 是统一能力。只要某个写工具被纳入保护列表，它就自动进入统一审批语义，不需要 skill 作者自己补 `/mutate`、diff 展示、ACK 逻辑、冲突检测等。

### 5.2 使用真实 payload，而不是二次推导 payload

对于写操作，最危险的不是“能不能理解用户意图”，而是“最终到底写了什么”。

hook-first 方案直接使用 skill 即将提交的真实 payload：

- 不需要平台再从自然语言重新构造一次
- 不需要猜哪些字段该保留、哪些字段该覆盖
- 审批对象与最终写入对象天然一致

### 5.3 新增保护对象的成本最低

理想情况下，给一个新 skill 加保护，只需要做一件事：

- 增加一条可审计的 mutation binding

这比要求每个 skill 单独接业务命令、单独实现审批交互、单独维护计划状态机要便宜得多。

## 6. 最小闭环

针对一个受保护写工具，最小闭环应当是：

1. skill 发起一次真实写工具调用
2. `before_tool_call` 用 registry 匹配到对应 binding
3. 如果这次请求没有 `approvedPlanId`：
   - 解析出目标对象和本次真实写入意图
   - 用 binding 中冻结的 read invocation 读取当前快照
   - 基于当前快照和写入意图计算完整 payload 和 diff
   - 基于当前快照和这份 payload 生成冻结 `MutationPlan`
   - 向原对话发出确认信息
   - 阻断本次写请求
4. 用户发送 ACK
5. 系统校验审批身份、plan 状态和过期时间
6. 当前文本 ACK 实现把 plan 标记为 `approved` 后立即执行冻结 plan；未来也可由调用方再次发起同一写工具调用并带上 `approvedPlanId`
7. 执行前重新使用冻结的 read invocation 读取当前快照，校验 `beforeHash` 避免 conflict
8. 写入使用冻结的 write invocation 和 `writePayload`
9. 写后使用 verify/read invocation 回读验证

如果走未来的 `approvedPlanId` 重试路径，hook 还必须校验：

   - plan 存在且状态为 `approved`
   - 当前 target 与 plan 一致
   - 本次请求的 payload 与冻结 payload 完全一致

只有全部通过，hook 才允许本次工具真正执行写入。

这就是项目最核心的“hook 拦截写操作 -> 发出确认 -> 得到 ACK 后由系统执行冻结 plan”的闭环。

## 7. `MutationPlan` 的职责

`MutationPlan` 是平台对一次写操作的冻结记录。它至少要承载：

- 写前快照 `beforeSnapshot`
- 快照哈希 `beforeHash`
- 最终冻结写入对象 `writePayload`
- 用于展示的 diff
- 请求来源上下文，如 `requestedBy`、`channel`
- 审批身份主键，如 `approvalPrincipal`
- 可选的账号命名空间，如 `accountId`
- 冻结的 `executionContext`，包括 read/write/verify invocation 和 binding ID
- plan 状态，如 `pending_ack`、`approved`
- 过期时间

它的意义不是“描述用户说了什么”，而是“描述系统允许发生的那一次精确写入”。

因此，审批绑定的对象不是自然语言，而是冻结后的 plan。

这里的关键点是：

- 不再把 `sessionKey` 作为确认前提
- 更稳定的确认身份应当绑定到“人”，而不是“会话”

## 8. hook 的职责边界

hook 只做一件事：守住最终写入口。

它不负责：

- 理解业务语义
- 帮 skill 重组 payload
- 替 skill 生成写参数

它只负责判断：

- 这个写请求能不能执行

典型判断条件包括：

- 请求是否匹配受保护 mutation binding
- 受保护直接写工具如果没有匹配 binding，必须 fail closed
- 是否带有 `approvedPlanId`
- plan 是否已批准、未过期
- 当前请求上下文是否与 plan 匹配
- 当前 payload 是否与冻结 payload 完全一致

只要有一个条件不满足，就 fail closed，直接阻断。

这里的“上下文匹配”应收敛为稳定身份匹配，而不是 session 精确匹配：

- 默认用 `channel + senderId` 作为审批身份校验主键
- `accountId` 作为可选增强字段，用于多账号 / 多租户场景下做 namespace 隔离
- 不再要求 ACK 必须发生在原始 `sessionKey` 对应的会话里

也就是说，用户只要还是同一个渠道下的同一个稳定身份，即使 session 被重置、线程变化，仍然应该允许确认。

## 9. ACK 机制的定位

ACK 是必须的，但 ACK 的外形不是必须的。

当前仓库里保留的是命令实现模块：

- `runMutateApproveCommand`
- `runMutateCancelCommand`

需要明确一点：当前 demo 的文本 ACK 实现并不是“批准后等待 skill 重试原写工具”。
在现有代码里，`before_dispatch` 消费 `确认` / `取消` 文本后，会直接调用
`runMutateApproveCommand` / `runMutateCancelCommand`；其中 `runMutateApproveCommand`
会立刻执行冻结 plan。也就是说，当前文本确认链路里，“回复确认”本身就是执行入口。

这是当前最小实现里最便宜的确认通道，不代表最终形态必须是文本回复或 slash command。历史 `/mutate-approve <planId>`、`/mutate-cancel <planId>` 不是当前主链路前提。

在真实系统里，ACK 完全可以替换或扩展为：

- 飞书卡片按钮
- 审批回调
- Web UI 按钮
- 其他结构化确认事件

架构真正需要的只有一件事：

- 有一个可靠通道，能把“某个 plan 已被确认”这件事写回系统

对当前目标设计，ACK 机制还应满足这几个约束：

- 审批身份校验以 `channel + senderId` 为主
- `accountId` 可选参与，但不应成为强依赖前提
- 不依赖原始 `sessionKey`
- 即使用户在新 session 中确认，只要身份一致、plan 未过期，也应允许 ACK

这比“必须原会话确认”的约束更适合平台级 hook 兜底场景。

## 10. 确认句柄设计

当前文本 renderer 会展示 `planId`，主要用于多 pending plan 时让用户能手工指定。结构化 UI 里，`planId` 不必展示给用户，可以作为隐藏句柄使用。

推荐做法是：

- 对用户展示变更内容和确认入口
- 文本 fallback 可以展示 `planId`；按钮/卡片形态不在文案中暴露 `planId`
- 在卡片按钮、回调 payload 或其他结构化 ACK 载荷里携带 `planId`
- 系统收到 ACK 后，用 `planId` 找到对应 plan 并继续做身份、状态、过期校验

在这个设计里，`planId` 可以承担 `approvalToken` 的同等功能，前提是：

- `planId` 是高熵、不可枚举的
- 它只作为系统内部句柄使用，不要求用户手工输入
- 最终确认仍然要结合审批身份和 plan 状态一起校验

因此，第一版不必额外拆一个独立 `approvalToken`；隐藏 `planId` 作为 callback handle 即可。

## 11. `/mutate` 的定位

`/mutate` 不是这套真实目标里的核心能力。

它更适合作为：

- 本地调试入口
- 演示入口
- 手工构造 plan 的辅助工具

但对于你的真实场景，平台不应该依赖所有 skill 都走 `/mutate`。真正应该依赖的是：

- 所有真实写操作最终都会经过统一 hook

因此，从长期架构看：

- `before_tool_call` 是必须的
- `MutationPlan` 是必须的
- ACK 能力是必须的
- `/mutate` 不是必须的

## 12. 当前仓库与目标架构的对应关系

当前代码里，和真实目标最相关的模块是：

- `openclaw.entry.ts`
  - 加载 `protectedMutations` registry
  - 注册 `before_tool_call`
  - 在首次拦截时把确认信息发回原对话
- `src/hooks/before-tool-call.ts`
  - 统一做放行 / 阻断判断
- `src/mutation-registry.ts`
  - 维护受保护写入口、读 invocation、字段映射和 normalizer 配置
- `src/protected-write-request.ts`
  - 按 registry 解析真实写请求并读取 before snapshot
- `src/protected-write-plan.ts`
  - 从“被拦截的真实写请求”直接生成冻结 plan
- `src/intent-types.ts`
  - 定义 plan 状态机与核心对象模型
- `src/file-plan-store.ts`
  - 持久化 plan

而下面这些更接近当前 demo / 辅助能力：

- `src/commands/mutate-approve.ts`
  - 当前文本 ACK 的实现
- `src/commands/mutate-cancel.ts`
  - 当前文本取消的实现
- `src/executor.ts`
  - 当前 demo 中用于直接执行和回读验证的路径

对于真实的 hook-first 架构，这些命令层能力可以保留，但不应被当成平台侧安全机制的前提。

## 13. 最终结论

这套方案要解决的问题，本质上不是“怎么教 skill 作者写得更规范”，而是“即使 skill 写得一般，也不能让高风险写操作直接穿透系统”。

因此正确的架构重心应该是：

- 平台集中维护受保护 mutation registry
- 每个受保护写路径必须有显式 mutation binding，尤其是读路径
- 首次写请求一律先被 hook 拦下
- 直接冻结这次真实请求中的 payload
- 当前文本确认后，由系统执行冻结 plan，不依赖模型重新发起写工具
- `approvedPlanId` 重试路径仍保留为未来结构化审批后的兼容形态；若走该形态，只有与冻结内容完全一致的重试请求才允许继续
- 审批身份校验以 `channel + senderId` 为主，`accountId` 作为可选增强
- 不再把 `sessionKey` 当成确认前提
- `planId` 可作为隐藏确认句柄放入 callback payload，不要求展示给用户

当前项目里 `mock-full-reduction-config` 只是这套能力的测试 skill。真正要交付的，是一套干净、统一、可批量覆盖新 skill 的 hook 兜底机制。
