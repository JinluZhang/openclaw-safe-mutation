import type { ReadAdapter } from "../../core/adapters/read-adapter.js";
import type { VerifyAdapter } from "../../core/adapters/verify-adapter.js";
import type { WriteAdapter } from "../../core/adapters/write-adapter.js";
import { runMutateApproveCommand } from "../../core/commands/mutate-approve.js";
import { runMutateCancelCommand } from "../../core/commands/mutate-cancel.js";
import type { MutationPlan } from "../../core/intent-types.js";
import type { MutationPlanStore } from "../../core/plan-store.js";
import { parseTextPlanAction } from "../../core/text-plan-actions.js";
import { build1024ApprovalPrincipal } from "../payload-mapper.js";
import {
  allowResponse,
  type Agent1024HookResponse,
  type Agent1024UserMessageReceivedPayload
} from "../response-types.js";
import { buildSafeMutationContext } from "../safe-mutation-context.js";

export interface Agent1024ExecutionAdapters {
  readAdapter: ReadAdapter;
  writeAdapter: WriteAdapter;
  verifyAdapter: VerifyAdapter;
}

export interface Agent1024UserMessageReceivedHandlerDependencies
  extends Agent1024ExecutionAdapters {
  planStore: MutationPlanStore;
  now?: () => number;
  executionAdaptersFactory?: (plan: MutationPlan) => Agent1024ExecutionAdapters;
}

function contextResponse(text: string): Agent1024HookResponse {
  return allowResponse({
    safeMutationContext: text
  });
}

async function resolvePlanForAction(params: {
  planStore: MutationPlanStore;
  planId?: string;
  approvalPrincipal: string;
}): Promise<
  | { plan?: MutationPlan; context?: string }
  | { plan: MutationPlan; context?: undefined }
> {
  if (params.planId) {
    const plan = await params.planStore.get(params.planId);

    return plan
      ? { plan }
      : {
          context: `用户回复了确认/取消指令，但 Safe Mutation 找不到计划 ${params.planId}。请告知用户该变更计划不存在或已不可用。`
        };
  }

  const pendingPlans = await params.planStore.listPendingByApprovalPrincipal(
    params.approvalPrincipal
  );

  if (pendingPlans.length === 0) {
    return {
      context:
        "用户回复了确认/取消指令，但 Safe Mutation 没有找到当前会话的待确认变更。请告知用户没有待确认变更。"
    };
  }

  if (pendingPlans.length > 1) {
    return {
      context: `用户回复了确认/取消指令，但当前会话存在多个待确认变更：${pendingPlans
        .map((plan) => plan.planId)
        .join("、")}。请要求用户回复“确认 planId”或“取消 planId”来指定计划。`
    };
  }

  return {
    plan: pendingPlans[0]!
  };
}

export async function handleAgent1024UserMessageReceived(
  dependencies: Agent1024UserMessageReceivedHandlerDependencies,
  payload: Agent1024UserMessageReceivedPayload
): Promise<Agent1024HookResponse> {
  const action = parseTextPlanAction(payload.messageContent);

  if (!action) {
    return {
      decision: "allow"
    };
  }

  const approvalPrincipal = build1024ApprovalPrincipal(payload);
  const resolved = await resolvePlanForAction({
    planStore: dependencies.planStore,
    planId: action.planId,
    approvalPrincipal
  });

  if (resolved.context || !resolved.plan) {
    return contextResponse(resolved.context ?? "Safe Mutation 未找到待处理计划。");
  }

  if (action.kind === "cancel") {
    const plan = await runMutateCancelCommand(
      {
        planStore: dependencies.planStore,
        now: dependencies.now
      },
      {
        planId: resolved.plan.planId,
        cancelledBy: payload.userMis,
        approvalPrincipal
      }
    );

    return contextResponse(
      buildSafeMutationContext({
        action: "cancel",
        plan
      })
    );
  }

  const adapters = dependencies.executionAdaptersFactory
    ? dependencies.executionAdaptersFactory(resolved.plan)
    : dependencies;
  const plan = await runMutateApproveCommand(
    {
      planStore: dependencies.planStore,
      readAdapter: adapters.readAdapter,
      writeAdapter: adapters.writeAdapter,
      verifyAdapter: adapters.verifyAdapter,
      now: dependencies.now
    },
    {
      planId: resolved.plan.planId,
      approvedBy: payload.userMis,
      approvalPrincipal
    }
  );

  return contextResponse(
    buildSafeMutationContext({
      action: "approve",
      plan
    })
  );
}
