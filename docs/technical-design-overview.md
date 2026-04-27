# OpenClaw Safe Mutation 概要技术设计

## 摘要

OpenClaw Safe Mutation 的目标是在平台侧给高风险写操作加一层统一兜底：即使某个 skill 没有自己实现审批、diff、幂等和回读验证，只要它的写路径被纳入 `protectedMutations` 配置，最终写入就必须先经过统一 hook 拦截、冻结、确认和验证。

当前实现的核心结论：

- **写入前先冻结真实 payload**：第一次被拦截的写请求就是 skill 原本准备提交的结构化写入，系统直接冻结它，不让模型在确认后重新生成参数。
- **确认后由系统执行冻结 plan**：当前文本 ACK 链路中，用户确认后由确定性代码执行 `MutationPlan`，不依赖模型再次调用原写工具。
- **读写路径必须显式配置**：每个受保护写路径都必须有 binding，尤其是 read invocation；平台不能靠脚本名或参数名猜读操作。
- **写前防冲突、写后强验证**：确认后执行前重新读取当前状态并比较 `beforeHash`，写后必须回读验证最终状态。
- **普通 assistant final 不再被抑制**：工具被 block 后，模型仍可给用户一句简短说明；`blockReason` 会约束模型使用“已生成变更确认单，点击确认后系统会自动执行。”这类话术，不能暗示写入已完成。

对 skill owner 的影响是：业务 skill 可以继续按原方式发起读写工具调用；平台侧只需要为高风险写路径补齐 `protectedMutations` binding、字段目录和必要的读/写/验证适配。

## 1. 项目核心目的

OpenClaw Safe Mutation 是一个验证型插件，用来证明 OpenClaw 可以在平台侧提供统一的“安全写入兜底”能力。

它要解决的问题不是某一个业务 skill 怎么写得更规范，而是当 OpenClaw 上运行大量第三方或多人贡献的 skill 时，平台不能假设每个 skill 作者都会正确实现高风险写操作的审批、diff、幂等、冲突检测和回读验证。因此项目采用 hook-first 方案：所有匹配 `protectedMutations` binding 的写路径，最终都必须经过统一 hook 拦截，先按显式读配置读取当前状态并冻结真实写请求，再让用户确认，最后由确定性代码执行。

当前仓库用 `mock-full-reduction-config` 作为样例写工具，验证满减活动配置修改场景。这个样例不是最终业务目标，它只是用来证明平台侧统一拦截机制可行。

## 2. 核心设计判断

项目的关键判断是：写操作里最危险的不是模型是否理解了用户意图，而是最终到底提交了什么 payload。

因此系统不让模型在确认后重新生成写参数，也不从自然语言二次推导最终 payload。第一次真实写请求已经包含即将写入的结构化参数，hook 会直接把这份真实 payload 冻结为 `MutationPlan`，用户确认的也是这份即将发生的写入。

这带来几个设计原则：

| 设计原则 | 落地含义 |
| --- | --- |
| 平台侧 hook 是最终硬闸门 | skill 作者不需要显式接入一套审批协议，但受保护写入口必须经过 `before_tool_call` |
| 读路径必须显式声明 | 只注册写工具名不够；没有 matching binding 或 read 配置时 fail closed，即失败时阻断而不是放行 |
| `MutationPlan` 是唯一可信冻结对象 | 审批绑定 plan，不绑定自然语言描述，也不绑定模型二次解释 |
| ACK 不能携带新写入参数 | ACK 只表达“确认/取消这个 plan”，确认后只能执行冻结 `writePayload` |
| 写前必须防冲突 | 执行前重新读取当前状态并比较 `beforeHash`，不一致则 `conflict`，不写入 |
| 写后必须回读验证 | 不能只相信写接口返回成功，必须 verify/read 结果与冻结 payload 一致 |
| 审批身份绑定稳定的人 | 使用 `channel + senderId`，`accountId` 作为可选命名空间增强，不把 `sessionKey` 当作硬前提 |

## 3. 总体架构

系统由以下几层组成：

