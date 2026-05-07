import type { MutationPlan, MutationPlanStatus } from "./intent-types.js";

export type MutationPlanTransitionPatch = Partial<
  Omit<MutationPlan, "planId" | "status">
>;

export interface MutationPlanStore {
  create(plan: MutationPlan): Promise<void>;
  get(planId: string): Promise<MutationPlan | undefined>;
  listActiveByStore(storeId: string): Promise<MutationPlan[]>;
  listPendingByApprovalPrincipal(
    approvalPrincipal: string
  ): Promise<MutationPlan[]>;
  update(plan: MutationPlan): Promise<void>;
  updateStatus(planId: string, status: MutationPlanStatus): Promise<void>;
  tryTransition(
    planId: string,
    fromStatus: MutationPlanStatus,
    toStatus: MutationPlanStatus,
    patch?: MutationPlanTransitionPatch
  ): Promise<MutationPlan | undefined>;
  saveResult(planId: string, result: MutationPlan["result"]): Promise<void>;
}
