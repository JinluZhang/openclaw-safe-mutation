# AGENTS.md

## Project State

This repo validates a hook-first Safe Mutation workflow for protected business writes.

Current architecture:

- `src/core/`: framework-neutral Safe Mutation semantics.
  Includes mutation binding registry, `MutationPlan` state machine, diff/hash, approve/cancel commands, executor, text ACK parsing, and read/write/verify adapter interfaces.
- `src/openclaw/`: OpenClaw plugin adapter.
  Includes OpenClaw `before_tool_call` guard and file-backed plan store.
- `src/agent1024/`: 1024Agent adapter.
  Includes webhook callbacks, shell exec client, runtime adapters, approval card rendering, local webhook server, SQLite/MySQL plan stores, and notifier interfaces.
- legacy `src/*` re-export paths remain for compatibility. Prefer editing `src/core/**`, `src/openclaw/**`, or `src/agent1024/**` directly.

Core invariant: protected writes must be explicitly configured through `protectedMutations`. Never infer a read path from command names, script names, or flag names. Missing binding/read configuration should fail closed.

## Current Safe Mutation Flow

1. Tool call hits a platform hook.
2. Hook matches `protectedMutations`.
3. System reads current state using the configured read invocation.
4. System freezes a `MutationPlan`: `beforeHash`, `writePayload`, diff, schema snapshot, execution context.
5. Approval is delivered to the user.
6. User confirms or cancels the exact plan.
7. On confirm, deterministic code executes the frozen plan.
8. Before writing, executor re-reads current state and checks conflict by hash.
9. After writing, executor verifies by read/verify invocation.

Models must not regenerate or alter payload after approval.

## 1024Agent Notes

Webhook endpoints exposed by `src/agent1024/webhook-server.ts`:

- `POST /webhook/safe-mutation/pre-tool-use`
- `POST /webhook/safe-mutation/user-message-received`
- `GET /webhook/safe-mutation/healthz`

Local dev server:

```bash
set -a
source .agent1024/test.env
set +a
npm run dev:agent1024-webhook
```

Local env files live under `.agent1024/*.env` and must not be committed. The directory is excluded through `.git/info/exclude`, not tracked `.gitignore`.

Expected local test env keys:

```bash
AGENT1024_SHELL_EXEC_BASE_URL=https://1024.inf.test.sankuai.com
AGENT1024_SHELL_EXEC_API_KEY=<secret>
AGENT1024_WEBHOOK_PORT=10086
AGENT1024_WEBHOOK_PATH_PREFIX=/webhook/safe-mutation
AGENT1024_APPROVAL_CALLBACK_URL=http://localhost:10086/webhook/safe-mutation/user-message-received
AGENT1024_APPROVAL_CARD_METHOD=POST
```

Do not write real API keys into tracked files, docs, tests, or commit messages.

1024 shell execution uses `POST /openapi-v3/shell/exec` with header `X-API-Key`. The default base URL in code is the test environment, `https://1024.inf.test.sankuai.com`; stage/prod should override via env.

Approval card rendering uses `commonAction` card syntax:

```text
:::{"cardType":"commonAction","cardContent":{...}}:::
```

The renderer supports confirm/cancel `REQUEST` buttons that call back into `/webhook/safe-mutation/user-message-received`.

## Commands

Use these before considering work complete:

```bash
npm run typecheck
npm test
```

For 1024Agent-only changes:

```bash
npm run test:agent1024
```

For local webhook smoke testing:

```bash
curl -sS http://localhost:10086/webhook/safe-mutation/healthz
curl -sS -X POST http://localhost:10086/webhook/safe-mutation/pre-tool-use \
  -H 'Content-Type: application/json' \
  -d '{"event":"PRE_TOOL_USE","paas":"wm","conversationId":"conv-local","userMis":"zhangjinlu","toolName":"bash_execute","toolArguments":{"command":"echo hello"},"timestamp":1778110000000}'
```

## What Is Still Not Done

Known remaining gaps:

- real approval message delivery client is not implemented; current notifier is an interface plus in-memory test implementation.
- local webhook server currently uses an empty `ProtectedMutationRegistry`; real binding loading still needs to be wired.
- MySQL plan store has a driver abstraction, but no production wiring, DDL/migration, or integration test with a real database.
- 1024 `http` invocation execution is not fully wired through the shell exec client; prefer shell invocation for now or implement a dedicated HTTP runtime client.
- webhook request authentication is not implemented; add shared-token/header validation before stage/prod exposure.
- stage/prod env files and deployment process are not finalized.

## Editing Guidance

- Keep core behavior in `src/core/**` framework-neutral.
- Keep OpenClaw-specific behavior in `src/openclaw/**`.
- Keep 1024Agent-specific behavior in `src/agent1024/**`.
- Do not add abstractions unless they remove real duplication or preserve the core/adapter boundary.
- Do not commit generated `dist/`, `node_modules/`, `.agent1024/`, `.tgz`, logs, or local OS files.
- Preserve deterministic execution: after approval, execution must use the frozen plan, not model-generated retries.
