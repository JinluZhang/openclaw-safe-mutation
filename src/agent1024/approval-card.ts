import type { MutationPlan } from "../core/intent-types.js";
import type { Agent1024PreToolUsePayload } from "./response-types.js";

export type Agent1024CardRequestMethod = "GET" | "POST";

export interface Agent1024CommonActionRequestData {
  url: string;
  method: Agent1024CardRequestMethod;
  params: Record<string, unknown>;
}

export interface Agent1024CommonAction {
  label: string;
  type: "REQUEST";
  data: Agent1024CommonActionRequestData;
}

export interface Agent1024CommonActionCard {
  cardType: "commonAction";
  cardContent: {
    submitId: string;
    intent: 1;
    text: string;
    positiveAction: Agent1024CommonAction;
    negativeAction: Agent1024CommonAction;
  };
}

export interface Agent1024ApprovalCardOptions {
  callbackUrl: string;
  method?: Agent1024CardRequestMethod;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function truncate(value: string, maxLength = 600): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(0, maxLength - 3))}...`
    : value;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "无";
  }

  if (typeof value === "string") {
    return truncate(value, 160);
  }

  return truncate(compactJson(value), 160);
}

function buildActionParams(params: {
  payload: Agent1024PreToolUsePayload;
  plan: MutationPlan;
  action: "confirm" | "cancel";
}): Record<string, unknown> {
  const messageContent =
    params.action === "confirm"
      ? `确认 ${params.plan.planId}`
      : `取消 ${params.plan.planId}`;

  return {
    event: "USER_MESSAGE_RECEIVED",
    paas: params.payload.paas,
    conversationId: params.payload.conversationId,
    userMis: params.payload.userMis,
    ...(params.payload.accountId ? { accountId: params.payload.accountId } : {}),
    messageType: "SINGLE_MESSAGE",
    messageContent,
    contentItems: [
      {
        type: "TEXT",
        content: messageContent
      }
    ],
    timestamp: Date.now(),
    safeMutation: {
      planId: params.plan.planId,
      action: params.action
    }
  };
}

export function renderAgent1024ApprovalCardText(plan: MutationPlan): string {
  const lines = [
    `### Safe Mutation 变更确认`,
    ``,
    `请确认你执行计划 \`${plan.planId}\`。`,
    ``,
    `- 状态：${plan.status}`,
    `- 对象：${plan.storeId}`,
    `- 系统理解：${plan.interpretationText}`,
    ``,
    `#### 变更内容`
  ];

  for (const diffItem of plan.diffItems) {
    lines.push(
      `- ${diffItem.label}: \`${formatValue(diffItem.before)}\` -> \`${formatValue(diffItem.after)}\``
    );
  }

  lines.push("", "确认后系统会执行冻结计划；取消则不会写入。");

  return lines.join("\n");
}

export function buildAgent1024ApprovalCard(params: {
  payload: Agent1024PreToolUsePayload;
  plan: MutationPlan;
  options: Agent1024ApprovalCardOptions;
}): Agent1024CommonActionCard {
  const method = params.options.method ?? "POST";

  return {
    cardType: "commonAction",
    cardContent: {
      submitId: params.plan.planId,
      intent: 1,
      text: renderAgent1024ApprovalCardText(params.plan),
      positiveAction: {
        label: "确认执行",
        type: "REQUEST",
        data: {
          url: params.options.callbackUrl,
          method,
          params: buildActionParams({
            payload: params.payload,
            plan: params.plan,
            action: "confirm"
          })
        }
      },
      negativeAction: {
        label: "取消执行",
        type: "REQUEST",
        data: {
          url: params.options.callbackUrl,
          method,
          params: buildActionParams({
            payload: params.payload,
            plan: params.plan,
            action: "cancel"
          })
        }
      }
    }
  };
}

export function serializeAgent1024Card(
  card: Agent1024CommonActionCard
): string {
  return `:::${JSON.stringify(card)}:::`;
}
