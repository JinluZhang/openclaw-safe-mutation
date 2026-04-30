# OpenClaw Safe Mutation 技术设计方案

> 面向 Skill Owner 分享 & 技术汇报用文档
> 基于 openclaw-safe-mutation v0.1.0 代码与文档整理

---

## 一、项目背景与动机

### 1.1 要解决什么问题

OpenClaw 平台上长期运行着数十人贡献的上百个 skill，其中不少 skill 具有**写操作能力**（修改门店配置、调整活动参数、变更商品状态等）。在这种场景下，平台面临一个核心风险：

> **不能假设所有 skill 作者都会按统一高标准实现写保护。**

如果某个 skill 的写工具直接穿透系统执行了错误的修改，影响可能是线上真实业务数据的损坏。

### 1.2 我们不做什么

- 不是为某一个特定 skill 设计专用写流程
- 不是要求每个 skill 作者都理解并接入 `/mutate` 风格的审批协议
- 不是在 skill 侧分散实现各自的审批 UI

### 1.3 我们要做什么

在 **OpenClaw 平台侧**提供一层**统一的、中心化的、最低接入成本的"写操作安全兜底"机制**。

核心思路一句话概括：

> **第一次写请求先拦下，把 skill 原本要写的精确 payload 冻结成 plan，发出确认；用户确认后由系统直接执行冻结 plan，不再让模型重试原写工具。**

---

## 二、为什么选择 Hook-First 方案

| 维度 | Hook-First（平台侧拦截） | Skill-First（skill 自己实现） |
|------|--------------------------|-------------------------------|
| **质量依赖** | 不依赖 skill 作者质量 | 完全依赖每个作者的实现水平 |
| **payload 来源** | 直接冻结 skill 真实 payload | 需要平台二次推导或模型重新生成 |
| **接入成本** | 增加一条配置 binding | 每个 skill 自己实现审批、diff、状态机 |
| **一致性** | 统一审批语义 | 各 skill 各自为政 |
| **覆盖速度** | 配置化批量覆盖 | 逐个 skill 改造 |

关键洞察：**写操作里最危险的不是"模型是否理解了用户意图"，而是"最终到底提交了什么 payload"。** Hook-First 方案直接使用 skill 即将提交的真实 payload，审批对象与最终写入对象天然一致。

---

## 三、总体架构

### 3.1 架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenClaw 插件入口                        │
│  openclaw.entry.ts                                          │
│  注册 before_tool_call / before_dispatch / agent_end        │
│  加载 protectedMutations registry                           │
│  发送确认消息 / 消费文本 ACK                                   │
└─────────┬──────────────────┬────────────────────┬───────────┘
          │                  │                    │
    ┌─────▼──────┐   ┌──────▼───────┐   ┌───────▼────────┐
    │  写入硬闸门  │   │  变更配置中心  │   │   计划冻结引擎   │
    │  before-    │   │  mutation-   │   │  protected-   │
    │  tool-call  │   │  registry    │   │  write-plan   │
    │  guard      │   │              │   │               │
    └─────┬──────┘   └──────┬───────┘   └───────┬────────┘
          │                  │                    │
    ┌─────▼──────┐   ┌──────▼───────┐   ┌───────▼────────┐
    │  写请求识别  │   │  字段目录     │   │   计划存储       │
    │  protected- │   │  catalog     │   │  file-plan-   │
    │  write-     │   │              │   │  store        │
    │  request    │   │              │   │               │
    └────────────┘   └──────────────┘   └────────────────┘
          │
    ┌─────▼──────────────────────────────────────────────┐
    │               确认 → 执行 → 验证链路                   │
    │  mutate-approve / mutate-cancel / executor         │
    │  ReadAdapter / WriteAdapter / VerifyAdapter         │
    └────────────────────────────────────────────────────┘
