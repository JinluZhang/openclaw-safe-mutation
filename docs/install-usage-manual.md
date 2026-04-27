# OpenClaw Safe Mutation 安装与使用手册

## 1. 组件说明

这套 demo 由两部分组成：

- `safe-mutation` 插件：平台侧 hook，负责拦截受保护写请求、冻结 `MutationPlan`、发送确认、执行写前冲突检测和写后回读验证。
- `mock-full-reduction-config` skill：样例业务写 skill，位于 `skills/mock-full-reduction-config`，通过 `scripts/mock_full_reduction_cli.py` 读写本地 mock 满减配置。

安装到 OpenClaw 实例后，业务 agent 仍然按普通 skill 方式调用 CLI；`safe-mutation` 插件在 `before_tool_call` 阶段识别匹配的 `exec` 写命令并接管审批流程。

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

如果不配置 `protectedMutations`，插件会使用内置的 `mock-full-reduction.exec` binding。生产接入真实 skill 时应显式配置自己的 binding。

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

## 7. 生产接入真实 Skill 的差异

这个 mock skill 使用内置 binding 即可运行。真实 skill 接入时不要依赖内置 binding，应在插件配置里显式声明 `protectedMutations`：

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
                mutableFlags: {
                  "--your-flag": "your_field_id"
                }
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
              compareNormalizer: "none"
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

## 8. 故障排查

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

## 9. 最小验收清单

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
