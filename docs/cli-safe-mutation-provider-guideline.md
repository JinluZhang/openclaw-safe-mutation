# CLI 写操作接入 Safe Mutation 的提供方改造方案

## 背景

OpenClaw 上会长期运行大量由不同团队提供的 skill 和 CLI。很多 CLI 原本面向人工命令行使用者设计，强调“好输入”和“少参数”，例如：

```bash
wm-merchant poi shipping-time-edit --all-days 10:00-22:00
wm-merchant poi shipping-time-edit --day 1-5:10:00-22:00 --day 6:off --day 7:off
```

这种形态对人工很友好，但对平台级写保护并不理想。Safe Mutation 要做的是在写入前冻结真实变更、展示 diff、等待确认、执行前做冲突检测、写后回读验证。它需要的是“最终会写什么”，而不是“用户用什么便捷语法表达这次修改”。

`wm-merchant poi shipping-time-edit` 是一个典型例子：用户输入的是 `--all-days` 或多个 `--day`，但真实写入接口需要的是 7 天二维数组 `shipping_time_x`。如果写保护直接适配原始命令，就必须复刻 CLI 内部解析规则，或依赖 dry-run 旁路推导最终 payload。这会让平台保护逻辑和业务 CLI 逻辑强耦合，不利于后续批量接入几十个写命令。

## 目标

推动 CLI 提供方为写操作提供一层稳定、机器友好、可冻结的写入契约，使 OpenClaw 能以低成本统一接入写保护。

具体目标：

- Agent 能稳定生成命令，不依赖人类帮助文本和隐式上下文。
- AI 能明确知道目标对象、最终 payload、是否实际写入。
- Safe Mutation 能确定性计算 diff、冻结 plan、检测冲突、回读验证。
- CLI 提供方仍可保留面向人工的便捷命令，但需要额外提供面向自动化的 canonical 命令或模式。

## 为什么需要改 CLI

### 1. 写保护确认的是最终结果，不是输入语法

用户确认时真正关心的是“营业时间会从 A 变成 B”，而不是“命令里传了 `--day 1-5:...`”。便捷参数通常只是中间表达：

- `--all-days 10:00-22:00` 会展开为 7 天相同配置。
- `--day 1-5:10:00-22:00 --day 6:off --day 7:off` 会展开为周一到周日的完整数组。
- 跨零点、追加、排序、去重等规则还可能进一步改变最终 payload。

如果 CLI 只暴露中间表达，写保护就需要重复实现这些业务规则。重复实现会带来两个风险：

- 平台推导出的 diff 和 CLI 真正提交的 payload 不一致。
- CLI 后续升级解析规则后，写保护侧悄悄失效。

因此写操作必须能暴露或接收 canonical payload，也就是最终写入对象。

### 2. AI 需要稳定的机器契约，不适合依赖 help 文本

大模型能读懂自然语言帮助，但不能把它当作安全边界。`--help` 文本适合解释，不适合作为写保护系统的机器契约。

对 AI 友好的 CLI 应当提供：

- 明确的 JSON schema 或字段 schema。
- 稳定的 JSON 输入和输出。
- 机器可读错误码。
- dry-run 或 preview 能输出最终 payload。
- 正式写入时能直接接收同一份 payload。

这样 AI 只负责把用户意图转成候选 payload，写保护系统负责冻结、确认和执行，职责边界清晰。

### 3. Agent 需要幂等和可恢复的写入流程

Agent 执行写命令经常处在多轮对话、工具失败、网络重试、用户补充信息交织的环境里。一个适合 Agent 的写 CLI 应当支持：

- 同一 payload 重复提交行为可预期。
- dry-run 不产生副作用。
- 写后可以用 read 命令读回同结构 payload。
- 错误输出能区分参数错误、权限错误、业务规则错误、临时网络错误。
- 目标对象必须显式传入，不能只依赖当前 session。

隐式 session 门店、自然语言式参数、混合人类输出会增加 Agent 误操作和恢复成本。

### 4. 平台保护需要统一适配，而不是每个命令写定制逻辑

当前 Safe Mutation 的通用闭环是：

1. 匹配写入口。
2. 提取目标对象和本次写入意图。
3. 读取当前状态。
4. 构造最终 writePayload。
5. 展示 diff 并等待确认。
6. 确认后执行冻结写入。
7. 回读验证。

如果每个 CLI 都只提供人类友好的参数语法，平台就需要为每个命令写一个专用 parser 或 dry-run resolver。几十个命令接入后，维护成本会不可控。

所以提供方应当把业务解析收敛在 CLI 内部，并向平台暴露稳定的 canonical 接口。

## 推荐改造模式

### 模式 A：保留便捷命令，新增 canonical 写命令

以营业时间为例，保留现有命令：

```bash
wm-merchant poi shipping-time-edit --all-days 10:00-22:00
wm-merchant poi shipping-time-edit --day 1-5:10:00-22:00 --day 6:off --day 7:off
```

