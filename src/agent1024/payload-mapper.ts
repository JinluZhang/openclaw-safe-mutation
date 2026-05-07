import type {
  Agent1024PreToolUsePayload,
  Agent1024UserMessageReceivedPayload
} from "./response-types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalize1024ToolArguments(
  toolArguments: unknown
): Record<string, unknown> {
  if (typeof toolArguments === "string") {
    return {
      command: toolArguments
    };
  }

  if (!isRecord(toolArguments)) {
    return {};
  }

  const command =
    getString(toolArguments.command) ??
    getString(toolArguments.cmd) ??
    getString(toolArguments.script);
  const workdir =
    getString(toolArguments.workdir) ?? getString(toolArguments.cwd);
  const approvedPlanId = getString(toolArguments.approvedPlanId);

  if (command) {
    return {
      ...toolArguments,
      command,
      ...(workdir ? { workdir } : {}),
      ...(approvedPlanId ? { approvedPlanId } : {})
    };
  }

  return {
    ...toolArguments
  };
}

export function getApprovedPlanIdFrom1024ToolArguments(
  toolArguments: unknown
): string | undefined {
  if (!isRecord(toolArguments)) {
    return;
  }

  return getString(toolArguments.approvedPlanId);
}

export function getStoreIdFrom1024ToolArguments(
  toolArguments: unknown
): string | undefined {
  if (!isRecord(toolArguments)) {
    return;
  }

  return getString(toolArguments.storeId);
}

export function build1024ApprovalPrincipal(
  payload: Pick<
    Agent1024PreToolUsePayload | Agent1024UserMessageReceivedPayload,
    "paas" | "conversationId" | "userMis" | "accountId"
  >
): string {
  return payload.accountId
    ? `${payload.paas}:${payload.conversationId}:${payload.accountId}:${payload.userMis}`
    : `${payload.paas}:${payload.conversationId}:${payload.userMis}`;
}

export function build1024RequestedBy(
  payload: Pick<Agent1024PreToolUsePayload, "userMis" | "accountId">
): string {
  return payload.accountId ? `${payload.accountId}:${payload.userMis}` : payload.userMis;
}
