import { executeMutationPlan, type ExecuteMutationPlanDependencies } from "../executor.js";
import {
  normalizeApprovalPrincipal,
  sameApprovalPrincipal
} from "../approval-principal.js";
import type { MutationPlan } from "../intent-types.js";

export interface MutateApproveCommandInput {
  planId: string;
  approvedBy: string;
  approvalPrincipal?: string;
}

export interface MutateApproveCommandDependencies
  extends ExecuteMutationPlanDependencies {
  now?: () => number;
}

export async function runMutateApproveCommand(
  dependencies: MutateApproveCommandDependencies,
  input: MutateApproveCommandInput
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
    return plan;
  }

  if (
    normalizedPlanApprovalPrincipal &&
    !sameApprovalPrincipal(
      normalizedPlanApprovalPrincipal,
      normalizedInputApprovalPrincipal
    )
  ) {
    throw new Error(
      "This mutation plan must be approved by the original requester identity"
    );
  }

  if (plan.expiresAtMs <= now()) {
    plan.status = "expired";
    plan.finishedAtMs ??= now();
    await dependencies.planStore.update(plan);
    return plan;
  }

  if (plan.status === "pending_ack") {
    if (normalizedPlanApprovalPrincipal) {
      plan.approvalPrincipal = normalizedPlanApprovalPrincipal;
    }

    plan.status = "approved";
    plan.approvedBy = input.approvedBy;
    plan.approvedPrincipal = normalizedInputApprovalPrincipal;
    plan.approvedAtMs = now();
    await dependencies.planStore.update(plan);
  } else if (plan.status === "approved") {
    const normalizedApprovedPrincipal = normalizeApprovalPrincipal(
      plan.approvedPrincipal
    );

    if (
      normalizedApprovedPrincipal &&
      normalizedInputApprovalPrincipal &&
      !sameApprovalPrincipal(
        normalizedApprovedPrincipal,
        normalizedInputApprovalPrincipal
      )
    ) {
      throw new Error(
        `Plan ${input.planId} was already approved by ${plan.approvedBy}`
      );
    }

    if (
      !normalizedApprovedPrincipal &&
      plan.approvedBy &&
      plan.approvedBy !== input.approvedBy
    ) {
      throw new Error(
        `Plan ${input.planId} was already approved by ${plan.approvedBy}`
      );
    }

    if (normalizedPlanApprovalPrincipal) {
      plan.approvalPrincipal = normalizedPlanApprovalPrincipal;
    }

    if (normalizedApprovedPrincipal) {
      plan.approvedPrincipal = normalizedApprovedPrincipal;
    }
  } else {
    throw new Error(`Plan ${input.planId} cannot be approved from ${plan.status}`);
  }

  return executeMutationPlan(dependencies, input.planId);
}
