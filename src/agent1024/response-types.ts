export interface Agent1024HookResponse {
  decision: "allow" | "block";
  reason?: string;
  updatedArguments?: unknown;
  directReply?: string;
  extraContext?: Record<string, unknown>;
}

export interface Agent1024PreToolUsePayload {
  paas: string;
  conversationId: string;
  source?: string;
  userMis: string;
  accountId?: string;
  toolName: string;
  toolArguments: unknown;
  requestId?: string;
  traceId?: string;
}

export interface Agent1024UserMessageReceivedPayload {
  paas: string;
  conversationId: string;
  source?: string;
  userMis: string;
  accountId?: string;
  messageContent: string;
  requestId?: string;
  traceId?: string;
}

export function allowResponse(
  extraContext?: Record<string, unknown>
): Agent1024HookResponse {
  return {
    decision: "allow",
    ...(extraContext ? { extraContext } : {})
  };
}

export function blockResponse(reason: string): Agent1024HookResponse {
  return {
    decision: "block",
    reason
  };
}
