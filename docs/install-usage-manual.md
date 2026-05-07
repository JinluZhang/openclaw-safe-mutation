# OpenClaw Safe Mutation 安装与使用手册

## 1. 组件说明

这套 demo 由两部分组成：

- `safe-mutation` 插件：平台侧 hook，负责拦截受保护写请求、冻结 `MutationPlan`、发送确认、执行写前冲突检测和写后回读验证。
- `mock-full-reduction-config` skill：样例业务写 skill，位于 `skills/mock-full-reduction-config`，通过 `scripts/mock_full_reduction_cli.py` 读写本地 mock 满减配置。

安装到 OpenClaw 实例后，业务 agent 仍然按普通 skill 方式调用 CLI；`safe-mutation` 插件在 `before_tool_call` 阶段识别匹配的 `exec` 写命令并接管审批流程。

当前代码已按 Agent 化复用目标拆成两层：

- `src/core/`：框架无关的 Safe Mutation core，包含 registry、`MutationPlan`、状态机、diff/hash、审批命令、执行器、文本 ACK 解析，以及读/写/验证 adapter 接口。
- `src/openclaw/`：OpenClaw adapter，包含 `before_tool_call` hook 和 `FileMutationPlanStore`。

旧的 `src/*`、`src/commands/*`、`src/adapters/*`、`src/channels/*`、`src/hooks/*` 导入路径仍作为 re-export 兼容层随包发布。OpenClaw 入口已经直接使用 `src/core/**` 和 `src/openclaw/**`，后续接 1024Agent 时应新增独立 adapter，而不是复制 core 安全语义。

## 2. 目录约定

OpenClaw 默认目录：

```text
~/.openclaw/
  openclaw.json
  workspace/
    skills/
      mock-full-reduction-config/
        SKILL.md
        scripts/mock_full_reduction_cli.py
        data/mock_full_reduction_state.json
```

插件可通过两种方式加载：

- CLI 安装到 OpenClaw 插件目录。
- 通过 `plugins.load.paths` 指向本仓库或已分发的插件目录。

批量部署时建议统一使用绝对路径，不依赖 `~` 是否被配置解析器展开。

## 3. 构建发布包

在本仓库执行：

```bash
npm install
npm run typecheck
npm test
npm pack
```

`npm pack` 会生成类似：

```text
openclaw-safe-mutation-0.1.0.tgz
```

当前 `package.json` 已把 `openclaw.entry.ts`、`openclaw.plugin.json`、`src/`、`docs/`、`skills/` 和 `README.md` 放入打包范围。

打包前可以用下面命令确认新拆分目录会进入包：

```bash
npm pack --dry-run
```

期望在 `Tarball Contents` 中看到：

```text
src/core/...
src/openclaw/...
src/adapters/...        # re-export compatibility files
src/commands/...        # re-export compatibility files
src/hooks/...           # re-export compatibility files
```

## 4. 单实例安装

下面以默认 OpenClaw 目录为例。

### 4.1 安装插件

方式 A：使用 OpenClaw 插件安装命令。

```bash
openclaw plugins install /path/to/openclaw-safe-mutation-0.1.0.tgz
```

或直接安装本地目录：

```bash
openclaw plugins install /path/to/openclaw-safe-mutation
```

如果本机已经安装过同名插件，使用 `--force` 覆盖：

```bash
openclaw plugins install --force /path/to/openclaw-safe-mutation-0.1.0.tgz
```

由于 Safe Mutation 需要执行配置里的 read/write/verify shell invocation，OpenClaw 安装器可能会检测到 `child_process` 并阻断安装。确认安装来源可信后，本地联调可显式加上 unsafe 安装开关：

```bash
openclaw plugins install --force --dangerously-force-unsafe-install /path/to/openclaw-safe-mutation-0.1.0.tgz
```

这只绕过安装期静态危险代码拦截；受保护写路径仍由插件自己的 registry、plan、ACK 和 verify 流程控制。生产部署应只对可信构建产物使用该开关，并记录包 hash 或 git commit。

本地联调如果希望每次改代码后立即生效，也可以使用链接安装：

```bash
openclaw plugins install --force --link --dangerously-force-unsafe-install /path/to/openclaw-safe-mutation
```

方式 B：使用 `plugins.load.paths` 加载本地目录。

在 `~/.openclaw/openclaw.json` 中加入：

```json5
{
  plugins: {
    enabled: true,
    allow: ["safe-mutation"],
    load: {
      paths: ["/opt/openclaw/plugins/openclaw-safe-mutation"]
    },
    entries: {
      "safe-mutation": {
        enabled: true,
        config: {
          dataDir: "/var/lib/openclaw/safe-mutation"
        }
      }
    }
  }
}
```

