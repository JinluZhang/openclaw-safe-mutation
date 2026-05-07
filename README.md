# OpenClaw Safe Mutation

这是一个用于验证 OpenClaw `hook-first` 安全写入兜底机制的实验插件。

当前实现的核心闭环是：

- 通过 `protectedMutations` registry 显式声明受保护写入口、目标对象抽取、字段 schema、读 invocation 和写/验证规则
- 拦截匹配 binding 的受保护写工具或等价 `exec` 写命令
- 从真实写请求中提取并冻结最终 `payload`
- 生成 `MutationPlan` 并把确认消息回推到原始会话
- 用户通过文本回复“确认”或“取消”完成审批
- 当前文本确认实现里，回复“确认”后由系统直接执行冻结 plan，不依赖模型再次重试原写命令
- 只有携带已批准 `planId` 且 `payload` 完全一致的重试请求才能放行
- ACK 后会用冻结的 read invocation 重新读取以检测 conflict，再执行冻结写 invocation，最后回读验证并落盘

## 当前范围

- 保护对象：由 `protectedMutations` 显式配置，mock 满减仅作为示例
- 写入口：直接工具调用和可识别的 `exec` 写命令
- 配置方式：默认不启用任何受保护 binding；生产接入通过 `protectedMutations` 显式声明 schema、读写路径和匹配规则
- 确认方式：会话内文本确认
- 审批身份：`channel + senderId`，`accountId` 作为可选增强
- 数据层：文件版 plan store + 工具调用适配器
- 字段范围：每条 binding 自带 inline / shell / HTTP 解析得到的字段 schema

重要约束：只把写工具名加入保护列表是不够的。每个受保护写路径必须有明确的 read binding；无法匹配 binding 的受保护直接写工具会 fail closed，不会靠命令名或参数猜读操作。

这个仓库当前验证的是平台侧统一兜底能力，不是面向 skill 作者的 `/mutate` 命令体系。

## 文档

- [架构说明](./docs/architecture.md)
- [概要技术设计](./docs/technical-design-overview.md)
- [受保护变更 Binding 设计](./docs/protected-mutation-bindings.md)
- [Safe Mutation 1024Agent 适配方案](./docs/safe-mutation-1024-adaptation-plan.md)
- [关键技术要点](./docs/key-technical-notes.md)
- [安装与使用手册](./docs/install-usage-manual.md)
- [验证方案](./docs/validation-plan.md)
- [历史方案归档](./docs/archive/)

## 项目结构

```text
openclaw-safe-mutation/
  docs/
    archive/
  src/
    core/
      adapters/
      channels/
      commands/
    openclaw/
      hooks/
    adapters/
    channels/
    commands/
    hooks/
  skills/
    mock-full-reduction-config/
  test/
    integration/
    seams/
    unit/
```

`src/core/` 是框架无关的 Safe Mutation 语义层，包含 registry、`MutationPlan` 状态机、审批命令、执行器、diff、hash、字段 schema、文本 ACK 解析和工具读写适配接口。`src/openclaw/` 是 OpenClaw 绑定层，包含 OpenClaw hook 和文件版 plan store。旧的 `src/*` 路径暂时保留为 re-export 兼容层，方便现有测试、配置和外部引用平滑迁移。

## 本地命令

```bash
npm install
npm run typecheck
npm test
```

## 现在不做的事

- 不接真实业务写工具
- 不实现飞书或微信 native card
- 不做多字段联合审批
- 不让模型参与确认后的 payload 决策
- 不把历史上的 `/mutate` 方案当成当前主流程
