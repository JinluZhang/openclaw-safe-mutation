export interface Agent1024HookResponse {
  decision: "allow" | "block";
  reason?: string;
  updatedArguments?: unknown;
  directReply?: string;
  extraContext?: Record<string, unknown>;
}

export interface Agent1024PreToolUsePayload {
  event?: "PRE_TOOL_USE";
  paas: string;
  conversationId: string;
  source?: string;
  userMis: string;
  accountId?: string;
  toolName: string;
  toolCallId?: string;
  toolArguments: unknown;
  timestamp?: number;
  requestId?: string;
  traceId?: string;
}

export interface Agent1024MessageContentItem {
  type: "TEXT" | "IMAGE" | "FILE" | "AUDIO" | string;
  content: string;
  fileUrl?: string;
}

export interface Agent1024UserMessageReceivedPayload {
  event?: "USER_MESSAGE_RECEIVED";
  paas: string;
  conversationId: string;
  source?: string;
  userMis: string;
  accountId?: string;
  messageType?: "SINGLE_MESSAGE" | "GROUP_MESSAGE" | "TT" | string;
  dxGroupId?: number | null;
  dxRobotId?: number;
  messageContent: string;
  contentItems?: Agent1024MessageContentItem[];
  timestamp?: number;
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