如果不配置 `protectedMutations`，插件不会启用任何受保护 binding。生产接入真实 skill 时必须显式配置自己的 binding，包括字段 schema、读 invocation 和写入口匹配规则。

### 4.2 安装 mock skill

把本仓库里的 skill 复制到 OpenClaw workspace：

```bash
mkdir -p ~/.openclaw/workspace/skills
rsync -a /path/to/openclaw-safe-mutation/skills/mock-full-reduction-config \
  ~/.openclaw/workspace/skills/
chmod +x ~/.openclaw/workspace/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py
```

验证 CLI：

```bash
python3 ~/.openclaw/workspace/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py read --poiid 10001 --format json
python3 ~/.openclaw/workspace/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --help
python3 ~/.openclaw/workspace/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py schema --format json
```

### 4.3 重启 OpenClaw

修改插件或 skill 后重启 OpenClaw gateway / app。重启后检查：

```bash
openclaw plugins list
```

期望能看到 `safe-mutation` 已加载并启用。

也可以检查插件详情或配置：

```bash
openclaw plugins inspect safe-mutation
openclaw config get plugins.entries.safe-mutation
```

## 5. 使用流程

### 5.1 读取配置

用户可以问：

```text
查看门店 10001 的满减配置
```

agent 应使用：

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py read --poiid 10001 --format json
```

### 5.2 修改配置

用户可以问：

```text
把门店 10001 的第一档满减优惠从 15 改成 14
```

agent 会发起类似写命令：

```bash
python3 skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --poiid 10001 --tier-1-discount 14 --format json
```

`safe-mutation` 会拦截这次写命令，不会立即写入。系统会在原会话回推确认文本，包含：

- planId
- 当前状态
- 原始请求
- 系统理解
- 门店
- before / after diff
- 确认和取消方式

同时，被阻断的工具调用会把 `SAFE_MUTATION_APPROVAL_SENT` 作为 `blockReason` 返回给模型。当前不再通过 `reply_dispatch` 吞掉普通 assistant final，因此模型应只给用户一个简短状态说明：

```text
已生成变更确认单，点击确认后系统会自动执行。
```

这条普通 assistant final 不表示已经写入；真正执行仍然只由确认消息对应的 ACK 触发。

当前文本 fallback 可以回复：

```text
确认
```

系统会直接执行冻结 plan，并返回最终状态。用户也可以回复：

```text
取消
```

如果同一个审批人有多个 pending plan，文本 fallback 需要回复：

```text
确认 plan_xxx
取消 plan_xxx
```

未来或渠道侧如果把确认消息渲染成按钮/卡片，可以把 `planId` 作为隐藏句柄放入回调载荷，让用户点击“确认”或“取消”；后端仍然走同一套 plan 状态、审批身份和过期校验。

## 6. 批量部署建议

### 6.1 推荐发布结构

把插件和 skill 固化到一个内部发布目录，例如：

```text
/opt/openclaw-safe-mutation-release/
  plugin/
  skills/mock-full-reduction-config/
```

每台实例执行：

```bash
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
WORKSPACE="${OPENCLAW_WORKSPACE:-$OPENCLAW_HOME/workspace}"

mkdir -p "$WORKSPACE/skills"
rsync -a /opt/openclaw-safe-mutation-release/skills/mock-full-reduction-config \
  "$WORKSPACE/skills/"
