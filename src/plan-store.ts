import type { MutationPlan, MutationPlanStatus } from "./intent-types.js";

export interface MutationPlanStore {
  create(plan: MutationPlan): Promise<void>;
  get(planId: string): Promise<MutationPlan | undefined>;
  listActiveByStore(storeId: string): Promise<MutationPlan[]>;
  listPendingByApprovalPrincipal(
    approvalPrincipal: string
  ): Promise<MutationPlan[]>;
  update(plan: MutationPlan): Promise<void>;
  updateStatus(planId: string, status: MutationPlanStatus): Promise<void>;
  saveResult(planId: string, result: MutationPlan["result"]): Promise<void>;
}