```

### 3.2 核心模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **插件入口** | `openclaw.entry.ts` | 注册 OpenClaw hooks，加载 registry，发送确认消息，消费文本 ACK |
| **写入硬闸门** | `src/hooks/before-tool-call.ts` | 对每次工具调用做 allow/block 判定 |
| **变更配置中心** | `src/mutation-registry.ts` | 维护受保护写入口的匹配规则、读/写/验证 invocation 模板 |
| **写请求识别** | `src/protected-write-request.ts` | 把工具调用规范化为 `ProtectedWriteRequest` |
| **字段目录** | `src/catalog.ts` | 受保护字段白名单，diff/payload 对比的 source of truth |
| **计划冻结引擎** | `src/protected-write-plan.ts` | 从真实写请求生成冻结 `MutationPlan` |
| **计划存储** | `src/plan-store.ts` / `src/file-plan-store.ts` | 持久化 plan，维护状态机约束 |
| **确认命令** | `src/commands/mutate-approve.ts` / `mutate-cancel.ts` | 校验审批身份，推进状态，触发执行 |
| **执行器** | `src/executor.ts` | 写前冲突检测 → 执行冻结写入 → 回读验证 |
| **适配器** | `src/adapters/*` / `src/tool-backed-adapters.ts` | 隔离读/写/验证实现，支持 shell 和 HTTP |
| **审批身份** | `src/approval-principal.ts` | 构建和规范化 `channel:senderId` 审批主键 |
| **文本渲染** | `src/channels/text-render.ts` | 渲染确认消息和状态结果 |
| **文本解析** | `src/text-plan-actions.ts` | 解析"确认/取消"文本回复 |
| **Diff** | `src/diff.ts` | 生成 before/after 字段对比 |
| **Hash** | `src/snapshot-normalizer.ts` | 规范化快照 + SHA-256，保证 key 顺序不影响比较 |

---

## 四、核心流程详解

### 4.1 主流程全景

```
用户请求修改
    │
    ▼
Skill 发起写工具调用
    │
    ▼
before_tool_call 拦截
    │
    ├─ 非受保护工具 → 放行
    │
    ├─ 受保护但无 binding → fail closed（阻断）
    │
    └─ 命中 binding
        │
        ├─ 带 approvedPlanId 且全部匹配 → 放行
        │
        └─ 未带 approvedPlanId（首次写入）
            │
            ▼
    ┌───────────────────┐
    │  1. 读取当前快照     │  ← 按 binding.read invocation
    │  2. 冻结真实 payload │  ← 不让模型二次生成
    │  3. 生成 diff        │  ← before/after 字段对比
    │  4. 创建 MutationPlan│  ← 状态 = pending_ack
    │  5. 发送确认消息      │  ← 回推到原始会话
    │  6. 阻断本次写请求    │  ← 返回 APPROVAL_SENT
    └───────────────────┘
            │
            ▼
    用户看到确认单（diff + 确认/取消方式）
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
  "确认"          "取消"
    │               │
    ▼               ▼
  approved        cancelled
    │
    ▼
┌────────────────────────┐
│  执行冻结 plan            │
│  1. 重新读取当前快照       │
│  2. 比较 beforeHash       │
│     ├─ 不一致 → conflict  │
│     └─ 一致 → 继续        │
│  3. 执行冻结 writePayload │
│  4. 回读验证              │
│     ├─ 匹配 → succeeded   │
│     └─ 不匹配 → failed    │
└────────────────────────┘
```

### 4.2 四个核心动作

整个方案的本质就是四个动作：

1. **拦截** — `before_tool_call` 是最终硬闸门，所有受保护写工具必须经过它
2. **冻结** — 直接冻结 skill 原本准备提交的真实 payload 为 `MutationPlan`
3. **确认** — 用户审批冻结的 plan，而不是自然语言描述
4. **执行** — 只执行冻结 payload，写前防冲突，写后强验证

---

## 五、核心对象模型

### 5.1 MutationPlan（变更计划）

`MutationPlan` 是系统唯一可信的冻结记录，定义在 `src/intent-types.ts`。

```
MutationPlan
├── planId               # 高熵不可枚举 ID
├── status               # pending_ack → approved → executing → succeeded/failed/conflict
├── storeId              # 被修改的业务对象 ID（如门店 ID）
├── beforeSnapshot       # 写前完整快照
├── beforeHash           # 快照 SHA-256，用于冲突检测
├── writePayload         # 冻结的最终写入 payload（唯一执行依据）
├── resolvedPatch        # 确定性字段变更列表
├── diffItems            # before/after 展示用 diff（不作为执行依据）
├── executionContext      # 冻结的 read/write/verify invocation + bindingId
├── approvalPrincipal    # 审批身份主键 channel:senderId
├── expiresAtMs          # 过期时间（默认 15 分钟）
└── result               # 执行结果详情
```

关键设计点：
- `writePayload` 是唯一执行依据，`diffItems` 只用于展示
- `writePayload` 通过 `structuredClone` 深拷贝存储，防止外部修改
- `beforeHash` 使用规范化 JSON + SHA-256，字段顺序不影响 hash

### 5.2 ProtectedMutationBinding（受保护变更配置）

每个受保护写路径必须有一条 binding，定义在 `src/mutation-registry.ts`。

```
ProtectedMutationBinding
├── id                   # binding 稳定 ID
├── protectedToolName    # 规范化后的业务写工具名
├── match                # 写入口匹配规则
│   ├── kind: "exec"     # 命令行写命令识别
│   │   ├── scriptBasename, writeSubcommand, resourceFlag
│   │   └── mutableFlags → fieldId 映射
│   └── kind: "tool"     # 直接工具调用识别
│       ├── resourceParamPath
│       └── payloadParamPath
├── read                 # 读当前状态的 invocation 模板（必填）
├── write                # 写 invocation 模板（direct tool 必填）
├── verify               # 验证 invocation 模板（省略时复用 read）
└── compareNormalizer    # 写后验证前的规范化器
```

关键设计点：
- **只注册写工具名不够**，每个 binding 必须声明 `read` invocation
- 没有 matching binding 的受保护写工具 **fail closed**（阻断而不是放行）
- shell invocation 使用 `commandTokens` 模板逐 token quote，避免注入

### 5.3 ParameterCatalog（字段目录）

受保护字段白名单，定义在 `src/catalog.ts`，是 diff、payload 对比、CLI flag 解析的 source of truth。

```
ParameterCatalogItem
├── fieldId              # 平台内部稳定字段 ID
├── labels               # 用户展示名（如 ["活动名称", "activity_name"]）
├── valueType            # 字段值类型（string/boolean/integer/decimal/...）
├── apiPath              # 字段在 snapshot/payload 中的路径（支持点号路径）
├── requiredInWritePayload # 写 payload 是否必须包含
└── supportsOperations   # 允许的变更操作（set/replace_item/...）
```

### 5.4 状态机

```
             ┌─────────────────────────────────────────────────┐
             │                    MutationPlan 状态机            │
             │                                                 │
             │  [创建] ──→ pending_ack ──→ approved ──→ executing │
             │                │    │          │    │       │      │
             │                │    │          │    │       ├→ succeeded │
             │                │    ▼          │    ▼       ├→ failed    │
             │                │  cancelled    │  expired   └→ conflict  │
             │                ▼               ▼                        │
             │              expired         conflict                   │
             │                                                         │
             │  活跃态：pending_ack / approved / executing              │
             │  终态：  succeeded / failed / conflict / cancelled / expired │
             │  终态不可回跳到活跃态                                      │
             └─────────────────────────────────────────────────────────┘
```

---

## 六、安全不变量

以下是项目**必须保证的安全不变量**，任何重构或演进都不能破坏：

| # | 不变量 | 说明 |
|---|--------|------|
| 1 | `before_tool_call` 是最终硬闸门 | 所有受保护写工具必须经过它 |
| 2 | 无 binding 则 fail closed | 受保护写工具没有匹配 binding 时阻断，不放行 |
| 3 | 首次裸写必须阻断并冻结 | 没有 `approvedPlanId` 的受保护写请求一律阻断 |
| 4 | 确认的是冻结 plan | 用户确认的是冻结 payload，不是自然语言描述 |
| 5 | 确认后不让模型重生成 | 系统执行冻结 `writePayload`，不依赖模型重试 |
| 6 | 写前必须防冲突 | 执行前重读快照比较 `beforeHash`，不一致则 conflict |
| 7 | 写后必须回读验证 | 不能只信写接口返回，必须 verify 结果与冻结 payload 一致 |
| 8 | 终态不可回跳 | succeeded/failed/conflict/cancelled/expired 是终态 |
| 9 | payload 精确匹配 | 带 `approvedPlanId` 重试时，payload 必须与冻结 payload 完全一致 |
| 10 | 审批身份绑定稳定的人 | 用 `channel + senderId`，不把 `sessionKey` 当硬前提 |
| 11 | 重复确认幂等 | 已完成 plan 重复确认不会重复写入 |
| 12 | unrelated exec 不拦截 | 只拦截匹配 binding 的写命令，不误杀普通命令 |

---

## 七、Skill Owner 接入指南

### 7.1 对 Skill Owner 的影响

**好消息：业务 skill 不需要改任何代码。**

Skill 继续按原方式发起读写工具调用。平台侧只需为高风险写路径补齐 `protectedMutations` binding。

接入边界：
- **Skill** 负责表达业务能力和发起真实读写调用
- **平台/配置维护者** 负责把高风险写入口加入 `protectedMutations`

### 7.2 新增保护写工具的最低步骤

```
1. 增加一条 protectedMutations binding
   ├── 声明 id、protectedToolName
   ├── 配置 match 规则（写入口识别）
   ├── 配置 read invocation（如何读当前状态）
   ├── 配置 write invocation（direct tool 需要）
   └── 配置 verify invocation（可选，默认复用 read）

2. 配置字段映射
   ├── mutableFlags → fieldId（exec binding）
   └── 补充 ParameterCatalog 字段

3. 配置规范化器
   ├── resultPath（读结果有包装层时）
   └── compareNormalizer（写后验证需要剥离 volatile 字段时）

4. 补齐测试
   ├── guard seam tests：裸写阻断、缺 binding 阻断、payload drift 阻断、一致放行
   └── integration tests：成功、冲突、verify failed、重复确认幂等
```

### 7.3 配置示例

```jsonc
{
  "protectedMutations": [
    {
      "id": "your-skill.exec",
      "protectedToolName": "your-skill-write",
      "match": {
        "kind": "exec",
        "toolName": "exec",
        "pythonExecutable": true,
        "scriptBasename": "your_cli.py",
        "writeSubcommand": "write",
        "readSubcommand": "read",
        "resourceFlag": "--poiid",
        "mutableFlags": {
          "--your-flag": "your_field_id"
        }
      },
      "read": {
        "kind": "shell",
        "commandTokens": [
          "{{pythonToken}}", "{{scriptPath}}",
          "read", "--poiid", "{{resourceId}}", "--format", "json"
        ]
      }
    }
  ]
}
```

### 7.4 接入前提条件

对无法满足以下条件的写路径，不应接入自动执行闭环，只能 fail closed 或走人工处理：

- 写行为最终表现为一个可识别的 OpenClaw 工具调用
- 工具调用携带结构化参数，能识别目标对象和写入 payload
- 存在确定性的读路径，能读取当前状态
- 写后能通过 read/verify 回读验证

---

## 八、确认机制设计

### 8.1 当前实现：文本确认

当前 MVP 使用会话内文本确认作为最简 ACK 通道：
- 用户回复"确认"→ 系统立即执行冻结 plan
- 用户回复"取消"→ plan 标记 cancelled
- 多个 pending plan 时需指定 planId："确认 plan_xxx"

### 8.2 确认消息示例

```
Plan: plan_a1b2c3d4-...
状态：pending_ack
原始请求：通过受保护写工具申请修改门店 10001 的 第一档优惠
系统理解：修改字段「第一档优惠(tier_1_discount)」
门店：10001
变更：
- 第一档优惠: 15 -> 14
说明：其余参数保持当前值不变
确认方式：回复"确认"后由系统直接执行
取消方式：回复"取消"放弃本次变更
```

### 8.3 演进方向

文本 ACK 不是最终形态。架构真正需要的只是：**一个可靠通道，能把"某个 plan 已被确认"这件事写回系统。** ACK 可以替换为：
- 飞书卡片按钮
- 审批回调
- Web UI 按钮
- 任何结构化确认事件

在结构化 UI 中，`planId` 可以作为隐藏句柄放入 callback payload，不必展示给用户。

### 8.4 Assistant Final 与 blockReason

写请求被阻断后，模型仍可能生成一段普通回复。为防止模型误导用户（如说"已为你完成修改"），`blockReason` 会给模型一个明确的回复契约：

```
SAFE_MUTATION_APPROVAL_SENT.
The protected write tool call was blocked; the write has not been executed yet.
...
Reply briefly in the user's language. For Chinese, say:
已生成变更确认单，点击确认后系统会自动执行。
```

安全性不依赖模型遵循话术，真正的安全边界是 `before_tool_call` 阻断 + 冻结 plan + ACK 校验 + 执行器验证。

---

## 九、审批身份设计

### 9.1 身份结构

```
approvalPrincipal = channel:senderId
                  | channel:accountId:senderId
```

- `channel`：渠道标识（如 feishu、wechat）
- `senderId`：该渠道下的稳定用户标识
- `accountId`：可选，多账号/多租户场景下的命名空间隔离

### 9.2 设计决策

- **不把 `sessionKey` 当确认前提** — 用户只要是同一个人，即使 session 被重置、线程变化，仍允许确认
- ACK 可以来自不同 session，只要 `approvalPrincipal` 一致
- 历史持久化值有冗余前缀时（如 `feishu:default:feishu:ou_alice`），通过 `normalizeSenderId` 自动规范化

---

## 十、数据流与执行链路

### 10.1 执行器流程（`executeMutationPlan`）

```
executeMutationPlan(planId)
    │
    ├─ plan 不存在 → 抛错
    ├─ plan 已终态 → 幂等返回（不重复写入）
    ├─ plan 非 approved → 抛错
    ├─ plan 已过期 → 标记 expired
    │
    ├─ 重新按冻结 readInvocation 读取当前快照
    │   └─ 计算 currentHash
    │
    ├─ currentHash ≠ beforeHash → 标记 conflict（不写入）
    │
    ├─ 标记 executing
    ├─ 按冻结 writeInvocation 执行写入
    ├─ 按冻结 verifyInvocation 回读
    │
    ├─ 验证通过 → succeeded
    └─ 验证失败 → failed
```

### 10.2 适配器抽象

```typescript
interface ReadAdapter {
  readCurrentConfig(params: { storeId, executionContext? }): Promise<Record<string, unknown>>;
}

interface WriteAdapter {
  writeConfig(params: { storeId, payload, executionContext? }): Promise<WriteAdapterResult>;
}

interface VerifyAdapter {
  verifyCurrentConfig(params: { storeId, executionContext? }): Promise<Record<string, unknown>>;
}
```

当前实现 `ToolReadAdapter` / `ToolWriteAdapter` / `ToolVerifyAdapter` 支持 shell 和 HTTP 两种 invocation。生产可替换为真实业务 API 适配器。

---

## 十一、测试策略

项目采用四层验证策略：

| 层级 | 名称 | 覆盖范围 | 对应文件 |
|------|------|----------|----------|
| L0 | 静态校验 | 类型系统约束 | `npm run typecheck` |
| L1 | 单元测试 | 纯函数逻辑 | `test/unit/*.test.ts` |
| L2 | 集成测试 | 完整工作流（fake adapter） | `test/integration/*.test.ts` |
| L3 | 接缝测试 | OpenClaw hook 安全边界 | `test/seams/*.test.ts` |
| L4 | 手工干跑 | 聊天入口用户体验 | 手工验证 |

### 关键测试用例覆盖：

- **单元测试**：状态机终态不可回跳、hash 规范化、exec 写命令识别、approval principal 规范化、文本确认/取消解析
- **集成测试**：成功执行、冲突检测、回读失败、幂等重复确认、tier 双视图同步、跨 session 同 principal 确认、不同 principal 拒绝
- **接缝测试**：unrelated exec 放行、裸写阻断、缺 binding 阻断、payload 不一致阻断、完全一致放行

---

## 十二、当前样例：mock-full-reduction-config

当前仓库使用一个满减活动配置的 mock skill 来验证整套机制。

### 12.1 Mock CLI

```bash
# 读取配置
python3 scripts/mock_full_reduction_cli.py read --poiid 10001 --format json

# 写入配置（会被 safe-mutation 拦截）
python3 scripts/mock_full_reduction_cli.py write --poiid 10001 --tier-1-discount 14 --format json

# 查看 schema
python3 scripts/mock_full_reduction_cli.py schema --format json
```

### 12.2 字段覆盖

当前 catalog 定义了 19 个受保护字段，涵盖：活动名称、状态、时间、满减档位（3 档 × 门槛/优惠）、配送费减免、预算上限、各种叠加开关、备注等。

### 12.3 Tier 双视图同步

满减档位同时存在两种视图：
- **业务 list 视图**：`promotion.full_reduction_tiers`（`[{threshold, reduction}, ...]`）
- **CLI scalar 视图**：`tier_1_threshold`、`tier_1_discount` 等

修改任一视图时自动同步另一视图，确保 read/write/verify 可以稳定比较。

---

## 十三、Fail Closed 策略总结

| 场景 | 行为 |
|------|------|
| 受保护写工具没有匹配 binding | 阻断 |
| 匹配 binding 但缺字段/未知 flag/缺读配置 | 阻断 |
| 没有 `approvedPlanId` 的受保护写请求 | 阻断 |
| `approvedPlanId` 不存在或 plan 非 approved | 阻断 |
| plan 已过期 | 阻断，标记 expired |
| storeId 不匹配 | 阻断 |
| payload 与冻结 payload 不一致 | 阻断 |
| 执行前 currentHash ≠ beforeHash | 标记 conflict，不写入 |
| 写后回读验证不通过 | 标记 failed |
| 普通 unrelated exec | **放行**（不误杀） |

---

## 十四、演进路线

### 14.1 从 MVP 到生产

| 维度 | 当前 MVP | 生产目标 |
|------|----------|----------|
| ACK 通道 | 文本回复"确认/取消" | 飞书卡片按钮 / Web UI / 审批回调 |
| Plan Store | 文件版 JSON | 数据库（保留状态机约束） |
| 适配器 | Mock CLI | 真实业务 API / CLI |
| 确认消息 | 纯文本 diff | 结构化卡片（planId 隐藏在 callback） |
| 保护范围 | mock-full-reduction-config | 批量覆盖高风险写 skill |

### 14.2 核心不变量（演进中不能改变）

- 平台集中拦截
- 配置化读写路径
- 冻结真实 payload
- 用户确认冻结 plan
- 纯代码执行（不让模型参与）
- 写前冲突检测
- 写后回读验证

---

## 十五、项目结构速查

```
openclaw-safe-mutation/
├── openclaw.entry.ts          # 插件入口：注册 hooks，串联全流程
├── openclaw.plugin.json       # 插件元数据
├── package.json               # 项目配置
├── tsconfig.json              # TypeScript 配置
│
├── src/
│   ├── intent-types.ts        # 核心类型定义（MutationPlan, ResolvedPatch, ...）
│   ├── catalog.ts             # 字段目录（ParameterCatalog）
│   ├── mutation-registry.ts   # 受保护变更 binding 配置与匹配
│   ├── protected-write-request.ts  # 写请求识别与规范化
│   ├── protected-write-plan.ts     # 计划冻结引擎
│   ├── plan-store.ts          # Plan Store 接口
│   ├── file-plan-store.ts     # 文件版 Plan Store 实现
│   ├── executor.ts            # 执行器（冲突检测 → 写入 → 验证）
│   ├── approval-principal.ts  # 审批身份构建与规范化
│   ├── diff.ts                # Diff 生成
│   ├── snapshot-normalizer.ts # 快照规范化与 hash
│   ├── payload-builder.ts     # Payload 构建（patch → full payload）
│   ├── object-path.ts         # 嵌套对象路径读写
│   ├── text-plan-actions.ts   # 文本确认/取消解析
│   ├── tool-backed-adapters.ts # Shell/HTTP 适配器实现
│   ├── adapters/
│   │   ├── read-adapter.ts    # ReadAdapter 接口
│   │   ├── write-adapter.ts   # WriteAdapter 接口
│   │   └── verify-adapter.ts  # VerifyAdapter 接口
│   ├── channels/
│   │   └── text-render.ts     # 文本确认消息渲染
│   ├── commands/
│   │   ├── mutate-approve.ts  # 确认命令
│   │   └── mutate-cancel.ts   # 取消命令
│   └── hooks/
│       └── before-tool-call.ts # 写入硬闸门
│
├── skills/
│   └── mock-full-reduction-config/  # 样例 mock skill
│       ├── SKILL.md
│       ├── scripts/mock_full_reduction_cli.py
│       └── data/mock_full_reduction_state.json
│
├── test/
│   ├── unit/                  # L1 单元测试
│   ├── integration/           # L2 集成测试
│   └── seams/                 # L3 接缝测试
│
└── docs/                      # 详细设计文档
    ├── architecture.md
    ├── technical-design-overview.md
    ├── protected-mutation-bindings.md
    ├── key-technical-notes.md
    ├── install-usage-manual.md
    ├── validation-plan.md
    └── archive/
```

---

## 十六、常见 FAQ

**Q: Skill 作者需要做什么改动？**
A: 不需要。Skill 继续按原方式发起读写调用。平台配置维护者为高风险写路径补齐 binding 即可。

**Q: 如果 hook 拦截后模型告诉用户"已修改成功"怎么办？**
A: 安全性不依赖模型话术。`before_tool_call` 已经阻断了真实写入，`blockReason` 会约束模型给出正确回复。即使模型说错话，数据也不会被改。

**Q: 确认后外部有人改了配置怎么办？**
A: 执行前会重读当前快照并比较 `beforeHash`，发现漂移后进入 `conflict` 状态，不会写入。

**Q: 重复点确认会重复写入吗？**
A: 不会。已完成的 plan 幂等返回，不触发重复写入。

**Q: 为什么不直接在 skill 里实现审批？**
A: 因为不能假设所有 skill 都会正确实现。平台侧统一拦截是底线保障，不依赖 skill 作者的质量和自觉性。

**Q: 当前支持哪些写入口类型？**
A: 支持 `exec`（命令行写命令）和 `tool`（直接工具调用）两种 binding 类型，同时支持 shell 和 HTTP 两种 invocation 执行方式。

---

## 十七、总结

OpenClaw Safe Mutation 的核心价值是：

1. **平台集中兜底** — 不依赖 skill 作者质量，统一在 hook 层拦截高风险写操作
2. **冻结真实 payload** — 审批对象就是即将执行的真实写入，没有二次推导
3. **配置化低成本接入** — 新增保护对象只需增加一条 binding 配置
4. **写前防冲突、写后强验证** — 确认后仍需通过 `beforeHash` 冲突检测和回读验证
5. **确定性执行** — 确认后由系统代码执行冻结 plan，不让模型参与 payload 决策

这套方案已经在 mock-full-reduction-config 样例上完成了完整闭环验证（typecheck + 3 层自动化测试 + 手工干跑），下一步是接入真实业务写工具，逐步覆盖高风险写 skill。
