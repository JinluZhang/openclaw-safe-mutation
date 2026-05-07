import {
  Agent1024RuntimeReadAdapter,
  Agent1024RuntimeVerifyAdapter,
  Agent1024RuntimeWriteAdapter,
  type Agent1024RuntimeExecutionClient
} from "./runtime-executor.js";
import { Agent1024ShellExecClient } from "./shell-exec-client.js";
import { MockAgent1024RuntimeExecutionClient } from "./mock-runtime-executor.js";
import { InMemoryAgent1024ApprovalNotifier } from "./notifier.js";
import { Agent1024SqliteMutationPlanStore } from "./sqlite-plan-store.js";
import { startAgent1024WebhookServer } from "./webhook-server.js";
import { ProtectedMutationRegistry } from "../core/mutation-registry.js";

function getPort(): number {
  const rawPort = process.env.AGENT1024_WEBHOOK_PORT ?? "10086";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid AGENT1024_WEBHOOK_PORT: ${rawPort}`);
  }

  return port;
}

function getRuntimeClient(): Agent1024RuntimeExecutionClient {
  const apiKey = process.env.AGENT1024_SHELL_EXEC_API_KEY;

  if (!apiKey) {
    console.warn(
      "AGENT1024_SHELL_EXEC_API_KEY is not set; using mock runtime client. Protected writes that require read/write execution will fail until a real client is configured."
    );
    return new MockAgent1024RuntimeExecutionClient();
  }

  const defaultTimeoutMs = process.env.AGENT1024_SHELL_EXEC_TIMEOUT_MS
    ? Number(process.env.AGENT1024_SHELL_EXEC_TIMEOUT_MS)
    : undefined;

  return new Agent1024ShellExecClient({
    apiKey,
    baseUrl: process.env.AGENT1024_SHELL_EXEC_BASE_URL,
    defaultTimeoutMs:
      defaultTimeoutMs !== undefined && Number.isFinite(defaultTimeoutMs)
        ? defaultTimeoutMs
        : undefined
  });
}

const runtimeClient = getRuntimeClient();
const runtimeOptions = {
  client: runtimeClient,
  paas: process.env.AGENT1024_PAAS,
  userMis: process.env.AGENT1024_EXEC_MIS,
  traceId: process.env.AGENT1024_TRACE_ID
};
const planStore = new Agent1024SqliteMutationPlanStore(
  process.env.AGENT1024_PLAN_DB_PATH ?? ":memory:"
);
const server = await startAgent1024WebhookServer(
  {
    planStore,
    readAdapter: new Agent1024RuntimeReadAdapter(runtimeOptions),
    writeAdapter: new Agent1024RuntimeWriteAdapter(runtimeOptions),
    verifyAdapter: new Agent1024RuntimeVerifyAdapter(runtimeOptions),
    notifier: new InMemoryAgent1024ApprovalNotifier(),
    protectedMutationRegistry: new ProtectedMutationRegistry([]),
    approvalCallbackUrl: process.env.AGENT1024_APPROVAL_CALLBACK_URL,
    approvalCardMethod:
      process.env.AGENT1024_APPROVAL_CARD_METHOD === "GET" ? "GET" : "POST"
  },
  {
    host: process.env.AGENT1024_WEBHOOK_HOST ?? "0.0.0.0",
    port: getPort(),
    pathPrefix:
      process.env.AGENT1024_WEBHOOK_PATH_PREFIX ?? "/webhook/safe-mutation",
    failOpenOnError: process.env.AGENT1024_WEBHOOK_FAIL_OPEN === "1",
    onError: (error, context) => {
      console.error("[agent1024-webhook]", context, error);
    }
  }
);

console.log(
  `Agent1024 Safe Mutation webhook listening on http://localhost:${server.port()}/webhook/safe-mutation`
);
console.log("Endpoints:");
console.log("  POST /webhook/safe-mutation/pre-tool-use");
console.log("  POST /webhook/safe-mutation/user-message-received");
console.log("  GET  /webhook/safe-mutation/healthz");

function shutdown(): void {
  void (async () => {
    await server.close();
    planStore.close();
    process.exit(0);
  })().catch((error: unknown) => {
    console.error("[agent1024-webhook] failed to shut down cleanly", error);
    process.exit(1);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
