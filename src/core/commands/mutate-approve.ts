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
    const expiredPlan = await dependencies.planStore.tryTransition(
      plan.planId,
      plan.status,
      "expired",
      {
        finishedAtMs: plan.finishedAtMs ?? now()
      }
    );
    return expiredPlan ?? (await dependencies.planStore.get(plan.planId)) ?? plan;
  }

  if (plan.approvalDeliveryStatus === "failed") {
    throw new Error(
      `Plan ${input.planId} approval request was not delivered and cannot be approved`
    );
  }

  if (plan.status === "pending_ack") {
    const approvedPlan = await dependencies.planStore.tryTransition(
      plan.planId,
      "pending_ack",
      "approved",
      {
        approvalPrincipal:
          normalizedPlanApprovalPrincipal ?? plan.approvalPrincipal,
        approvedBy: input.approvedBy,
        approvedPrincipal: normalizedInputApprovalPrincipal,
        approvedAtMs: now()
      }
    );

    if (!approvedPlan) {
      const currentPlan = await dependencies.planStore.get(plan.planId);

      if (currentPlan) {
        return currentPlan.status === "approved"
          ? executeMutationPlan(dependencies, input.planId)
          : currentPlan;
      }

      return plan;
    }
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
      await dependencies.planStore.tryTransition(
        plan.planId,
        "approved",
        "approved",
        {
          approvalPrincipal: normalizedPlanApprovalPrincipal
        }
      );
    }

    if (normalizedApprovedPrincipal) {
      await dependencies.planStore.tryTransition(
        plan.planId,
        "approved",
        "approved",
        {
          approvedPrincipal: normalizedApprovedPrincipal
        }
      );
    }
  } else {
    throw new Error(`Plan ${input.planId} cannot be approved from ${plan.status}`);
  }

  return executeMutationPlan(dependencies, input.planId);
}
