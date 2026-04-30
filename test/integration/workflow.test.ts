import { describe, expect, it } from "vitest";

import type { ReadAdapter } from "../../src/adapters/read-adapter.js";
import type { VerifyAdapter } from "../../src/adapters/verify-adapter.js";
import type { WriteAdapter } from "../../src/adapters/write-adapter.js";
import { buildApprovalPrincipal } from "../../src/approval-principal.js";
import { runMutateApproveCommand } from "../../src/commands/mutate-approve.js";
import { runMutateCancelCommand } from "../../src/commands/mutate-cancel.js";
import { ensureProtectedWritePlan } from "../../src/protected-write-plan.js";
import type { ProtectedFieldDefinition } from "../../src/field-schema.js";
import { InMemoryMutationPlanStore } from "../helpers/in-memory-plan-store.js";

const promotionFieldSchema: ProtectedFieldDefinition[] = [
  {
    fieldId: "full_reduction_tiers",
    label: "满减档位",
    valueType: "json",
    readPath: "promotion.full_reduction_tiers",
    operations: ["replace_item"]
  }
];

const scalarFieldSchema: ProtectedFieldDefinition[] = [
  ...promotionFieldSchema,
  {
    fieldId: "activity_name",
    label: "活动名称",
    valueType: "string",
    readPath: "activity_name"
  },
  {
    fieldId: "tier_1_threshold",
    label: "第一档门槛",
    valueType: "decimal",
    readPath: "tier_1_threshold"
  }
];

const beforeSnapshot = {
  promotion: {
    full_reduction_tiers: [
      { threshold: 25, reduction: 15 },
      { threshold: 40, reduction: 20 }
    ]
  },
  untouched: {
    enabled: true
  }
} satisfies Record<string, unknown>;

const expectedAfterSnapshot = {
  promotion: {
    full_reduction_tiers: [
      { threshold: 20, reduction: 15 },
      { threshold: 40, reduction: 20 }
    ]
  },
  untouched: {
    enabled: true
  }
} satisfies Record<string, unknown>;

const scalarBeforeSnapshot = {
  activity_name: "weekday_lunch_full_reduction",
  activity_status: "enabled",
  start_time: "2026-04-21T10:00",
  end_time: "2026-05-21T22:00",
  weekday_mask: "1111100",
  min_order_price: 18,
  delivery_fee_discount: 2,
  tier_1_threshold: 25,
  tier_1_discount: 15,
  tier_2_threshold: 40,
  tier_2_discount: 20,
  tier_3_threshold: 60,
  tier_3_discount: 30,
  stack_with_coupon: true,
  stack_with_membership: false,
  new_customer_only: false,
  vip_only: false,
  budget_limit: 1200,
  remark: "seeded_for_safe_mutation_tests",
  promotion: {
    full_reduction_tiers: [
      { threshold: 25, reduction: 15 },
      { threshold: 40, reduction: 20 },
      { threshold: 60, reduction: 30 }
    ]
  }
} satisfies Record<string, unknown>;

const scalarAfterSnapshot = {
  ...scalarBeforeSnapshot,
  activity_name: "weekday_lunch_flash_sale"
} satisfies Record<string, unknown>;

const tierScalarAfterSnapshot = {
  ...scalarBeforeSnapshot,
  tier_1_threshold: 20,
  promotion: {
    full_reduction_tiers: [
      { threshold: 20, reduction: 15 },
      { threshold: 40, reduction: 20 },
      { threshold: 60, reduction: 30 }
    ]
  }
} satisfies Record<string, unknown>;

class FakeReadAdapter implements ReadAdapter {
  constructor(public snapshot: Record<string, unknown>) {}

  async readCurrentConfig(_params: {
    storeId: string;
  }): Promise<Record<string, unknown>> {
    return structuredClone(this.snapshot);
  }
}

class FakeVerifyAdapter implements VerifyAdapter {
  constructor(public snapshot: Record<string, unknown>) {}

  async verifyCurrentConfig(_params: {
    storeId: string;
  }): Promise<Record<string, unknown>> {
    return structuredClone(this.snapshot);
  }
}

class FakeWriteAdapter implements WriteAdapter {
  readonly calls: Array<{
    storeId: string;
    payload: Record<string, unknown>;
  }> = [];

  constructor(
    private readonly onWrite?: (params: {
      storeId: string;
      payload: Record<string, unknown>;
      executionContext?: unknown;
    }) => void
  ) {}

