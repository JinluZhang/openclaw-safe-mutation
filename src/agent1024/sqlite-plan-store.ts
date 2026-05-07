import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { sameApprovalPrincipal } from "../core/approval-principal.js";
import {
  ACTIVE_PLAN_STATUSES,
  TERMINAL_PLAN_STATUSES,
  type MutationPlan,
  type MutationPlanStatus
} from "../core/intent-types.js";
import type {
  MutationPlanStore,
  MutationPlanTransitionPatch
} from "../core/plan-store.js";

interface PlanRow {
  plan_json: string;
  version: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nullable(value: SQLInputValue | undefined): SQLInputValue {
  return value === undefined ? null : value;
}

function parsePlanRow(row: unknown): MutationPlan | undefined {
  if (typeof row !== "object" || row === null || !("plan_json" in row)) {
    return;
  }

  const planRow = row as PlanRow;
  const plan = JSON.parse(planRow.plan_json) as MutationPlan;

  return {
    ...plan,
    version: planRow.version
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

export class Agent1024SqliteMutationPlanStore implements MutationPlanStore {
  private readonly db: DatabaseSync;

  constructor(
    databasePath = ":memory:",
    private readonly tableName = "safe_mutation_plan"
  ) {
    this.db = new DatabaseSync(databasePath);
    this.initialize();
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      create table if not exists ${this.tableName} (
        plan_id text primary key,
        store_id text not null,
        status text not null,
        approval_principal text,
        requested_by text not null,
        before_hash text not null,
        field_schema_hash text not null,
        approval_delivery_status text,
        approval_message_id text,
        plan_json text not null,
        result_json text,
        created_at_ms integer not null,
        expires_at_ms integer not null,
        approved_at_ms integer,
        executed_at_ms integer,
        finished_at_ms integer,
        version integer not null
      );

      create index if not exists ${this.tableName}_active_store_idx
        on ${this.tableName} (store_id, status, created_at_ms);

      create index if not exists ${this.tableName}_approval_idx
        on ${this.tableName} (approval_principal, status, created_at_ms);
    `);
  }

  private planColumns(plan: MutationPlan): SQLInputValue[] {
    return [
      plan.planId,
      plan.storeId,
      plan.status,
      nullable(plan.approvalPrincipal),
      plan.requestedBy,
      plan.beforeHash,
      plan.fieldSchemaHash,
      nullable(plan.approvalDeliveryStatus),
      nullable(plan.approvalMessageId),
      JSON.stringify(plan),
      nullable(plan.result ? JSON.stringify(plan.result) : undefined),
      plan.createdAtMs,
      plan.expiresAtMs,
      nullable(plan.approvedAtMs),
      nullable(plan.executedAtMs),
      nullable(plan.finishedAtMs),
      plan.version ?? 1
    ];
  }

  private updateColumns(plan: MutationPlan): SQLInputValue[] {
    return [
      plan.storeId,
      plan.status,
      nullable(plan.approvalPrincipal),
      nullable(plan.approvalDeliveryStatus),
      nullable(plan.approvalMessageId),
      JSON.stringify(plan),
      nullable(plan.result ? JSON.stringify(plan.result) : undefined),
      plan.createdAtMs,
      plan.expiresAtMs,
      nullable(plan.approvedAtMs),
      nullable(plan.executedAtMs),
      nullable(plan.finishedAtMs),
      plan.version ?? 1
    ];
  }

  async create(plan: MutationPlan): Promise<void> {
    const nextPlan: MutationPlan = {
      ...clone(plan),
      version: 1
    };
    const result = this.db
      .prepare(
        `insert into ${this.tableName}
          (plan_id, store_id, status, approval_principal, requested_by,
           before_hash, field_schema_hash, approval_delivery_status,
           approval_message_id, plan_json, result_json, created_at_ms,
           expires_at_ms, approved_at_ms, executed_at_ms, finished_at_ms,
           version)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(...this.planColumns(nextPlan));

    if (result.changes === 0) {
      throw new Error(`Plan ${plan.planId} was not created`);
    }
  }

  async get(planId: string): Promise<MutationPlan | undefined> {
    const row = this.db
      .prepare(
        `select plan_json, version from ${this.tableName} where plan_id = ? limit 1`
      )
      .get(planId);
    const plan = parsePlanRow(row);
    return plan ? clone(plan) : undefined;
  }

  async listActiveByStore(storeId: string): Promise<MutationPlan[]> {
    const rows = this.db
      .prepare(
        `select plan_json, version from ${this.tableName}
         where store_id = ? and status in (?, ?, ?)
         order by created_at_ms asc, plan_id asc`
      )
      .all(storeId, ...ACTIVE_PLAN_STATUSES);

    return rows.flatMap((row) => {
      const plan = parsePlanRow(row);
      return plan ? [clone(plan)] : [];
    });
  }

  async listPendingByApprovalPrincipal(
    approvalPrincipal: string
  ): Promise<MutationPlan[]> {
    const rows = this.db
      .prepare(
        `select plan_json, version from ${this.tableName}
         where approval_principal = ? and status = ?
         order by created_at_ms asc, plan_id asc`
      )
      .all(approvalPrincipal, "pending_ack");
    const plans = rows.flatMap((row) => {
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
    const result = this.db
      .prepare(
        `update ${this.tableName}
         set store_id = ?, status = ?, approval_principal = ?,
             approval_delivery_status = ?, approval_message_id = ?,
             plan_json = ?, result_json = ?, created_at_ms = ?,
             expires_at_ms = ?, approved_at_ms = ?, executed_at_ms = ?,
             finished_at_ms = ?, version = ?
         where plan_id = ? and version = ?`
      )
      .run(...this.updateColumns(nextPlan), plan.planId, currentPlan.version ?? 1);

    if (result.changes === 0) {
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
    const result = this.db
      .prepare(
        `update ${this.tableName}
         set store_id = ?, status = ?, approval_principal = ?,
             approval_delivery_status = ?, approval_message_id = ?,
             plan_json = ?, result_json = ?, created_at_ms = ?,
             expires_at_ms = ?, approved_at_ms = ?, executed_at_ms = ?,
             finished_at_ms = ?, version = ?
         where plan_id = ? and status = ? and version = ?`
      )
      .run(
        ...this.updateColumns(nextPlan),
        planId,
        fromStatus,
        currentPlan.version ?? 1
      );

    return result.changes === 0 ? undefined : clone(nextPlan);
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
