import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ACTIVE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  type MutationPlan,
  type MutationPlanStatus
} from "../core/intent-types.js";
import { sameApprovalPrincipal } from "../core/approval-principal.js";
import type { MutationPlanStore } from "../core/plan-store.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, {
    recursive: true
  });
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
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

export class FileMutationPlanStore implements MutationPlanStore {
  constructor(private readonly rootDir: string) {}

  private get plansDir(): string {
    return path.join(this.rootDir, "plans");
  }

  private getPlanPath(planId: string): string {
    return path.join(this.plansDir, `${planId}.json`);
  }

  private async writePlan(plan: MutationPlan): Promise<void> {
    await ensureDir(this.plansDir);
    await writeFile(
      this.getPlanPath(plan.planId),
      `${JSON.stringify(plan, null, 2)}\n`,
      "utf8"
    );
  }

  async create(plan: MutationPlan): Promise<void> {
    const existing = await this.get(plan.planId);

    if (existing) {
      throw new Error(`Plan ${plan.planId} already exists`);
    }

    await this.writePlan(clone(plan));
  }

  async get(planId: string): Promise<MutationPlan | undefined> {
    const plan = await readJsonFile<MutationPlan>(this.getPlanPath(planId));
    return plan ? clone(plan) : undefined;
  }

  private async listAllPlans(): Promise<MutationPlan[]> {
    await ensureDir(this.plansDir);
    const entries = await readdir(this.plansDir, {
      withFileTypes: true
    });
    const plans = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) =>
          readJsonFile<MutationPlan>(path.join(this.plansDir, entry.name))
        )
    );

    return plans.filter((plan): plan is MutationPlan => Boolean(plan)).map(clone);
  }

  async listActiveByStore(storeId: string): Promise<MutationPlan[]> {
    const plans = await this.listAllPlans();
    return plans.filter(
      (plan) =>
        plan.storeId === storeId && ACTIVE_PLAN_STATUSES.includes(plan.status)
    );
  }

  async listPendingByApprovalPrincipal(
    approvalPrincipal: string
  ): Promise<MutationPlan[]> {
    const plans = await this.listAllPlans();
    return plans.filter(
      (plan) =>
        sameApprovalPrincipal(plan.approvalPrincipal, approvalPrincipal) &&
        plan.status === "pending_ack"
    );
  }

  async update(plan: MutationPlan): Promise<void> {
    const currentPlan = await this.get(plan.planId);

    if (!currentPlan) {
      throw new Error(`Plan ${plan.planId} does not exist`);
    }

    assertValidStatusTransition(currentPlan.status, plan.status);
    await this.writePlan(clone(plan));
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

    plan.result = result ? clone(result) : result;
    await this.update(plan);
  }
}