  async writeConfig(params: {
    storeId: string;
    payload: Record<string, unknown>;
    executionContext?: unknown;
  }) {
    this.calls.push(structuredClone(params));
    this.onWrite?.(params);

    return {
      exitCode: 0,
      stdout: "ok",
      stderr: ""
    };
  }
}

async function createPendingPlan(params: {
  planStore: InMemoryMutationPlanStore;
  readAdapter: ReadAdapter;
  writePayload: Record<string, unknown>;
  planId: string;
  now: number;
  sessionKey?: string;
  approvalPrincipal?: string;
  fieldSchema?: ProtectedFieldDefinition[];
}) {
  const approvalPrincipal =
    params.approvalPrincipal ??
    buildApprovalPrincipal({
      channel: "feishu",
      accountId: "default",
      senderId: "alice"
    });
  const result = await ensureProtectedWritePlan(
    {
      planStore: params.planStore,
      readAdapter: params.readAdapter,
      now: () => params.now,
      planIdFactory: () => params.planId
    },
    {
      storeId: "store-1",
      writePayload: params.writePayload,
      fieldSchema: params.fieldSchema ?? promotionFieldSchema,
      requestedBy: "alice",
      approvalChannel: "feishu",
      approvalSenderId: "alice",
      approvalAccountId: "default",
      approvalPrincipal,
      sessionKey: params.sessionKey ?? "session-1",
      channel: "feishu"
    }
  );

  expect(result.created).toBe(true);
  expect(result.plan.planId).toBe(params.planId);

  return result.plan;
}