新增机器友好的命令：

```bash
wm-merchant poi shipping-time-apply \
  --poi-id 24015104 \
  --shipping-time-x-json '[["10:00-22:00"],["10:00-22:00"],["10:00-22:00"],["10:00-22:00"],["10:00-22:00"],[],[]]'
```

要求：

- `--poi-id` 必填，不依赖当前 session 推断目标。
- `--shipping-time-x-json` 是最终 7 天二维数组。
- 输出 JSON，成功时包含 `code=0` 和最终生效 payload 或可验证标识。
- 失败时包含稳定 `error_code`、`message`、`retryable`。

`shipping-time-edit` 可以继续面向人工和普通 Agent 做便捷解析，但最终应转调 `shipping-time-apply`，或者至少能输出一份可交给 `shipping-time-apply` 的 payload。

### 模式 B：新增 preview/compile 命令，把便捷参数编译成 canonical payload

对于仍希望保留 `--all-days` / `--day` 作为 Agent 输入的场景，可以提供不写入的 compile 命令：

```bash
wm-merchant poi shipping-time-compile \
  --all-days 10:00-22:00 \
  --poi-id 24015104 \
  --format json
```

输出：

```json
{
  "code": 0,
  "poi_id": 24015104,
  "payload": {
    "shipping_time_x": [
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"],
      ["10:00-22:00"]
    ]
  }
}
```

Safe Mutation 可以用 compile 结果冻结 payload，再执行 canonical apply。

这个模式适合复杂命令：CLI 提供方继续负责业务语法解析，平台不复制业务逻辑。

### 模式 C：读写使用同构 payload

读命令应当能返回和写命令一致的结构。例如：

```bash
wm-merchant poi shipping-time-get --poi-id 24015104 --format json
```

输出：

```json
{
  "code": 0,
  "poi_id": 24015104,
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

这样 diff、conflict 检测和 verify 都可以直接比较 `payload.shipping_time_x`，不需要解析人类字段或业务展示字段。

## 对 `wm-merchant poi shipping-time` 的具体建议

建议提供方做如下改造：

1. 新增 `shipping-time-get`
   - 必填或显式支持 `--poi-id`。
   - 输出 `payload.shipping_time_x`。
   - 不输出混合表格或富文本。

2. 新增 `shipping-time-compile`
   - 接收现有 `--all-days`、`--day`、`--poi-id`。
   - 只做参数解析和本地校验，不写入。
   - 输出最终 `payload.shipping_time_x`。

3. 新增 `shipping-time-apply`
   - 接收 `--poi-id` 和 `--shipping-time-x-json`。
   - 不再接收 `--all-days` / `--day` 这类便捷语法。
   - 正式调用后端写接口。

4. 现有 `shipping-time-edit` 保持兼容
   - 面向人工和历史 skill。
   - 内部可以走 compile + apply。
   - 但在 OpenClaw 写保护场景中推荐逐步禁用直接写入，改走 canonical apply。

推荐的 Safe Mutation 接入路径：

```text
用户意图
  -> skill/Agent 调 shipping-time-compile
  -> 得到 canonical payload
  -> 发起 shipping-time-apply 写请求
  -> Safe Mutation 拦截 apply
  -> 读取 shipping-time-get
  -> 展示 before/after diff
  -> 用户确认
  -> 执行冻结 apply
  -> 回读 shipping-time-get 验证
