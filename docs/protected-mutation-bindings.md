# 受保护变更 Binding 设计

## 目标

`protectedMutations` 是平台侧安全写入的配置入口。它把“要拦截哪个写入口”和“如何读当前状态”绑定在一起，避免 hook 在几百个 skill 里靠命令名、参数名或同名脚本去猜读操作。

核心规则：

- 写入口只有匹配到 binding 才会被规范化成 `ProtectedWriteRequest`。
- 每个 binding 必须提供字段 schema，可 inline，也可通过 shell/HTTP 机器可读 schema 动态发现。
- 每个 binding 必须声明 `read` invocation；没有读配置的受保护直接写工具会 fail closed。
- plan 会冻结字段 schema、`readInvocation`、`writeInvocation`、`verifyInvocation` 和最终 `writePayload`。
- ACK 后执行顺序固定为：读当前状态检测 conflict -> 写冻结 invocation -> 回读验证。
- 普通 `exec` 不会被全量拦截，只有匹配 binding 的写命令才进入审批。

## 配置形态

插件配置字段：

```json
{
  "protectedMutations": [
    {
      "id": "mock-full-reduction.exec",
      "protectedToolName": "mock-full-reduction-config",
      "match": {
        "kind": "exec",
        "toolName": "exec",
        "pythonExecutable": true,
        "scriptBasename": "mock_full_reduction_cli.py",
        "writeSubcommand": "write",
        "readSubcommand": "read",
        "preSubcommandFlags": {
          "--state-file": {
            "variableName": "stateFilePath",
            "pathValue": true,
            "defaultValue": {
              "kind": "relativeToScriptDir",
              "path": "../data/mock_full_reduction_state.json"
            }
          }
        },
        "ignoredWriteFlags": ["--format", "--state-file"],
        "resourceFlag": "--poiid",
        "mutableFlagsFromSchema": true
      },
      "fieldSchema": {
        "kind": "shell",
        "commandTokens": [
          "{{pythonToken}}",
          "{{scriptPath}}",
          "schema",
          "--format",
          "json"
        ],
        "resultPath": "fields"
      },
      "read": {
        "kind": "shell",
        "commandTokens": [
          "{{envAssignmentTokens}}",
          "{{pythonToken}}",
          "{{pythonOptionTokens}}",
          "{{scriptPath}}",
          "--state-file",
          "{{stateFilePath}}",
          "read",
          "--poiid",
          "{{resourceId}}",
          "--format",
          "json"
        ],
        "normalizer": "mockFullReductionRead"
      },
      "compareNormalizer": {
        "kind": "stripFields",
        "paths": ["version", "updated_at"]
      }
    }
  ]
}
```

如果 `protectedMutations` 省略，插件不会启用任何受保护 binding。实际生产接入必须显式配置自己的 binding。

## 字段说明

- `id`：binding 的稳定 ID，会写入 `executionContext.bindingId`。
- `protectedToolName`：规范化后的受保护业务写工具名。`exec` 写命令匹配后也会归一到这个名字。
- `match.kind`：当前支持 `exec` 和 `tool`。
- `match.resourceFlag` / `resourceParamPath`：目标业务对象 ID 的来源，当前样例是 `--poiid`。
- `fieldSchema`：字段 schema 来源，支持 `inline`、`shell`、`http`。schema 是机器可读契约，不解析人类 `--help` 文本。
- `match.mutableFlagsFromSchema`：为 `true` 时，schema 中带 `flag` 的字段自动成为可变 CLI flag。
- `match.mutableFlags`：CLI flag 到 `fieldId` 的显式映射。未知 flag 会 fail closed。
- `read`：读取当前状态的 invocation。当前支持 `shell` 和 `http`。
- `write`：direct tool binding 需要显式声明；exec binding 默认冻结原始 shell 写命令。
- `verify`：可选；省略时复用 `read`。
- `compareNormalizer`：写后验证比较前的规范化器，例如剥离 `version`、`updated_at`。

## Invocation

`shell` invocation 使用 `commandTokens` 模板，渲染后逐 token shell quote，避免拼接字符串造成参数边界错误。

常用模板变量：

- `{{resourceId}}`
- `{{payloadJson}}`，direct tool binding 中可用于 HTTP/shell write body
- `{{param:storeId}}` 这类 direct tool 顶层参数变量
- `{{envAssignmentTokens}}`
- `{{pythonToken}}`
- `{{pythonOptionTokens}}`
- `{{scriptPath}}`
- `{{scriptDir}}`
- `{{stateFilePath}}`
- `{{workdir}}`

`http` invocation 支持 `url`、`method`、`headers`、`body`、`resultPath` 和 `normalizer`。读接口必须返回 JSON object，或通过 `resultPath` 选中 JSON object。

## 接入步骤

1. 为写入口增加一条 binding，明确 `match`、目标 ID、`fieldSchema` 和 `read`。
2. 确保所有 `mutableFlags` 指向已注册的 schema `fieldId`，或使用 `mutableFlagsFromSchema`。
3. 如写后返回或读结果存在包装层，配置 `resultPath` 或 normalizer。
4. 为该 binding 增加 resolver/unit 测试，覆盖成功解析、未知 flag、缺必填参数。
5. 增加 integration 测试，覆盖成功、conflict、verify failed 和重复 ACK 幂等。

## Fail Closed 策略

- 匹配到受保护写命令但缺字段、未知 flag、缺读配置时阻断。
- 受保护直接写工具没有匹配 binding 时阻断。
- unrelated `exec` 不阻断。
- ACK 后读取到的当前快照 hash 与 plan 的 `beforeHash` 不一致时进入 `conflict`，不写。
