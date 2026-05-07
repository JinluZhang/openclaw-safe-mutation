import {
  ACTIVE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  type MutationPlan,
  type MutationPlanStatus
} from "../core/intent-types.js";
import { sameApprovalPrincipal } from "../core/approval-principal.js";
import type {
  MutationPlanStore,
  MutationPlanTransitionPatch
} from "../core/plan-store.js";

export interface Agent1024MySqlQueryResult {
  rows: unknown[];
  affectedRows?: number;
}

export interface Agent1024MySqlDriver {
  query(sql: string, params: readonly unknown[]): Promise<Agent1024MySqlQueryResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function parsePlanRow(row: unknown): MutationPlan | undefined {
  if (!isRecord(row)) {
    return;
  }

  const rawPlan = row.plan_json;

  if (typeof rawPlan !== "string") {
    return;
  }

  const plan = JSON.parse(rawPlan) as MutationPlan;
  const version = typeof row.version === "number" ? row.version : plan.version;

  return {
    ...plan,
    ...(version ? { version } : {})
  };
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

export class Agent1024MySqlMutationPlanStore implements MutationPlanStore {
  constructor(
    private readonly driver: Agent1024MySqlDriver,
    private readonly tableName = "safe_mutation_plan"
  ) {}

  async create(plan: MutationPlan): Promise<void> {
    const nextPlan: MutationPlan = {
      ...clone(plan),
      version: plan.version ?? 1
    };
    const result = await this.driver.query(
      `insert into ${this.tableName}
        (plan_id, store_id, status, approval_principal, requested_by, before_hash,
         field_schema_hash, approval_delivery_status, approval_message_id,
         plan_json, result_json, created_at, expires_at, approved_at,
         executed_at, finished_at, version)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, from_unixtime(? / 1000),
         from_unixtime(? / 1000), ?, ?, ?, ?)`,
      [
        nextPlan.planId,
        nextPlan.storeId,
        nextPlan.status,
        nextPlan.approvalPrincipal,
        nextPlan.requestedBy,
        nextPlan.beforeHash,
        nextPlan.fieldSchemaHash,
        nextPlan.approvalDeliveryStatus,
        nextPlan.approvalMessageId,
        JSON.stringify(nextPlan),
        nextPlan.result ? JSON.stringify(nextPlan.result) : undefined,
        nextPlan.createdAtMs,
        nextPlan.expiresAtMs,
        nextPlan.approvedAtMs
          ? new Date(nextPlan.approvedAtMs)
          : undefined,
        nextPlan.executedAtMs
          ? new Date(nextPlan.executedAtMs)
          : undefined,
        nextPlan.finishedAtMs
          ? new Date(nextPlan.finishedAtMs)
          : undefined,
        nextPlan.version
      ]
    );

    if (result.affectedRows === 0) {
      throw new Error(`Plan ${plan.planId} was not created`);
    }
  }

  async get(planId: string): Promise<MutationPlan | undefined> {
    const result = await this.driver.query(
      `select plan_json, version from ${this.tableName} where plan_id = ? limit 1`,
      [planId]
    );

    const plan = parsePlanRow(result.rows[0]);
    return plan ? clone(plan) : undefined;
  }

  async listActiveByStore(storeId: string): Promise<MutationPlan[]> {
    const result = await this.driver.query(
      `select plan_json, version from ${this.tableName}
       where store_id = ? and status in (?, ?, ?)
       order by created_at asc`,
      [storeId, ...ACTIVE_PLAN_STATUSES]
    );

    return result.rows.flatMap((row) => {
      const plan = parsePlanRow(row);
      return plan ? [clone(plan)] : [];
    });
  }

  async listPendingByApprovalPrincipal(
    approvalPrincipal: string
  ): Promise<MutationPlan[]> {
    const result = await this.driver.query(
      `select plan_json, version from ${this.tableName}
       where approval_principal = ? and status = ?
       order by created_at asc`,
      [approvalPrincipal, "pending_ack"]
    );
    const plans = result.rows.flatMap((row) => {
      const plan = parsePlanRow(row);
      return plan ? [clone(plan)] : [];
    });

    return plans.filter((plan) =>
      sameApprovalPrincipal(plan.approvalPrincipal, approvalPrincipal)
    );
  }

  async update(plan: MutationPlan): Promise<void> {
    const currentPlan = await this.get(plan.planId);

    if (!currentPlan) {
      throw new Error(`Plan ${plan.planId} does not exist`);
    }

    assertValidStatusTransition(currentPlan.status, plan.status);

    const nextPlan: MutationPlan = {
      ...clone(plan),
      version: (currentPlan.version ?? 1) + 1
    };
    const result = await this.driver.query(
      `update ${this.tableName}
       set status = ?, approval_principal = ?, approval_delivery_status = ?,
           approval_message_id = ?, result_json = ?, plan_json = ?,
           approved_at = ?, executed_at = ?, finished_at = ?, version = ?
       where plan_id = ? and version = ?`,
      [
        nextPlan.status,
        nextPlan.approvalPrincipal,
        nextPlan.approvalDeliveryStatus,
        nextPlan.approvalMessageId,
        nextPlan.result ? JSON.stringify(nextPlan.result) : undefined,
        JSON.stringify(nextPlan),
        nextPlan.approvedAtMs ? new Date(nextPlan.approvedAtMs) : undefined,
        nextPlan.executedAtMs ? new Date(nextPlan.executedAtMs) : undefined,
        nextPlan.finishedAtMs ? new Date(nextPlan.finishedAtMs) : undefined,
        nextPlan.version,
        nextPlan.planId,
        currentPlan.version ?? 1
      ]
    );

    if (result.affectedRows === 0) {
      throw new Error(`Plan ${plan.planId} changed concurrently`);
    }
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

  async tryTransition(
    planId: string,
    fromStatus: MutationPlanStatus,
    toStatus: MutationPlanStatus,
    patch: MutationPlanTransitionPatch = {}
  ): Promise<MutationPlan | undefined> {
    const currentPlan = await this.get(planId);

    if (!currentPlan || currentPlan.status !== fromStatus) {
      return undefined;
    }

    assertValidStatusTransition(currentPlan.status, toStatus);

    const nextPlan: MutationPlan = {
      ...currentPlan,
      ...clone(patch),
      planId: currentPlan.planId,
      status: toStatus,
      version: (currentPlan.version ?? 1) + 1
    };
    const result = await this.driver.query(
      `update ${this.tableName}
       set status = ?, approval_principal = ?, approval_delivery_status = ?,
           approval_message_id = ?, result_json = ?, plan_json = ?,
           approved_at = ?, executed_at = ?, finished_at = ?, version = ?
       where plan_id = ? and status = ? and version = ?`,
      [
        nextPlan.status,
        nextPlan.approvalPrincipal,
        nextPlan.approvalDeliveryStatus,
        nextPlan.approvalMessageId,
        nextPlan.result ? JSON.stringify(nextPlan.result) : undefined,
        JSON.stringify(nextPlan),
        nextPlan.approvedAtMs ? new Date(nextPlan.approvedAtMs) : undefined,
        nextPlan.executedAtMs ? new Date(nextPlan.executedAtMs) : undefined,
        nextPlan.finishedAtMs ? new Date(nextPlan.finishedAtMs) : undefined,
        nextPlan.version,
        planId,
        fromStatus,
        currentPlan.version ?? 1
      ]
    );

    return result.affectedRows === 0 ? undefined : nextPlan;
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