```

## CLI 提供方通用接入规范

写 CLI 如果希望被 Agent 和 Safe Mutation 低成本接入，应满足以下规范：

1. 目标对象显式
   - 写命令必须能显式传 `--poi-id`、`--store-id`、`--resource-id` 等目标 ID。
   - 不建议只依赖“当前 session 选中对象”。

2. payload 可冻结
   - 正式写命令应能接收完整 JSON payload。
   - 如果保留便捷参数，必须提供 compile/preview 输出最终 payload。

3. 读写同构
   - read 输出结构应和 write payload 尽量一致。
   - 不要让写保护从表格、中文描述、包装字段中反向推导业务值。

4. 输出稳定 JSON
   - 提供 `--format json` 或专用 JSON 命令。
   - JSON 中不要混入 ANSI 颜色、表格、人类说明文本。

5. 错误机器可读
   - 至少包含 `code`、`error_code`、`message`、`retryable`。
   - 能区分 `AUTH_REQUIRED`、`PERMISSION_DENIED`、`INVALID_ARGUMENT`、`BUSINESS_RULE_REJECTED`、`TEMPORARY_FAILURE`。

6. dry-run 无副作用
   - dry-run/compile 不能调用真实写接口。
   - dry-run 输出必须说明是否经过服务端校验。

7. schema 可发现
   - 提供 `schema` 子命令或固定 schema 文档。
   - 标明字段类型、字段路径、是否必填、枚举值、展示 label。

8. 幂等和验证友好
   - 同一 payload 重复执行不应产生额外副作用。
   - 写成功后 read 应能在短时间内读到一致 payload；若存在异步生效，应返回任务 ID 或明确状态。

## 当前 Safe Mutation 框架对 CLI 的友好性评估

当前框架对“简单 CLI 写命令”已经比较友好：

- 支持 `cli` matcher，用 `commandPrefix` 匹配普通命令。
- 支持 positional 和 flag 抽取。
- 支持 schema 中的 `flag` 自动映射到字段。
- 支持 read/verify invocation 模板。
- 支持未知 flag、危险 shell 语法、包装命令 fail closed。
- 支持写前读、生成 diff、审批、执行前 conflict、写后 verify。

这适合以下命令形态：

```bash
wm-merchant product set-status <merchantId> <productId> --status 0
shopctl settings set <storeId> --shop-name "xxx"
```

也就是“一个 flag 基本对应一个字段”的写操作。

但它对复杂 CLI 还不够友好，主要短板是：

1. 缺少 payload resolver
   - 现在 CLI matcher 只能把 flag 解析成字段 patch。
   - 对 `--all-days`、`--day`、`--add-rule` 这类需要业务编译的参数不友好。

2. 缺少列表/数组路径的 field schema 能力
   - 当前 `readPath` 是点号路径，更适合对象字段。
   - 对“7 天数组”“规则列表按 ID 替换”“批量 item 增删”表达力不足。

3. 执行层对 CLI 默认执行原始命令
   - CLI binding 的 `writeInvocation` 默认冻结原始 command。
   - 如果 plan 冻结的是 canonical payload，但执行的还是原始便捷命令，就存在二者漂移风险。

4. normalizer 能力偏基础
   - 目前支持 strip/pick/rename/compose。
   - 对解析 JSON 字符串字段、排序数组、按 key 归一化列表、时间格式标准化等场景还不够。

5. binding 配置会变重
   - 几十个 CLI 接入后，每条 binding 都写 read/write/schema 模板，重复度会很高。
   - 缺少可复用的 CLI 契约模板和内置适配器。

## 框架侧建议优化

为了更好适配几十个 CLI 式读写命令，建议 Safe Mutation 框架分阶段增强。

### 第一阶段：先定义 provider contract，不急着扩核心

优先推动 CLI 提供方按本文规范提供 canonical read/compile/apply。这样 Safe Mutation 只需要接稳定 payload，框架改动最小，收益最大。

同时补一组文档和模板：

- `cli-safe-mutation-contract.md`
- `canonical-read-compile-apply` 示例。
- 标准 JSON schema 示例。
- binding 配置样板。

### 第二阶段：增加 `compileInvocation` / `payloadResolver`

在 binding 中支持：

```json
{
  "compile": {
    "kind": "shell",
    "commandTokens": ["wm-merchant", "poi", "shipping-time-compile", "..."],
    "resultPath": "payload"
  }
}
```

含义：

- matcher 负责识别命令和目标对象。
- compile 负责把原始 CLI 参数转成 canonical payload。
- plan 冻结 compile 输出的 payload。
- write 使用 canonical write invocation，而不是原始命令。

这能兼容还没拆成 apply 的老命令，也能避免把业务 parser 写进 TypeScript 框架。

### 第三阶段：增强 normalizer

增加通用 normalizer：

- `parseJsonField`：把某个字符串字段 JSON.parse 后放到目标 path。
- `sortArray`：数组排序。
- `sortArrayByKey`：对象数组按 key 排序。
- `mapPath`：把包装结构转为 canonical payload。
- `timeRangeNormalize`：可选，标准化 `9:00` / `09:00`。

这样 read 输出不完全同构时，也能用配置归一化。

### 第四阶段：提供 CLI binding 模板和测试工具

接入几十个 CLI 后，最需要的是减少每条 binding 的样板成本。建议提供：

- binding 生成器：输入 commandPrefix、resource flag、read command、schema，生成配置。
- dry-run 验证器：给一组命令样例，输出 matcher 是否命中、resourceId、payload、diff。
- contract test harness：验证 read/compile/apply 三者同构。

对 CLI 提供方的验收可以自动化：

```text
compile(input args) -> payload A
apply(payload A)
read() -> payload B
assert normalize(A) == normalize(B)
```

## 推进口径

对 CLI 提供方可以这样表述：

> 我们不是要求每个 CLI 都内建审批流程，也不是要求提供方理解 OpenClaw 的 plan 状态机。我们只需要 CLI 暴露一个稳定、机器可读、可冻结的写入契约：读能读到 canonical payload，预览能把便捷参数编译成 canonical payload，写能直接提交 canonical payload。审批、diff、冲突检测、回读验证都由平台统一完成。

这样改造的收益是：

- 提供方只维护一次业务解析逻辑。
- Agent 不需要猜最终写入体。
- 平台不需要为每个 CLI 写专用 parser。
- 用户确认的内容和实际写入内容一致。
- 后续几十个 CLI 可以按同一套契约批量接入。