describe("integration workflow", () => {
  it("runs the success flow with fake read/write/verify adapters", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(beforeSnapshot);
    const writeAdapter = new FakeWriteAdapter(({ payload }) => {
      verifyAdapter.snapshot = structuredClone(payload);
    });

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-success",
      now: 1
    });

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 2
      },
      {
        planId: "plan-success",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("succeeded");
    expect(writeAdapter.calls).toEqual([
      {
        storeId: "store-1",
        payload: expectedAfterSnapshot
      }
    ]);
    expect(finalPlan.result).toEqual(
      expect.objectContaining({
        writeSucceeded: true,
        verifySucceeded: true,
        verifySnapshot: expectedAfterSnapshot
      })
    );
  });

  it("accepts approval when an old persisted principal used a channel-prefixed sender id", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(beforeSnapshot);
    const writeAdapter = new FakeWriteAdapter(({ payload }) => {
      verifyAdapter.snapshot = structuredClone(payload);
    });

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-normalized-principal",
      now: 1,
      approvalPrincipal: "feishu:default:feishu:alice"
    });

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 2
      },
      {
        planId: "plan-normalized-principal",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("succeeded");
    expect(finalPlan.approvalPrincipal).toBe("feishu:default:alice");
    expect(finalPlan.approvedPrincipal).toBe("feishu:default:alice");
  });

  it("marks the plan as conflict when beforeHash no longer matches", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(beforeSnapshot);
    const writeAdapter = new FakeWriteAdapter();

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-conflict",
      now: 10
    });

    readAdapter.snapshot = {
      promotion: {
        full_reduction_tiers: [
          { threshold: 30, reduction: 15 },
          { threshold: 40, reduction: 20 }
        ]
      },
      untouched: {
        enabled: true
      }
    };

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 20
      },
      {
        planId: "plan-conflict",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("conflict");
    expect(finalPlan.result?.error).toContain("changed after approval");
    expect(writeAdapter.calls).toHaveLength(0);
  });

  it("fails closed when verify does not match the expected after snapshot", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(beforeSnapshot);
    const writeAdapter = new FakeWriteAdapter();

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-verify-failure",
      now: 100
    });

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 101
      },
      {
        planId: "plan-verify-failure",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("failed");
    expect(writeAdapter.calls).toHaveLength(1);
    expect(finalPlan.result).toEqual(
      expect.objectContaining({
        writeSucceeded: true,
        verifySucceeded: false,
        error: "Post-write verification failed"
      })
    );
  });

  it("remains idempotent when approve is triggered twice", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(beforeSnapshot);
    const writeAdapter = new FakeWriteAdapter(({ payload }) => {
      verifyAdapter.snapshot = structuredClone(payload);
    });

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-idempotent",
      now: 200
    });

    const firstResult = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 201
      },
      {
        planId: "plan-idempotent",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );
    const secondResult = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 202
      },
      {
        planId: "plan-idempotent",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(firstResult.status).toBe("succeeded");
    expect(secondResult.status).toBe("succeeded");
    expect(writeAdapter.calls).toHaveLength(1);
  });

  it("supports generic scalar field updates from the field schema", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(scalarBeforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(scalarBeforeSnapshot);
    const writeAdapter = new FakeWriteAdapter(({ payload }) => {
      verifyAdapter.snapshot = structuredClone(payload);
    });

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: scalarAfterSnapshot,
      fieldSchema: scalarFieldSchema,
      planId: "plan-activity-name",
      now: 300
    });

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 301
      },
      {
        planId: "plan-activity-name",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("succeeded");
    expect(finalPlan.mutationKind).toBe("protected_write.activity_name");
    expect(writeAdapter.calls).toEqual([
      {
        storeId: "store-1",
        payload: scalarAfterSnapshot
      }
    ]);
  });

  it("treats tier scalar fields as ordinary schema fields", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(scalarBeforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(scalarBeforeSnapshot);
    const writeAdapter = new FakeWriteAdapter(({ payload }) => {
      verifyAdapter.snapshot = structuredClone(payload);
    });

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: tierScalarAfterSnapshot,
      fieldSchema: scalarFieldSchema,
      planId: "plan-tier-threshold",
      now: 400
    });

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 401
      },
      {
        planId: "plan-tier-threshold",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("succeeded");
    expect(finalPlan.mutationKind).toBe(
      "protected_write.full_reduction_tiers+tier_1_threshold"
    );
    expect(writeAdapter.calls).toEqual([
      {
        storeId: "store-1",
        payload: tierScalarAfterSnapshot
      }
    ]);
  });

  it("allows approval from a different session when approval principal matches", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);
    const verifyAdapter = new FakeVerifyAdapter(beforeSnapshot);
    const writeAdapter = new FakeWriteAdapter(({ payload }) => {
      verifyAdapter.snapshot = structuredClone(payload);
    });

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-cross-session-approve",
      now: 450,
      sessionKey: "session-1"
    });

    const finalPlan = await runMutateApproveCommand(
      {
        planStore,
        readAdapter,
        writeAdapter,
        verifyAdapter,
        now: () => 451
      },
      {
        planId: "plan-cross-session-approve",
        approvedBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(finalPlan.status).toBe("succeeded");
    expect(writeAdapter.calls).toHaveLength(1);
  });

  it("rejects approval from a different principal", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-approval-principal",
      now: 475
    });

    await expect(
      runMutateApproveCommand(
        {
          planStore,
          readAdapter,
          writeAdapter: new FakeWriteAdapter(),
          verifyAdapter: new FakeVerifyAdapter(beforeSnapshot)
        },
        {
          planId: "plan-approval-principal",
          approvedBy: "bob",
          approvalPrincipal: buildApprovalPrincipal({
            channel: "feishu",
            accountId: "default",
            senderId: "bob"
          })
        }
      )
    ).rejects.toThrow("original requester identity");
  });

  it("allows cancellation from a different session when approval principal matches", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-cancel",
      now: 500,
      sessionKey: "session-1"
    });

    const cancelledPlan = await runMutateCancelCommand(
      {
        planStore,
        now: () => 501
      },
      {
        planId: "plan-cancel",
        cancelledBy: "alice",
        approvalPrincipal: buildApprovalPrincipal({
          channel: "feishu",
          accountId: "default",
          senderId: "alice"
        })
      }
    );

    expect(cancelledPlan.status).toBe("cancelled");
  });

  it("rejects cancellation from a different principal", async () => {
    const planStore = new InMemoryMutationPlanStore();
    const readAdapter = new FakeReadAdapter(beforeSnapshot);

    await createPendingPlan({
      planStore,
      readAdapter,
      writePayload: expectedAfterSnapshot,
      planId: "plan-cancel-principal",
      now: 550
    });

    await expect(
      runMutateCancelCommand(
        {
          planStore
        },
        {
          planId: "plan-cancel-principal",
          cancelledBy: "bob",
          approvalPrincipal: buildApprovalPrincipal({
            channel: "feishu",
            accountId: "default",
            senderId: "bob"
          })
        }
      )
    ).rejects.toThrow("original requester identity");
  });
});
