# wm-merchant shipping-time-edit 接入写保护分析

## 背景

目标命令：

```bash
wm-merchant poi shipping-time-edit
```

当前诉求是评估该本地 CLI 命令是否能方便接入 OpenClaw Safe Mutation 写保护，并判断如果将它改造成符合 [The CLI Spec](https://clispec.dev/) 的 CLI，是否能更顺畅地接入写保护。

结论先行：

- `wm-merchant poi shipping-time-edit` 当前已经具备一些 agent-friendly 能力，例如 `--dry-run` 输出 JSON，并能产出最终 `shipping_time_x`。
- 但它仍然不够适合作为 Safe Mutation 的直接受保护写入口，因为正式写命令暴露的是人类便捷语法，而写保护需要冻结最终 canonical payload。
- clispec 能显著改善 schema 发现、结构化输出、错误处理、非交互和幂等性，但它不是写保护协议。
- 公司批量推动几十个 CLI 适配时，建议采用两层标准：`clispec` 作为 agent-friendly 基线，`Safe Mutation Provider Contract` 作为写保护接入基线。

## 相关项目机制

本仓库的 Safe Mutation 当前是 hook-first 方案。核心流程是：

1. `before_tool_call` 拦截受保护写入口。
2. 通过 `protectedMutations` binding 识别写命令、目标对象、字段 schema、读写验证路径。
3. 首次写请求不执行，而是读取当前状态，构造并冻结 `MutationPlan`。
4. 向用户展示 diff 并等待确认。
5. 用户确认后，系统执行冻结 plan，而不是让模型重新生成写命令。
6. 执行前再次读取当前状态，和 plan 中的 `beforeHash` 比较，避免审批后状态漂移。
7. 执行冻结写 invocation。
8. 写后回读验证，确认最终状态和冻结 payload 一致。

重要不变量：

- 保护对象必须通过 `protectedMutations` 显式配置。
- 只登记写工具名不够，必须有明确 read binding。
- 用户确认的是冻结 plan，不是自然语言意图。
- 确认后执行的是冻结 payload，不允许模型二次改写。
- 写后必须回读验证。

## 本地命令当前现状

本地 `wm-merchant` 版本：

```bash
wm-merchant version 0.2.18
```

`shipping-time-edit` help 显示的核心形态：

```bash
wm-merchant poi shipping-time-edit \
  (--all-days <时段> | --day <天:时段> [...]) \
  [--poi-id <门店ID>] \
  [--dry-run]
```

典型用法：

```bash
wm-merchant poi shipping-time-edit --all-days 10:00-22:00 --poi-id 24015104

wm-merchant poi shipping-time-edit \
  --day 1-5:10:00-22:00 \
  --day 6:off \
  --day 7:off \
  --poi-id 24015104
```

当前命令具备的优点：

- 支持 `--poi-id`，可以显式指定目标门店。
- 支持 `--dry-run`，不会实际写入。
- pipe 或 JSON 模式下会输出结构化 JSON。
- `--dry-run` 会输出最终二维数组 `shipping_time_x`。
- 错误输出包含 `code`、`message`、`error_info.reason`、`retryable`、`fix_fields`、`agent_hint` 等字段。
- 正式写入前已经在 CLI 内部完成本地格式校验，包括时段格式、重叠、每天最多 5 个时段、不能全周休息等规则。

`--dry-run` 示例输出：

```json
{
  "dry_run": true,
  "server_validated": false,
  "poi_id": 24015104,
  "shipping_time_x": [
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"]
  ],
  "preview": {
    "周一": ["10:00-22:00"],
    "周二": ["10:00-22:00"],
    "周三": ["10:00-22:00"],
    "周四": ["10:00-22:00"],
    "周五": ["10:00-22:00"],
    "周六": ["10:00-22:00"],
    "周日": ["10:00-22:00"]
  },
  "agent_hint": "本地预检通过（未经服务端校验）。确认无误后去掉 dry_run 参数重新执行即可正式提交。服务端可能对时段格式、重叠等做进一步校验，提交失败时请根据错误提示修正。"
}
```

内部实现上，正式写入最终调用：

```python
client.update_shipping_time(shipping_time_x, wm_poi_id=poi_id)
```

后端接口是：

```text
POST /gw/skills/poi/edit_shipping_time
```

其中营业时间通过 query string 参数 `shippingTimeX` 传递，值是 JSON 编码后的二维数组。

## 1. 当前不方便接入保护的原因

### 1.1 写保护需要最终 payload，而当前正式写命令暴露的是便捷语法

Safe Mutation 需要冻结的是“最终会写什么”，不是“用户用什么语法表达这次修改”。

当前命令对人类友好：

```bash
--all-days 10:00-22:00
--day 1-5:10:00-22:00 --day 6:off --day 7:off
```

但真实写入 payload 是：

```json
{
  "shipping_time_x": [
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"],
    ["10:00-22:00"],
    [],
    []
  ]
}
```

如果 Safe Mutation 直接适配 `shipping-time-edit`，就必须理解：

- `--all-days` 如何展开为 7 天数组。
- `--day 1-5` 如何展开到周一到周五。
- 未指定的天如何默认为休息。
- `off`、`休息`、空字符串如何处理。
- 多时段如何拆分、排序、校验重叠。
- 哪些输入会被 CLI 本地拒绝，哪些会被服务端拒绝。

这些都是业务解析规则，不应该复制到平台写保护层。

### 1.2 当前 Safe Mutation 的 CLI matcher 只能做 flag 到字段 patch 的映射

当前 `cli` matcher 的适配能力更适合这种命令：

```bash
shopctl settings set <storeId> --shop-name "xxx"
wm-merchant product set-status <productId> --status 0
```

也就是一个 flag 基本对应一个字段。

但 `shipping-time-edit` 的 `--all-days` 和 `--day` 不是最终业务字段，而是编译输入。当前 matcher 不会自动调用 `--dry-run` 来拿 canonical payload。

结果是：

- 如果把 `--all-days` 映射成字段，diff 展示会变成“all_days 从 A 到 B”，不是用户真正关心的 7 天营业时间。
- 如果把 `--day` 映射成字段，重复 flag、范围语法、未指定天默认休息都不好表达。
- 如果平台自己把这些参数编译成 `shipping_time_x`，就和 CLI 内部逻辑形成重复实现。

### 1.3 当前 CLI binding 默认冻结原始 shell 命令

当前 Safe Mutation 的 `cli` matcher 匹配成功后，`writeInvocation` 默认保存原始命令：

```text
wm-merchant poi shipping-time-edit --all-days 10:00-22:00 --poi-id 24015104
```

这意味着即使 plan 中展示的是平台推导出的 canonical payload，确认后实际执行的仍是原始便捷命令。

风险是：

- plan 中冻结的 payload 和 CLI 重新执行时内部编译结果不一致。
- CLI 在审批等待期间自动更新，解析规则发生变化。
- 原始命令依赖环境、session 或默认值，确认后执行上下文发生变化。

写保护更理想的形态是确认后执行：

```bash
wm-merchant poi shipping-time-apply \
  --poi-id 24015104 \
  --shipping-time-x-json '<冻结 JSON>'
```

也就是执行冻结 payload 本身，而不是重新解释便捷参数。

### 1.4 read 和 write 不是同构结构

当前读命令：

```bash
wm-merchant poi status --format json
```

返回的是类似：

```json
{
  "wm_poi_id": 24015104,
  "shipping_time": "[[\"10:00-22:00\"], ...]",
  "status": 1,
  "valid": 1
}
```

而写入侧使用的是：

```json
{
  "shipping_time_x": [
    ["10:00-22:00"],
    ...
  ]
}
```

这里存在两个问题：

- read 的 `shipping_time` 是 JSON 字符串，不是 parsed array。
- read 字段名和 write 字段名不一致。

Safe Mutation 当前可以做一些 strip/pick/rename 类 normalizer，但缺少通用的 `parseJsonField` 能力。要做写后验证，就需要额外 normalizer 或专用适配逻辑。

### 1.5 `--poi-id` 可选，不符合保护入口最佳实践

`shipping-time-edit` 当前允许不传 `--poi-id`，使用 session 中的当前门店。

这对人类命令行体验友好，但对写保护不友好：

- plan 必须绑定明确目标对象。
- 审批展示必须明确“哪个门店会被修改”。
- ACK 执行时不能依赖当前 session 仍然选中同一门店。
- 不同 agent 步骤之间 session 可能被切换。

受保护写入口应该强制显式传入 `--poi-id`。

### 1.6 手写命令没有进入统一 schema

本地执行：

```bash
wm-merchant schema poi.shipping-time-edit
```

返回未找到 `poi` 领域。

这说明当前 `wm-merchant schema` 主要覆盖动态 OpenAPI 命令，未覆盖 `poi shipping-time-edit` 这种手写 Typer 命令。

对批量接入几十个 CLI 来说，如果 schema 不覆盖所有命令，平台仍要解析 help 或写人工 binding，规模化成本会很高。

### 1.7 auto-update 会引入审批期间版本漂移

`wm-merchant` 默认启动时会检查自动更新。写保护链路中有两个阶段：

- plan 生成时解析命令、读取 schema、构造 payload。
- 用户确认后执行冻结 write invocation。

如果这两个阶段之间 CLI 自动更新，可能出现：

- 参数含义变化。
- 编译规则变化。
- 输出结构变化。
- 错误结构变化。

受保护执行路径应固定版本，或至少统一加 `--no-auto-update`。

## 2. 符合 clispec 后仍可能不方便接入保护的原因

The CLI Spec 0.1 的核心原则包括：

- Structured Output：支持 JSON 等结构化输出。
- Schema Introspection：提供机器可读 schema。
- Stderr/Stdout Separation：数据走 stdout，诊断走 stderr。
- Non-Interactive by Default：默认非交互。
- Idempotent Operations：操作尽量幂等。
- Bounded Output：输出有界，支持分页/字段选择。

这些原则对 agent 很重要，但它们不等价于写保护协议。

### 2.1 `mutating: true` 只能说明会写，不能说明怎么保护

clispec schema 可以标注某个命令是 mutating。

但 Safe Mutation 还需要知道：

- 目标资源 ID 从哪个参数抽取。
- 对应 read 命令是什么。
- read 结果里哪个路径是可比较 payload。
- 写后 verify 用哪个命令。
- 哪些字段可以展示 diff。
- 哪些字段是 volatile，需要剥离。
- 确认后应该执行哪个 canonical write。

这些不是 clispec 的基础语义。

### 2.2 参数 schema 不等于 canonical payload schema

`shipping-time-edit` 的参数 schema 可以描述：

```json
{
  "--all-days": {
    "type": "string"
  },
  "--day": {
    "type": "array",
    "items": { "type": "string" }
  }
}
```

但写保护真正需要的是：

```json
{
  "payload": {
    "shipping_time_x": {
      "type": "array",
      "minItems": 7,
      "maxItems": 7,
      "items": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^([01]\\d|2[0-3]):[0-5]\\d-((?:[01]\\d|2[0-3]):[0-5]\\d|24:00)$"
        }
      }
    }
  }
}
```

前者是输入语法，后者才是可冻结 payload。

### 2.3 JSON 输出不代表读写同构

clispec 要求机器可读输出，但不会要求 read 和 write 使用同一结构。

对写保护来说，下面两种都符合 JSON 输出，但接入难度完全不同：

不友好：

```json
{
  "shipping_time": "[[\"10:00-22:00\"]]"
}
```

友好：

```json
{
  "payload": {
    "shipping_time_x": [["10:00-22:00"]]
  }
}
```

写保护需要后者。

### 2.4 dry-run 不一定等于可执行 plan

clispec 建议破坏性操作支持 `--dry-run`。

但 dry-run 仍需区分：

- 是否只做本地解析。
- 是否经过服务端校验。
- dry-run 输出是否就是正式写入 payload。
- 正式写命令是否能直接接收 dry-run 输出。

当前 `shipping-time-edit --dry-run` 明确标注 `server_validated:false`，这是很好的信息，但还不足以完成保护闭环。

### 2.5 幂等原则不等于冲突检测

clispec 的幂等原则能降低 agent 重试风险，但 Safe Mutation 还需要审批期间的冲突检测。

理想情况下，CLI 或后端应支持：

- `resource_version`
- `updated_at`
- `etag`
- `expected_hash`
- `idempotency_key`

没有这些也可以靠 Safe Mutation 执行前重新 read 并比较 `beforeHash`，但这只是平台层兜底，不是 CLI 契约本身。

### 2.6 clispec 不约束审批与执行同源

写保护最核心的问题是：

> 用户确认看到的 payload，必须就是最终执行的 payload。

clispec 不会强制要求：

- preview 输出和 apply 输入同构。
- apply 只能接收 canonical payload。
- 确认后禁止重新解释便捷参数。

因此，即使 CLI 完全符合 clispec，如果仍然只提供 `shipping-time-edit --all-days ...` 作为正式写入口，写保护仍然会不顺。

## 3. 改造成非常方便接入写保护的形态

推荐把 `shipping-time-edit` 保留为人类便捷命令，但不要作为主要受保护写入口。

新增一组三段式 canonical 命令：

```text
shipping-time-get
shipping-time-compile
shipping-time-apply
```

### 3.1 shipping-time-get

只读命令，返回和写 payload 同构的 parsed JSON。

示例：

```bash
wm-merchant --no-auto-update poi shipping-time-get \
  --poi-id 24015104 \
  --output json
```

输出：

```json
{
  "poi_id": 24015104,
  "schema_version": "poi.shipping_time.v1",
  "resource_version": "optional-version-or-hash",
  "payload": {
    "shipping_time_x": [
      ["09:00-21:00"],
      ["09:00-21:00"],
      ["09:00-21:00"],
      ["09:00-21:00"],
      ["09:00-21:00"],
      [],
      []
    ]
  }
}
```

要求：

- 必须显式传 `--poi-id`。
- stdout 只输出 JSON。
- 不返回未解析的 `shipping_time` 字符串作为主要字段。
- 如果保留 raw 字段，放到 `raw` 或 `debug`，不要作为保护比较路径。

### 3.2 shipping-time-compile

只编译便捷参数，不写入。

示例：

```bash
wm-merchant --no-auto-update poi shipping-time-compile \
  --poi-id 24015104 \
  --day 1-5:10:00-22:00 \
  --day 6:off \
  --day 7:off \
  --output json
```

输出：

```json
{
  "poi_id": 24015104,
  "schema_version": "poi.shipping_time.v1",
  "server_validated": false,
  "payload": {
    "shipping_time_x": [
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      [],
      []
    ]
  },
  "warnings": []
}
```

要求：

- 接收现有 `--all-days` / `--day` 便捷语法。
- 不调用真实写接口。
- 输出正式写命令可直接接收的 canonical payload。
- 明确 `server_validated`。
- 编译逻辑复用 `shipping-time-edit` 当前内部解析函数，避免规则分叉。

### 3.3 shipping-time-apply

正式写入命令，只接收 canonical payload。

示例：

```bash
wm-merchant --no-auto-update poi shipping-time-apply \
  --poi-id 24015104 \
  --shipping-time-x-json '[["10:00-22:00"],["10:00-22:00"],["10:00-22:00"],["10:00-22:00"],["10:00-22:00"],[],[]]' \
  --idempotency-key idem_xxx \
  --output json
```

输出：

```json
{
  "code": 0,
  "poi_id": 24015104,
  "schema_version": "poi.shipping_time.v1",
  "idempotency_key": "idem_xxx",
  "message": "营业时间修改成功",
  "payload": {
    "shipping_time_x": [
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      [],
      []
    ]
  }
}
```

要求：

- `--poi-id` 必填。
- `--shipping-time-x-json` 必填。
- 不接收 `--all-days` / `--day`，避免正式写入口再次解释便捷语法。
- 支持 `--idempotency-key`。
- 如果后端支持，增加 `--expected-resource-version` 或 `--expected-hash`。
- 成功输出包含最终提交 payload，便于审计。

### 3.4 shipping-time-edit 保持兼容

保留现有命令：

```bash
wm-merchant poi shipping-time-edit --all-days 10:00-22:00 --poi-id 24015104
```

但内部建议改成：

```text
shipping-time-edit
  -> compile
  -> apply
```

同时文档明确：

- 面向人类和历史脚本可继续使用 `shipping-time-edit`。
- OpenClaw Safe Mutation 接入时应走 `shipping-time-apply`。
- 后续可逐步要求 agent 不直接调用 `shipping-time-edit` 做正式写入。

## 推荐 Safe Mutation binding 形态

如果新增 `shipping-time-apply`，Safe Mutation 的 binding 会非常简单。

示例：

```json
{
  "id": "wm-merchant.poi.shipping-time.apply",
  "protectedToolName": "wm-merchant.poi.shipping-time",
  "match": {
    "kind": "cli",
    "toolName": "exec",
    "commandPrefix": [
      "wm-merchant",
      "--no-auto-update",
      "poi",
      "shipping-time-apply"
    ],
    "resourceIdTemplate": "{{flag:--poi-id}}",
    "mutableFlags": {
      "--shipping-time-x-json": {
        "fieldId": "shipping_time_x"
      }
    },
    "ignoredFlags": ["--output", "--format", "--idempotency-key"]
  },
  "fieldSchema": {
    "kind": "inline",
    "fields": [
      {
        "fieldId": "shipping_time_x",
        "flag": "--shipping-time-x-json",
        "label": "营业时间",
        "description": "周一到周日的营业时段二维数组",
        "valueType": "json",
        "readPath": "payload.shipping_time_x",
        "requiredInPayload": true,
        "display": {
          "format": "json"
        }
      }
    ]
  },
  "read": {
    "kind": "shell",
    "commandTokens": [
      "wm-merchant",
      "--no-auto-update",
      "poi",
      "shipping-time-get",
      "--poi-id",
      "{{resourceId}}",
      "--output",
      "json"
    ]
  },
  "verify": {
    "kind": "shell",
    "commandTokens": [
      "wm-merchant",
      "--no-auto-update",
      "poi",
      "shipping-time-get",
      "--poi-id",
      "{{resourceId}}",
      "--output",
      "json"
    ]
  }
}
```

如果当前框架要支持“拦截旧 `shipping-time-edit` 并用 `--dry-run` 编译 payload”，则框架侧需要新增 `compileInvocation` 或 `payloadResolver`：

```json
{
  "compile": {
    "kind": "shell",
    "commandTokens": [
      "{{commandPrefixTokens}}",
      "{{originalArgsTokens}}",
      "--dry-run",
      "--output",
      "json"
    ],
    "resultPath": "payload"
  },
  "write": {
    "kind": "shell",
    "commandTokens": [
      "wm-merchant",
      "--no-auto-update",
      "poi",
      "shipping-time-apply",
      "--poi-id",
      "{{resourceId}}",
      "--shipping-time-x-json",
      "{{payloadJson:shipping_time_x}}",
      "--output",
      "json"
    ]
  }
}
```

但更推荐优先改 CLI，少改平台核心。

## 面向公司几十个 CLI 的通用改造规范

### 基线一：clispec 兼容

所有 CLI 应满足：

- 支持 `--output json` 或 `-o json`。
- pipe 时默认输出 JSON。
- 数据只走 stdout，日志、进度、诊断走 stderr。
- 错误为结构化 JSON，并有稳定 `error.kind`。
- 提供 `schema` 命令，能发现命令、参数、输出字段、错误类型、`mutating` 标记。
- 默认非交互，非 TTY 下不阻塞等待输入。
- 写操作尽量幂等。
- 列表输出支持 `--limit`、`--offset` 或 cursor，以及 `--fields`。

### 基线二：Safe Mutation Provider Contract

所有受保护写 CLI 额外满足：

1. 目标对象显式
   - 写命令必须显式传 `--poi-id`、`--store-id`、`--resource-id` 等。
   - 受保护写入口不允许只依赖当前 session。

2. 读写同构
   - read 输出和 write payload 使用同一 canonical 结构。
   - 不要求字段完全相同，但保护比较路径必须一致。

3. payload 可冻结
   - 正式写命令必须能直接接收完整 canonical payload。
   - 如果保留便捷参数，必须提供 compile/preview 输出最终 payload。

4. preview/compile 无副作用
   - 只做本地解析或服务端校验，不写入。
   - 必须标明 `server_validated`。

5. apply 不重新解释便捷语法
   - apply 只接收 canonical payload。
   - 用户确认展示的 payload 与 apply 输入同源。

6. 支持幂等与冲突检测
   - 支持 `--idempotency-key`。
   - 尽量支持 `--expected-resource-version` / `--expected-hash`。

7. schema 覆盖写保护信息
   - 标明 `mutating`。
   - 标明 `resource_arg`。
   - 标明 `payload_arg`。
   - 标明对应 read/verify 命令。
   - 标明 payload schema。

8. 版本稳定
   - 受保护执行链路禁用 auto-update，或固定 CLI 版本。
   - schema 中包含 `schema_version` 和 CLI `version`。

## 推荐推进话术

可以对 CLI 提供方这样解释：

> 我们不是要求每个 CLI 都内建审批流程，也不是要求提供方理解 OpenClaw 的 plan 状态机。我们只需要 CLI 暴露一个稳定、机器可读、可冻结的写入契约：读能读到 canonical payload，预览能把便捷参数编译成 canonical payload，写能直接提交 canonical payload。审批、diff、冲突检测、回读验证都由平台统一完成。

收益：

- CLI 提供方只维护一份业务解析逻辑。
- Agent 不需要猜最终写入体。
- 平台不需要为每个 CLI 写专用 parser。
- 用户确认的内容和实际写入内容一致。
- 后续几十个 CLI 可以按同一套契约批量接入。

## 最终建议

对 `wm-merchant poi shipping-time-edit`：

1. 短期可以用 `--dry-run` 辅助理解最终 payload，但不建议把 `shipping-time-edit` 直接作为长期受保护写入口。
2. 优先新增 `shipping-time-get`、`shipping-time-compile`、`shipping-time-apply`。
3. `shipping-time-apply` 作为唯一推荐受保护写入口。
4. `shipping-time-edit` 保留人类便捷体验，内部复用 compile + apply。
5. 受保护执行统一加 `--no-auto-update`。
6. read 输出改为 parsed `payload.shipping_time_x`，避免保护层解析 `shipping_time` 字符串。

对公司 CLI 改造：

1. clispec 是 agent-friendly 基线。
2. Safe Mutation Provider Contract 是写保护接入基线。
3. 对复杂写命令，必须提供 canonical read / compile / apply。
4. 对简单写命令，可以一个 flag 对应一个字段，但仍要保证目标对象显式、读写同构、结构化错误和幂等。

