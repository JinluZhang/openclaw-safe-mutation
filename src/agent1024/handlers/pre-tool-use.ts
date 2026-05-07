import type { ReadAdapter } from "../../core/adapters/read-adapter.js";
import { renderMutationPlanForText } from "../../core/channels/text-render.js";
import type { ProtectedMutationRegistry } from "../../core/mutation-registry.js";
import type { MutationPlanStore } from "../../core/plan-store.js";
import {
  ensureProtectedWritePlan,
  type EnsureProtectedWritePlanResult
} from "../../core/protected-write-plan.js";
import { resolveProtectedWriteRequest } from "../../core/protected-write-request.js";
import {
  guardBeforeToolCall,
  type BeforeToolCallDecision
} from "../../openclaw/hooks/before-tool-call.js";
import type { Agent1024ApprovalNotifier } from "../notifier.js";
import {
  buildAgent1024ApprovalCard,
  serializeAgent1024Card
} from "../approval-card.js";
import {
  build1024ApprovalPrincipal,
  build1024RequestedBy,
  getApprovedPlanIdFrom1024ToolArguments,
  getStoreIdFrom1024ToolArguments,
  normalize1024ToolArguments
} from "../payload-mapper.js";
import {
  blockResponse,
  type Agent1024HookResponse,
  type Agent1024PreToolUsePayload
} from "../response-types.js";

const APPROVAL_REQUIRED_REASON =
  "This write path requires an approved mutation plan.";

export interface Agent1024PreToolUseHandlerDependencies {
  planStore: MutationPlanStore;
  readAdapter: ReadAdapter;
  notifier: Agent1024ApprovalNotifier;
  protectedMutationRegistry?: ProtectedMutationRegistry;
  approvalCallbackUrl?: string;
  approvalCardMethod?: "GET" | "POST";
  now?: () => number;
  planTtlMs?: number;
}

function approvalSentReason(result: EnsureProtectedWritePlanResult): string {
  const prefix = result.reusedExisting
    ? "SAFE_MUTATION_APPROVAL_REUSED"
    : "SAFE_MUTATION_APPROVAL_SENT";

  return `${prefix} planId=${result.plan.planId}.
The protected write tool call was blocked; the write has not been executed yet.
A frozen approval request has already been sent to the user via IM.
Do not retry the tool.
Do not regenerate the command or payload.
Reply briefly in the user's language: 已生成变更确认单，确认后系统会自动执行。`;
}

function blockedByOtherPlanReason(
  result: EnsureProtectedWritePlanResult
): string {
  return `SAFE_MUTATION_ACTIVE_PLAN_EXISTS planId=${result.plan.planId}.
The protected write tool call was blocked because another active mutation plan exists for the same store.
Do not retry the tool or execute a different payload until the user confirms or cancels the active plan.`;
}

function approvalDeliveryFailedReason(planId: string): string {
  return `SAFE_MUTATION_APPROVAL_DELIVERY_FAILED planId=${planId}.
The write was blocked and has not been executed.
The approval request could not be delivered through IM SDK.
Do not ask the user to confirm this plan because they may not have seen the diff.`;
}

async function markApprovalDelivery(params: {
  planStore: MutationPlanStore;
  result: EnsureProtectedWritePlanResult;
  delivery: Awaited<ReturnType<Agent1024ApprovalNotifier["sendApproval"]>>;
}): Promise<void> {
  const currentPlan = await params.planStore.get(params.result.plan.planId);

  if (!currentPlan) {
    return;
  }

  await params.planStore.tryTransition(
    currentPlan.planId,
    currentPlan.status,
    currentPlan.status,
    {
      approvalDeliveryStatus: params.delivery.status,
      approvalMessageId: params.delivery.messageId
    }
  );
}

export async function handleAgent1024PreToolUse(
  dependencies: Agent1024PreToolUseHandlerDependencies,
  payload: Agent1024PreToolUsePayload
): Promise<Agent1024HookResponse> {
  const params = normalize1024ToolArguments(payload.toolArguments);
  const decision: BeforeToolCallDecision = await guardBeforeToolCall(
    {
      planStore: dependencies.planStore,
      protectedMutationRegistry: dependencies.protectedMutationRegistry,
      resolveProtectedWriteRequest: (input) =>
        resolveProtectedWriteRequest({
          ...input,
          readSnapshotFromExecutionContext: (executionContext, storeId) =>
            dependencies.readAdapter.readCurrentConfig({
              storeId,
              executionContext
            })
        }),
      now: dependencies.now
    },
    {
      toolName: payload.toolName,
      params,
      approvedPlanId: getApprovedPlanIdFrom1024ToolArguments(
        payload.toolArguments
      ),
      actor: payload.userMis,
      storeId: getStoreIdFrom1024ToolArguments(payload.toolArguments)
    }
  );

  if (decision.action === "allow") {
    return {
      decision: "allow"
    };
  }

  if (
    decision.reason !== APPROVAL_REQUIRED_REASON ||
    !decision.protectedWriteRequest
  ) {
    return blockResponse(decision.reason ?? "Safe Mutation blocked the tool.");
  }

  const planResult = await ensureProtectedWritePlan(
    {
      planStore: dependencies.planStore,
      readAdapter: dependencies.readAdapter,
      now: dependencies.now,
      planTtlMs: dependencies.planTtlMs
    },
    {
      storeId: decision.protectedWriteRequest.storeId,
      writePayload: decision.protectedWriteRequest.payload,
      fieldSchema: decision.protectedWriteRequest.fieldSchema,
      fieldSchemaHash: decision.protectedWriteRequest.fieldSchemaHash,
      bindingSnapshot: decision.protectedWriteRequest.bindingSnapshot,
      beforeSnapshot: decision.protectedWriteRequest.beforeSnapshot,
      executionContext: decision.protectedWriteRequest.executionContext,
      requestedBy: build1024RequestedBy(payload),
      approvalChannel: "agent1024",
      approvalSenderId: payload.userMis,
      approvalAccountId: payload.accountId,
      approvalPrincipal: build1024ApprovalPrincipal(payload),
      sessionKey: payload.conversationId,
      channel: payload.paas
    }
  );

  if (planResult.blockedByOtherActivePlan) {
    return blockResponse(blockedByOtherPlanReason(planResult));
  }

  const card = dependencies.approvalCallbackUrl
    ? buildAgent1024ApprovalCard({
        payload,
        plan: planResult.plan,
        options: {
          callbackUrl: dependencies.approvalCallbackUrl,
          method: dependencies.approvalCardMethod ?? "POST"
        }
      })
    : undefined;
  const cardMessage = card ? serializeAgent1024Card(card) : undefined;
  const delivery = await dependencies.notifier.sendApproval({
    payload,
    plan: planResult.plan,
    text: cardMessage ?? renderMutationPlanForText(planResult.plan),
    ...(card ? { card, cardMessage } : {})
  });
  await markApprovalDelivery({
    planStore: dependencies.planStore,
    result: planResult,
    delivery
  });

  return delivery.ok
    ? blockResponse(approvalSentReason(planResult))
    : blockResponse(approvalDeliveryFailedReason(planResult.plan.planId));
}