| 层次 | 核心模块 | 责任 |
| --- | --- | --- |
| 插件入口 | `openclaw.entry.ts` | 注册 OpenClaw hooks、加载 `protectedMutations` registry、发送确认消息、消费文本 ACK |
| 变更配置 | `src/mutation-registry.ts` | 显式声明写入口匹配、目标对象抽取、读/写/验证 invocation、normalizer 和字段映射 |
| 写请求识别 | `src/protected-write-request.ts` | 按 registry 把直接工具调用或等价 `exec` 写命令规范化为 `ProtectedWriteRequest` |
| 写入硬闸门 | `src/hooks/before-tool-call.ts` | 判断写请求是否必须阻断，或是否满足已批准 plan 的放行条件 |
| 计划冻结 | `src/protected-write-plan.ts` | 读取/接收写前快照，生成冻结 `MutationPlan`、diff、hash、TTL |
| 计划存储 | `src/plan-store.ts`、`src/file-plan-store.ts` | 持久化 plan，维护活跃计划查询和终态不可回跳规则 |
| 确认动作 | `src/commands/mutate-approve.ts`、`src/commands/mutate-cancel.ts` | 校验审批身份、推进状态、触发执行或取消；当前入口由 `before_dispatch` 解析“确认/取消”文本 |
| 执行器 | `src/executor.ts` | 写前冲突检测、调用写适配器、回读验证、写回最终状态 |
| 适配器 | `src/adapters/*`、`src/tool-backed-adapters.ts` | 隔离读、写、验证实现，当前样例接 mock CLI |
| 展示与输入 | `src/channels/text-render.ts`、`src/text-plan-actions.ts` | 渲染文本确认消息，解析“确认/取消”回复 |

## 4. 主流程

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"Inter, PingFang SC, Microsoft YaHei, sans-serif","primaryTextColor":"#0f172a","lineColor":"#64748b","clusterBkg":"#f8fafc","clusterBorder":"#cbd5e1","edgeLabelBackground":"#ffffff"}}}%%
flowchart TB
  subgraph S1["1. 请求识别"]
    direction LR
    A["用户请求修改"] --> B["Skill 发起工具调用"]
    B --> C["before_tool_call<br/>匹配 protectedMutations"]
    C --> D{"受保护写路径？"}
    D -->|否| Allow["放行<br/>普通工具继续执行"]
    D -->|配置缺失或解析失败| Block["阻断<br/>fail closed"]
    D -->|命中| ApprovedId{"带 approvedPlanId？"}
    ApprovedId -->|带| CheckPlan{"plan / storeId / payload<br/>全部匹配？"}
    CheckPlan -->|匹配| Allow
    CheckPlan -->|不匹配| Block
  end

  subgraph S2["2. 冻结计划"]
    direction LR
    ApprovedId -->|未带，首次写入| EntryKind{"写入口类型"}
    EntryKind -->|exec patch| Patch["readInvocation 读快照<br/>fieldChanges 合成 writePayload"]
    EntryKind -->|direct payload| Payload["使用工具 payload<br/>必要时补读 beforeSnapshot"]
    Patch --> Plan["MutationPlan<br/>冻结 beforeHash / writePayload / diff / executionContext"]
    Payload --> Plan
  end

  subgraph S3["3. 确认与 ACK"]
    direction LR
    Plan --> Send["发送确认消息<br/>diff + 确认/取消方式"]
    Send --> Delivered{"投递成功？"}
    Delivered -->|否| DeliveryFail["阻断 + DELIVERY_FAILED<br/>说明未发生变更"]
    Delivered -->|是| Sent["阻断 + APPROVAL_SENT<br/>assistant 只做短提示"]
    Sent --> AckInput["用户点击或回复<br/>确认 / 取消"]
    AckInput --> Ack["before_dispatch<br/>校验 approvalPrincipal"]
    Ack --> Action{"用户动作"}
    Action -->|取消| Cancel["cancelled<br/>返回取消结果"]
    Action -->|确认| Approved["approved<br/>executeMutationPlan(planId)"]
  end

  subgraph S4["4. 执行与验证"]
    direction LR
    Approved --> ReadNow["重新读取当前状态"]
    ReadNow --> Drift{"currentHash == beforeHash？"}
    Drift -->|否| Conflict["conflict<br/>不执行写入"]
    Drift -->|是| Write["执行冻结 writeInvocation"]
    Write --> Verify["verify/read 回读"]
    Verify --> Match{"回读 == writePayload？"}
    Match -->|是| Success["succeeded"]
    Match -->|否| Failed["failed"]
  end

  classDef input fill:#f8fafc,stroke:#94a3b8,color:#0f172a,stroke-width:1px;
  classDef gate fill:#fff7ed,stroke:#fb923c,color:#7c2d12,stroke-width:1.5px;
  classDef plan fill:#eef2ff,stroke:#6366f1,color:#312e81,stroke-width:1.5px;
  classDef ack fill:#ecfeff,stroke:#0891b2,color:#164e63,stroke-width:1.5px;
  classDef exec fill:#f0fdf4,stroke:#22c55e,color:#14532d,stroke-width:1.5px;
  classDef success fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px;
  classDef warn fill:#fffbeb,stroke:#f59e0b,color:#78350f,stroke-width:2px;
  classDef stop fill:#fee2e2,stroke:#ef4444,color:#7f1d1d,stroke-width:2px;
  class A,B,C,Allow input;
  class D,ApprovedId,CheckPlan,EntryKind,Delivered,Action,Drift,Match gate;
  class Patch,Payload,Plan plan;
  class Send,Sent,AckInput,Ack,Approved ack;
  class ReadNow,Write,Verify exec;
  class Success success;
  class Cancel,Conflict warn;
  class Block,DeliveryFail,Failed stop;
  style S1 fill:#f8fafc,stroke:#cbd5e1,stroke-width:1px
  style S2 fill:#f5f3ff,stroke:#c4b5fd,stroke-width:1px
  style S3 fill:#ecfeff,stroke:#67e8f9,stroke-width:1px
  style S4 fill:#f0fdf4,stroke:#86efac,stroke-width:1px
