import {
  ACTIVE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  type MutationPlan,
  type MutationPlanStatus
} from "../../src/intent-types.js";
import { sameApprovalPrincipal } from "../../src/approval-principal.js";
import type { MutationPlanStore } from "../../src/plan-store.js";

function clonePlan<T>(value: T): T {
  return structuredClone(value);
}

function assertValidStatusTransition(
  currentStatus: MutationPlanStatus,
  nextStatus: MutationPlanStatus
): void {
  if (currentStatus === nextStatus) {
    return;
  }

  if (TERMINAL_PLAN_STATUSES.includes(currentStatus)) {
    throw new Error(
      `Cannot transition terminal plan from ${currentStatus} to ${nextStatus}`
    );
  }
}

export class InMemoryMutationPlanStore implements MutationPlanStore {
  private readonly plans = new Map<string, MutationPlan>();

  async create(plan: MutationPlan): Promise<void> {
    if (this.plans.has(plan.planId)) {
      throw new Error(`Plan ${plan.planId} already exists`);
    }

    this.plans.set(plan.planId, clonePlan(plan));
  }

  async get(planId: string): Promise<MutationPlan | undefined> {
    const plan = this.plans.get(planId);
    return plan ? clonePlan(plan) : undefined;
  }

  async listActiveByStore(storeId: string): Promise<MutationPlan[]> {
    return [...this.plans.values()]
      .filter(
        (plan) =>
          plan.storeId === storeId && ACTIVE_PLAN_STATUSES.includes(plan.status)
      )
      .map((plan) => clonePlan(plan));
  }

  async listPendingByApprovalPrincipal(
    approvalPrincipal: string
  ): Promise<MutationPlan[]> {
    return [...this.plans.values()]
      .filter(
        (plan) =>
          sameApprovalPrincipal(plan.approvalPrincipal, approvalPrincipal) &&
          plan.status === "pending_ack"
      )
      .map((plan) => clonePlan(plan));
  }

  async update(plan: MutationPlan): Promise<void> {
    const currentPlan = this.plans.get(plan.planId);

    if (!currentPlan) {
      throw new Error(`Plan ${plan.planId} does not exist`);
    }

    assertValidStatusTransition(currentPlan.status, plan.status);
    this.plans.set(plan.planId, clonePlan(plan));
  }

  async updateStatus(
    planId: string,
    status: MutationPlanStatus
  ): Promise<void> {
    const plan = await this.get(planId);

    if (!plan) {
      throw new Error(`Plan ${planId} does not exist`);
    }

    plan.status = status;
    await this.update(plan);
  }

  async saveResult(
    planId: string,
    result: MutationPlan["result"]
  ): Promise<void> {
    const plan = await this.get(planId);

    if (!plan) {
      throw new Error(`Plan ${planId} does not exist`);
    }

    plan.result = result ? clonePlan(result) : result;
    await this.update(plan);
  }
}