chmod +x "$WORKSPACE/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py"
```

插件建议使用 `openclaw plugins install` 安装相同版本的 `.tgz`，或者用配置管理系统统一写入 `plugins.load.paths`。

### 6.2 配置管理要求

批量实例至少统一以下配置：

- `plugins.enabled: true`
- `plugins.allow` 包含 `safe-mutation`
- `plugins.entries.safe-mutation.enabled: true`
- `plugins.entries.safe-mutation.config.dataDir` 指向每台实例独立可写目录
- workspace 下存在 `skills/mock-full-reduction-config/SKILL.md`
- `mock_full_reduction_cli.py` 可执行，且运行环境有 `python3`

不要让多台实例共享同一个 mock `data/mock_full_reduction_state.json` 文件，除非它们在同一个文件锁或外部状态服务下运行。这个 demo state 文件是本地验证用，不是分布式存储。

### 6.3 版本与回滚

建议为每次部署记录：

- 插件包版本或 git commit
- skill 目录版本或 checksum
- `openclaw --version`
- `openclaw plugins list` 输出

回滚时同时回滚插件和 skill。只回滚其中一个可能导致 binding、CLI flag、字段目录不一致。

## 7. 1024Agent Webhook 本地联调与部署配置

1024Agent 适配层提供 HTTP webhook 入口，用于配置到 1024Agent 平台的 Webhook 回调页面。当前实现包含两个拦截类事件：

```text
POST /webhook/safe-mutation/pre-tool-use
POST /webhook/safe-mutation/user-message-received
GET  /webhook/safe-mutation/healthz
```

平台配置时：

- `PRE_TOOL_USE` 事件填写 `/webhook/safe-mutation/pre-tool-use`
- `USER_MESSAGE_RECEIVED` 事件填写 `/webhook/safe-mutation/user-message-received`
- 调用类型选择 HTTP 回调
- 超时时间使用 5000ms
- 本服务默认错误策略是返回 `decision=block`；如需要按平台 fail-open 语义放行，可在启动时设置 `AGENT1024_WEBHOOK_FAIL_OPEN=1`

### 7.1 本地启动

本地联调默认监听 10086：

```bash
npm run dev:agent1024-webhook
```

启动后可以用下面命令确认服务可用：

```bash
curl -sS http://localhost:10086/webhook/safe-mutation/healthz
```

期望返回：

```json
{"ok":true}
```

`pre-tool-use` smoke test：

```bash
curl -sS -X POST http://localhost:10086/webhook/safe-mutation/pre-tool-use \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "PRE_TOOL_USE",
    "paas": "wm",
    "conversationId": "conv-local",
    "userMis": "zhangjinlu",
    "toolName": "bash_execute",
    "toolCallId": "call-local",
    "toolArguments": {"command": "echo hello"},
    "timestamp": 1778110000000
  }'
```

未配置受保护 binding 时，期望返回：

```json
{"decision":"allow"}
```

### 7.2 本地密钥与环境配置

不要把 1024 API Key 写入代码、文档、`.gitignore` 或任何会提交到 git 的文件。推荐在仓库本地创建不受版本管理的环境目录：

```bash
mkdir -p .agent1024
chmod 700 .agent1024
touch .agent1024/test.env
chmod 600 .agent1024/test.env
grep -qxF '.agent1024/' .git/info/exclude || printf '%s\n' '.agent1024/' >> .git/info/exclude
```

测试环境配置写入 `.agent1024/test.env`：

```bash
AGENT1024_SHELL_EXEC_BASE_URL=https://1024.inf.test.sankuai.com
AGENT1024_SHELL_EXEC_API_KEY=<test-api-key>
AGENT1024_WEBHOOK_PORT=10086
AGENT1024_WEBHOOK_PATH_PREFIX=/webhook/safe-mutation
AGENT1024_APPROVAL_CALLBACK_URL=http://localhost:10086/webhook/safe-mutation/user-message-received
AGENT1024_APPROVAL_CARD_METHOD=POST
```

启动时加载本地配置：

```bash
set -a
source .agent1024/test.env
set +a
npm run dev:agent1024-webhook
```

当前 shell exec client 的默认 Base URL 是测试环境 `https://1024.inf.test.sankuai.com`。后续 stage/prod 环境不要改代码，新增本地 env 文件覆盖即可：

```text
.agent1024/stage.env
.agent1024/prod.env
```

示例：

```bash
set -a
source .agent1024/stage.env
set +a
npm run dev:agent1024-webhook
```

### 7.3 1024 Shell Exec 接口配置

Safe Mutation 在 1024Agent 下执行冻结 plan 时，会通过 `Agent1024ShellExecClient` 调用 1024 shell exec 接口：

```text
POST /openapi-v3/shell/exec
Header: X-API-Key: <api-key>
```

请求体包含：

```json
{
  "command": "python3 /path/to/script.py",
  "workdir": "/path/to",
  "timeout": 60000,
  "mis": "zhangjinlu"
}
```

对应环境变量：

- `AGENT1024_SHELL_EXEC_BASE_URL`：1024 环境域名，测试环境为 `https://1024.inf.test.sankuai.com`
- `AGENT1024_SHELL_EXEC_API_KEY`：1024 API Key，运行时作为 `X-API-Key` 请求头发送
- `AGENT1024_SHELL_EXEC_TIMEOUT_MS`：默认命令超时，单位毫秒
- `AGENT1024_EXEC_MIS`：执行 shell exec 时传入的默认 MIS；如果 webhook payload 中已有 `userMis`，适配层会优先使用请求上下文
- `AGENT1024_APPROVAL_CALLBACK_URL`：审批卡片按钮回调地址，通常指向本服务的 `/webhook/safe-mutation/user-message-received`
- `AGENT1024_APPROVAL_CARD_METHOD`：审批卡片按钮请求方法，支持 `GET` 或 `POST`，默认 `POST`