```

上图覆盖完整决策分支；下面是同一主流程的时序视角，重点展示首次拦截、确认消息投递、ACK 和执行器之间的先后关系。

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"Inter, PingFang SC, Microsoft YaHei, sans-serif","primaryTextColor":"#0f172a","actorBkg":"#eef2ff","actorBorder":"#6366f1","actorTextColor":"#312e81","activationBkgColor":"#e0f2fe","activationBorderColor":"#0284c7","sequenceNumberColor":"#475569","lineColor":"#64748b","noteBkgColor":"#fef3c7","noteTextColor":"#78350f"}}}%%
sequenceDiagram
  autonumber
  box rgb(248, 250, 252) 用户与模型
    participant User as 用户
    participant Agent as OpenClaw Agent / Skill
  end
  box rgb(239, 246, 255) OpenClaw 平台
    participant Hook as before_tool_call
    participant Registry as protectedMutations registry
    participant Store as MutationPlan Store
    participant Ack as before_dispatch
    participant Exec as Executor
  end
  box rgb(240, 253, 250) 外部通道与工具
    participant Channel as 原对话渠道
    participant Tool as 读写工具 / CLI
  end

  User->>Agent: 提出修改请求
  Agent->>Hook: 调用受保护写工具或 exec 写命令
  Hook->>Registry: 匹配 binding，解析目标对象和写入内容
  Note over Hook,Store: 首次写入只冻结真实 payload，不执行写入
  alt exec patch 入口
    Registry-->>Hook: fieldChanges + executionContext
    Hook->>Tool: 按 readInvocation 读取 beforeSnapshot
    Tool-->>Hook: beforeSnapshot
    Hook->>Hook: 构造完整 writePayload
  else direct tool payload 入口
    Registry-->>Hook: payload + executionContext
    opt 缺少 beforeSnapshot
      Hook->>Tool: 按 readInvocation 读取当前状态
      Tool-->>Hook: beforeSnapshot
    end
  end
  Hook->>Store: 创建或复用 pending_ack plan
  Hook->>Channel: 发送确认消息（diff + 确认/取消方式）
  alt 确认消息投递成功
    Channel-->>User: 展示确认单
    Hook-->>Agent: block + SAFE_MUTATION_APPROVAL_SENT
    Agent-->>User: 可选普通 final：已生成变更确认单
    User->>Ack: 点击或回复确认/取消
    Ack->>Store: 按 approvalPrincipal 查找并校验 plan
    alt 用户取消
      Ack->>Store: 标记 cancelled
      Ack-->>User: 返回取消结果
    else 用户确认
      Ack->>Store: 标记 approved
      Ack->>Exec: executeMutationPlan(planId)
      Exec->>Store: 读取冻结 plan
      Note over Exec,Tool: 确认后由系统执行冻结 plan，不等待模型重试
      Exec->>Tool: 按 readInvocation 重新读取当前状态
      Tool-->>Exec: currentSnapshot
      alt currentHash != beforeHash
        Exec->>Store: 标记 conflict
        Exec-->>Ack: 返回 conflict plan
      else currentHash == beforeHash
        Exec->>Tool: 按 writeInvocation 执行冻结写入
        Tool-->>Exec: writeResult
        Exec->>Tool: 按 verifyInvocation 或 readInvocation 回读
        Tool-->>Exec: verifySnapshot
        alt 验证通过
          Exec->>Store: 标记 succeeded
        else 验证失败
          Exec->>Store: 标记 failed
        end
        Exec-->>Ack: 返回终态 plan
      end
      Ack-->>User: 返回最终状态
    end
  else 确认消息投递失败
    Hook-->>Agent: block + SAFE_MUTATION_APPROVAL_DELIVERY_FAILED
    Agent-->>User: 说明确认消息发送失败，未发生变更
  end
```

