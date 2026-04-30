import {
  normalizeApprovalPrincipal,
  sameApprovalPrincipal
} from "../approval-principal.js";
import type { MutationPlan } from "../intent-types.js";
import type { MutationPlanStore } from "../plan-store.js";

export interface MutateCancelCommandInput {
  planId: string;
  cancelledBy: string;
  approvalPrincipal?: string;
}

export interface MutateCancelCommandDependencies {
  planStore: MutationPlanStore;
  now?: () => number;
}

export async function runMutateCancelCommand(
  dependencies: MutateCancelCommandDependencies,
  input: MutateCancelCommandInput
): Promise<MutationPlan> {
  const now = dependencies.now ?? Date.now;
  const plan = await dependencies.planStore.get(input.planId);
  const normalizedPlanApprovalPrincipal = normalizeApprovalPrincipal(
    plan?.approvalPrincipal
  );
  const normalizedInputApprovalPrincipal = normalizeApprovalPrincipal(
    input.approvalPrincipal
  );

  if (!plan) {
    throw new Error(`Plan ${input.planId} does not exist`);
  }

  if (
    plan.status === "succeeded" ||
    plan.status === "failed" ||
    plan.status === "conflict" ||
    plan.status === "cancelled" ||
    plan.status === "expired"
  ) {
    return plan;
  }

  if (plan.status === "executing") {
    throw new Error(
      `Plan ${input.planId} is already executing and cannot be cancelled`
    );
  }

  if (
    normalizedPlanApprovalPrincipal &&
    !sameApprovalPrincipal(
      normalizedPlanApprovalPrincipal,
      normalizedInputApprovalPrincipal
    )
  ) {
    throw new Error(
      "This mutation plan must be cancelled by the original requester identity"
    );
  }

  if (plan.expiresAtMs <= now()) {
    plan.status = "expired";
    plan.finishedAtMs ??= now();
    await dependencies.planStore.update(plan);
    return plan;
  }

  plan.status = "cancelled";
  if (normalizedPlanApprovalPrincipal) {
    plan.approvalPrincipal = normalizedPlanApprovalPrincipal;
  }
  plan.finishedAtMs = now();
  plan.result = {
    error: `Cancelled by ${input.cancelledBy}`
  };
  await dependencies.planStore.update(plan);
  return plan;
}