### 7.4 部署注意事项

- 本地 `.agent1024/*.env` 必须保持在 `.git/info/exclude` 中，避免误提交密钥。
- 测试、stage、prod 使用不同 env 文件和不同 API Key；部署时由机器环境或密钥系统注入。
- 平台 Webhook 的“自定义请求头”可先留空；如果后续增加服务端鉴权，再在 webhook server 增加 header 校验并在平台配置对应 token。
- 如果回调服务部署在内网机器，确保 1024Agent 平台能访问对应 HTTP URL。

## 8. 生产接入真实 Skill 的差异

mock skill 现在也需要通过 `protectedMutations` 显式配置 binding；真实 skill 接入时同样应声明自己的字段 schema 和读写路径：

```json5
{
  plugins: {
    entries: {
      "safe-mutation": {
        enabled: true,
        config: {
          dataDir: "/var/lib/openclaw/safe-mutation",
          protectedMutations: [
            {
              id: "your-skill.exec",
              protectedToolName: "your-skill-write",
              match: {
                kind: "exec",
                toolName: "exec",
                pythonExecutable: true,
                scriptBasename: "your_cli.py",
                writeSubcommand: "write",
                readSubcommand: "read",
                resourceFlag: "--poiid",
                mutableFlagsFromSchema: true
              },
              fieldSchema: {
                kind: "shell",
                commandTokens: [
                  "{{pythonToken}}",
                  "{{scriptPath}}",
                  "schema",
                  "--format",
                  "json"
                ],
                resultPath: "fields"
              },
              read: {
                kind: "shell",
                commandTokens: [
                  "{{pythonToken}}",
                  "{{scriptPath}}",
                  "read",
                  "--poiid",
                  "{{resourceId}}",
                  "--format",
                  "json"
                ]
              },
              compareNormalizer: { kind: "none" }
            }
          ]
        }
      }
    }
  }
}
```

真实接入必须满足：

- 写入口能被 binding 精确匹配。
- 读 invocation 能返回当前完整状态。
- 所有 `mutableFlags` 都能映射到稳定字段 ID。
- 写后能通过 read 或 verify invocation 回读验证。
- 未知 flag、缺少目标 ID、缺少读配置时 fail closed。

## 9. 故障排查

### 插件没有拦截写命令

检查：

- `safe-mutation` 是否在 `openclaw plugins list` 中启用。
- 写命令是否通过 `exec` 发出，而不是直接修改文件。
- 脚本 basename 是否是 `mock_full_reduction_cli.py`。
- 子命令是否是 `write`。
- 是否包含 `--poiid`。

### 收不到确认消息

检查：

- 当前会话是否有可解析的 `sessionKey`。
- session store 里是否有原始渠道的 `deliveryContext` 或 `lastChannel` / `lastTo`。
- 渠道 outbound adapter 是否支持 `sendText`。

如果确认消息无法投递，工具调用会返回 `SAFE_MUTATION_APPROVAL_DELIVERY_FAILED`。模型不应引导用户直接确认这个 plan，因为用户可能没有看到 diff；应说明确认消息发送失败、没有发生变更，并建议稍后重试或联系管理员。

### 回复确认后进入 conflict

说明 plan 创建后，当前配置发生了变化。系统按 `beforeHash` 检测到漂移后不会写入。处理方式是重新发起修改，让系统基于最新快照生成新 plan。

### 回复确认后 failed

说明写调用或回读验证失败。检查 plan result 中的 `writeStdout`、`writeStderr`、`verifySnapshot`，以及 CLI 是否能手工读写。

## 10. 最小验收清单

每台实例安装后至少验证：

```bash
python3 ~/.openclaw/workspace/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py read --poiid 10001 --format json
python3 ~/.openclaw/workspace/skills/mock-full-reduction-config/scripts/mock_full_reduction_cli.py write --help
openclaw plugins list
```

再通过聊天入口验证：

1. 触发一次门店 `10001` 的满减修改。
2. 确认系统先回推 plan，而不是直接写入。
3. 回复 `取消`，确认状态为 `cancelled`。
4. 再触发一次修改并回复 `确认`。
5. 读取门店 `10001`，确认字段已变更。