当前文本 fallback 里，“回复确认”本身就是执行入口；生产渠道如果渲染为按钮，按钮回调也应落到同一套 ACK 逻辑。系统不会等待模型再次调用原写工具，也不会让模型在确认后重新决定 payload。`before_tool_call` 仍然保留 `approvedPlanId` 放行能力，用于支持未来结构化审批后由调用方重试同一写请求的形态。

这里有两个用户可见输出：

- **确认消息**：由插件直接发回原始会话，包含 plan、diff、确认/取消方式，是用户真正审批的对象。
- **普通 assistant final**：来自模型看到工具被 block 后的自然语言回复，只能做状态说明，不能替代确认消息，也不能承诺“我稍后帮你执行”。

## 5. 为什么要 hook-first

### 5.1 不依赖 skill 作者质量

只要某个写路径被加入 `protectedMutations` registry，它的写请求就会进入统一审批语义。skill 作者不需要自己实现 `/mutate`、diff、ACK、状态机、幂等和冲突检测。

### 5.2 冻结真实 payload

第一次被拦截的写请求就是 skill 原本准备提交的真实请求。系统直接冻结这份 payload，避免平台在自然语言里重新猜测字段和值。

### 5.3 接入成本低

新增保护对象的理想成本是：

1. 增加一条 mutation binding，声明写入口、目标对象、字段映射和 `read` invocation。
2. 如 direct tool 需要由文本 ACK 直接执行，再显式声明 `write` invocation。
3. 必要时补充 normalizer、`resultPath` 和 catalog 字段。

业务 skill 本身不需要重构成统一命令协议。

对 skill owner 来说，接入边界应尽量清晰：

- skill 继续负责表达业务能力和发起真实读写调用。
- 平台/配置维护者负责把高风险写入口加入 `protectedMutations`。
- binding 需要明确目标对象如何抽取、哪些字段可变、如何读取当前状态、如何执行冻结写入、如何回读验证。
- 对无法稳定读当前状态或无法回读验证的写路径，不应接入自动执行闭环，只能 fail closed 或走人工处理。

## 6. 安全闭环

项目用以下不变量保证写入安全：

- 受保护直接写工具如果没有匹配 binding 或缺少读配置，必须 fail closed，即失败时阻断而不是放行。
- unrelated `exec` 不拦截；只有匹配 binding 的写命令才进入审批。
- 没有 `approvedPlanId` 的受保护写请求一律阻断。
- 已批准请求必须满足 plan 存在、状态为 `approved`、未过期、`storeId` 一致、payload 与冻结 `writePayload` 完全一致。
- 同一 `storeId` 默认只能有一个活跃 plan；相同 payload 复用已有 plan，不同 payload 直接提示先处理已有计划。
- `pending_ack`、`approved`、`executing` 是活跃态，`succeeded`、`failed`、`conflict`、`cancelled`、`expired` 是终态。
- 终态 plan 不能回跳到活跃态。
- 执行前重新读取当前配置并比较 `beforeHash`，状态漂移进入 `conflict`，不写入。
- 写入后回读并和冻结 payload 比较，不一致进入 `failed`。
- 重复确认同一个已完成 plan 不会重复写入。

## 7. 确认与普通回复设计

首次写请求被 hook 阻断后，插件会把确认消息直接发回原始对话，然后阻断工具调用。这个时候模型仍可能在同一轮里尝试补一段普通 assistant 回复，例如“我已为你提交修改”。这种回复会误导用户，因为真实写入还没有发生。

当前策略是不再用 `reply_dispatch` 抑制普通 assistant final，而是让 `blockReason` 给模型一个明确的回复契约。安全性不依赖模型是否说对话术；真正的安全边界仍然是 `before_tool_call` 阻断、冻结 plan、ACK 校验和执行器验证。

- 说明本次写工具调用已被阻断，真实写入尚未发生。
- 说明冻结确认单已经由系统作为单独消息发回原始会话。
- 要求模型不要重试工具、不要重新生成 payload、不要重复完整确认说明。
- 要求模型不要说“回复同意我就帮你执行”，而是提示用户：已生成变更确认单，点击确认后系统会自动执行。

插件仍然用 `directConfirmationRunIds` 记录当前 run 是否已经投递过确认消息。这个集合不再用于吞 final，只用于防止模型在同一轮看到 tool error 后继续重试写工具，导致重复发送确认单。`agent_end` 兜底清理 `runId`，避免集合泄漏。

这个策略保留普通 assistant final，避免误抑制同一轮里的有用信息；代价是依赖模型遵循 `blockReason` 里的回复契约。`blockReason` 因此必须写得像给模型的操作指令，而不是只写内部错误原因。

如果确认消息投递失败，插件会返回 `SAFE_MUTATION_APPROVAL_DELIVERY_FAILED`。这时模型不能引导用户直接确认，因为用户可能没有看到 diff；正确语义是说明确认消息发送失败、没有发生变更，并建议稍后重试或联系管理员。

## 8. 当前能力边界

当前仓库覆盖的是最小可验证闭环：

- 保护工具：`mock-full-reduction-config`。
- 入口：默认内置 `mock-full-reduction.exec` binding，识别 mock CLI `exec` 写命令；受保护直接写工具若没有 binding 会 fail closed。
- 确认方式：确认消息发回原会话；当前文本 fallback 支持回复“确认/取消”，审批身份不绑定原 `sessionKey`。
- 执行路径：tool-backed adapter 支持冻结的 shell/http invocation；当前真实测试覆盖 mock CLI shell 场景。
- 存储：文件版 plan store。
- 展示：纯文本 diff。

当前不做的事情包括：真实业务写工具接入、飞书/微信 native card、多审批人会签、多字段复杂审批 UI、数据库级事务、依赖模型在确认后重试写入。

需要特别说明的是：当前样例的确认消息是纯文本，底层支持用户回复“确认/取消”。在生产渠道里可以把这条确认消息渲染成按钮或卡片，但按钮回调仍应落到同一套 plan 状态、审批身份和过期校验上。

## 9. 演进方向

后续从样例走向生产时，应保持核心不变量不变，只替换边缘实现：

- 文本 ACK 可以替换成飞书卡片按钮、审批回调或 Web UI。
- 文件 plan store 可以替换成数据库，但必须保留状态机、终态不可回跳和活跃 plan 查询语义。
- mock CLI binding 可以替换成真实业务 API/CLI binding，但仍要显式声明读前快照、写冻结 payload、回读验证。
- `planId` 可以从文本展示中隐藏，作为卡片 callback 的内部句柄使用，但最终仍要结合审批身份和 plan 状态校验。

核心架构不应改变：平台集中拦截，配置化读写路径，冻结真实 payload，用户确认冻结 plan，纯代码执行，写前冲突检测，写后回读验证。
